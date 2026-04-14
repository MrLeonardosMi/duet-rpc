# Middleware

Middleware runs on every incoming request before it reaches your handler. The pattern is Koa-style: each function receives a context object and a `next` function. Call `next()` to pass control to the next middleware (and eventually the handler). Return without calling `next()` to short-circuit the chain.

```ts
import type { MiddlewareFn } from 'duet-rpc';

const mw: MiddlewareFn = async (ctx, next) => {
  // before handler
  const result = await next();
  // after handler
  return result;
};

peer.use(mw);
```

The `ctx` object has four fields:

| Field    | Type      | Description                              |
|----------|-----------|------------------------------------------|
| `method` | `string`  | Name of the called procedure             |
| `params` | `unknown` | Input params (after schema validation)   |
| `side`   | `string`  | The local side name from the contract    |
| `peer`   | `string`  | The remote side name                     |

---

## Basic middleware

A logger that prints every incoming call and its result:

```ts
const logger: MiddlewareFn = async (ctx, next) => {
  console.log(`[rpc] ${ctx.method}`, ctx.params);
  const result = await next();
  console.log(`[rpc] ${ctx.method} ->`, result);
  return result;
};

peer.use(logger);
```

---

## Auth middleware

Check a token before allowing the call through. Throw a `PeerError` to send a structured error back to the caller.

```ts
import { PeerError } from 'duet-rpc';

const auth: MiddlewareFn = async (ctx, next) => {
  const token = (ctx.params as any)?.token;
  if (token !== process.env.RPC_SECRET) {
    throw new PeerError('UNAUTHORIZED', 'Invalid or missing token');
  }
  return next();
};

peer.use(auth);
```

The `PeerError` is serialized over the wire. The caller receives it as a `PeerError` with `code: 'UNAUTHORIZED'`.

---

## Rate limiting

Limit calls per method using a simple in-memory counter. This resets every `windowMs` milliseconds.

```ts
const counts = new Map<string, { count: number; reset: number }>();
const LIMIT = 10;
const WINDOW_MS = 60_000;

const rateLimiter: MiddlewareFn = async (ctx, next) => {
  const now = Date.now();
  const entry = counts.get(ctx.method);

  if (!entry || now > entry.reset) {
    counts.set(ctx.method, { count: 1, reset: now + WINDOW_MS });
  } else if (entry.count >= LIMIT) {
    throw new PeerError('RATE_LIMITED', `Too many calls to "${ctx.method}"`);
  } else {
    entry.count += 1;
  }

  return next();
};

peer.use(rateLimiter);
```

---

## Timing

Measure how long each handler takes:

```ts
const timing: MiddlewareFn = async (ctx, next) => {
  const start = performance.now();
  try {
    return await next();
  } finally {
    const ms = (performance.now() - start).toFixed(2);
    console.log(`[timing] ${ctx.method} took ${ms}ms`);
  }
};

peer.use(timing);
```

Using `finally` ensures the duration is logged even when the handler throws.

---

## Order matters

Middlewares run in registration order. The first one added is the outermost wrapper.

```ts
peer.use(async (ctx, next) => {
  console.log('A before');
  const result = await next();
  console.log('A after');
  return result;
});

peer.use(async (ctx, next) => {
  console.log('B before');
  const result = await next();
  console.log('B after');
  return result;
});

// Output for any incoming call:
// A before
// B before
// B after
// A after
```

This means auth and logging middleware should be registered first, before anything that depends on them.

---

## Modifying results

A middleware can intercept the return value of `next()` and replace it. Here is an envelope wrapper that adds a timestamp to every response:

```ts
const envelope: MiddlewareFn = async (ctx, next) => {
  const result = await next();
  return { data: result, timestamp: Date.now() };
};

peer.use(envelope);
```

The caller receives `{ data: <original result>, timestamp: <unix ms> }` instead of the raw result. Make sure both sides of the contract agree on this shape, or only apply it selectively by checking `ctx.method`.

---

## Middleware in mesh mode

`peer.use()` works identically on a mesh peer. Middleware applies to all incoming requests regardless of which peer they originate from.

```ts
import { createMeshPeer } from 'duet-rpc';

const peer = createMeshPeer(contract, 'service-a', {
  connection: { strategy: 'hub', url: 'ws://localhost:4000' },
});

peer.use(async (ctx, next) => {
  console.log(`[mesh] ${ctx.peer} -> ${ctx.method}`);
  return next();
});
```

The `ctx.peer` field tells you which mesh node sent the request.
