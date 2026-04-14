# duet-rpc

Bidirectional type-safe RPC over WebSocket.

## Why this exists

tRPC is great for client-server. But it's one-directional: the client calls the server. If your server needs to call the client back, you're on your own. birpc gets the bidirectional part right, but it gives you nothing else. No transport, no validation, no reconnect. You wire all of that up yourself.

I needed a Discord bot and a web dashboard to talk to each other. The bot calls dashboard functions, the dashboard calls bot functions. Both sides fully typed, with Zod validation on every call, and the connection stays alive on its own. Nothing out there did all of that, so I built this.

You define one contract. Both sides implement their half. Both sides can call the other half. TypeScript infers everything. Zod validates at runtime. The WebSocket reconnects when it drops. That's it.

## Install

```bash
bun add duet-rpc zod
# or
npm install duet-rpc zod
```

## Quick start

Three files. One shared contract, two peers.

### `shared/contract.ts`

```ts
import { z } from "zod";
import { createContract } from "duet-rpc";

export const contract = createContract({
  // Functions the bot exposes
  bot: {
    getGuildCount: {
      output: z.number(),
    },
    sendMessage: {
      input: z.object({
        channelId: z.string(),
        content: z.string(),
      }),
      output: z.object({
        messageId: z.string(),
        timestamp: z.date(),
      }),
    },
    kickUser: {
      input: z.object({
        guildId: z.string(),
        userId: z.string(),
        reason: z.string().optional(),
      }),
    },
  },

  // Functions the dashboard exposes
  dashboard: {
    onUserBanned: {
      input: z.object({
        guildId: z.string(),
        userId: z.string(),
        moderator: z.string(),
        bannedAt: z.date(),
      }),
    },
    getActiveSessions: {
      output: z.number(),
    },
  },
});
```

### `bot.ts`

```ts
import { createPeer, createWsServer } from "duet-rpc";
import { contract } from "./shared/contract";

const server = createWsServer({ port: 4000 });

server.onConnection((transport) => {
  const peer = createPeer(contract, "bot", { transport });

  // Implement the bot side of the contract
  peer.implement({
    getGuildCount: async () => {
      return client.guilds.cache.size;
    },
    sendMessage: async ({ channelId, content }) => {
      const channel = await client.channels.fetch(channelId);
      const msg = await channel.send(content);
      return { messageId: msg.id, timestamp: msg.createdAt };
    },
    kickUser: async ({ guildId, userId, reason }) => {
      const guild = await client.guilds.fetch(guildId);
      await guild.members.kick(userId, reason);
    },
  });

  // Call dashboard functions from the bot
  peer.remote.getActiveSessions().then((count) => {
    console.log(`Dashboard has ${count} active sessions`);
  });
});
```

### `dashboard.ts`

```ts
import { createPeer, createWsClient, ReconnectingTransport } from "duet-rpc";
import { contract } from "./shared/contract";

// Auto-reconnect with exponential backoff
const transport = new ReconnectingTransport(
  () => createWsClient({ url: "ws://localhost:4000" }),
  { interval: 1000, maxInterval: 30000, factor: 2 }
);

const peer = createPeer(contract, "dashboard", { transport });

peer.implement({
  onUserBanned: async ({ guildId, userId, moderator, bannedAt }) => {
    console.log(`${moderator} banned ${userId} in ${guildId} at ${bannedAt}`);
    // bannedAt is a real Date object, not a string
  },
  getActiveSessions: () => {
    return activeSessions.size;
  },
});

// Call bot functions from the dashboard
async function handleKickButton(guildId: string, userId: string) {
  // Fully typed, autocomplete works
  await peer.remote.kickUser({ guildId, userId, reason: "Violated rules" });
}

async function refreshStats() {
  const guilds = await peer.remote.getGuildCount();
  console.log(`Bot is in ${guilds} guilds`);
}
```

## API reference

### `createContract(def)`

Define a bidirectional contract. Each key is a side name, each value is a set of procedures with optional `input` and `output` Zod schemas.

```ts
const contract = createContract({
  server: {
    myMethod: { input: z.string(), output: z.number() },
  },
  client: {
    onEvent: { input: z.object({ type: z.string() }) },
  },
});
```

### `createPeer(contract, side, options)`

Create a peer that implements one side of the contract and can call the other.

```ts
const peer = createPeer(contract, "server", { transport });
```

### `peer.implement(handlers)`

Register handlers for your side of the contract. TypeScript enforces that you implement every procedure.

```ts
peer.implement({
  myMethod: async (input) => {
    // input is typed as string, return type must be number
    return input.length;
  },
});
```

### `peer.remote.*`

Call procedures on the other side. Returns promises. Input and output types are inferred from the contract.

```ts
const result = await peer.remote.onEvent({ type: "ready" });
```

### `peer.use(middleware)`

Add middleware that runs before handlers. Koa-style with `ctx` and `next`.

```ts
peer.use(async (ctx, next) => {
  const start = Date.now();
  const result = await next();
  console.log(`${ctx.method} took ${Date.now() - start}ms`);
  return result;
});
```

The context object:

```ts
interface MiddlewareContext {
  method: string;   // procedure name being called
  params: unknown;  // raw input
  side: string;     // which side is handling this
  peer: string;     // which side sent the request
}
```

### `peer.on(event, handler)`

Listen for lifecycle events.

```ts
peer.on("connect", () => console.log("Connected"));
peer.on("disconnect", () => console.log("Disconnected"));
peer.on("error", (err) => console.error(err));
```

### `createWsServer({ port })`

Create a WebSocket server transport. Calls your handler for each new connection.

```ts
const server = createWsServer({ port: 4000 });
server.onConnection((transport) => {
  // create a peer with this transport
});
```

### `createWsClient({ url })`

Create a WebSocket client transport.

```ts
const transport = createWsClient({ url: "ws://localhost:4000" });
```

### `ReconnectingTransport`

Wraps a transport factory with automatic reconnection and exponential backoff.

```ts
const transport = new ReconnectingTransport(
  () => createWsClient({ url: "ws://localhost:4000" }),
  {
    interval: 1000,      // base delay (default: 1000ms)
    maxInterval: 30000,   // max delay (default: 30000ms)
    maxAttempts: Infinity, // give up after N tries (default: Infinity)
    factor: 2,            // backoff multiplier (default: 2)
  }
);

// Stop reconnecting without closing
transport.stop();

// Close the underlying connection and stop
transport.close();
```

### `PeerError`

Typed errors that travel across the wire. Throw one from a handler and the caller gets it back with `code`, `message`, and optional `data`.

```ts
import { PeerError } from "duet-rpc";

// In a handler
throw new PeerError("NOT_FOUND", "Channel does not exist", { channelId });

// On the caller side
try {
  await peer.remote.sendMessage({ channelId, content: "hi" });
} catch (err) {
  if (err instanceof PeerError) {
    console.log(err.code);    // "NOT_FOUND"
    console.log(err.message); // "Channel does not exist"
    console.log(err.data);    // { channelId: "..." }
  }
}
```

## Multi-service (mesh)

The examples above show two processes talking 1:1. When you have 3+ services, use `createMeshPeer` instead of `createPeer`. Two strategies are available: hub (star) and direct mesh.

### Hub topology

One central router, all services connect to it. The hub forwards messages between them.

```ts
import { createHub, createMeshPeer, createContract } from "duet-rpc";
import { z } from "zod";

const contract = createContract({
  api:    { getHealth: { output: z.string() } },
  bot:    { getGuilds: { output: z.array(z.string()) } },
  mailer: { send: { input: z.object({ to: z.string(), body: z.string() }) } },
});

// Start the hub (runs on its own, no contract knowledge needed)
const hub = createHub({ port: 4000 });

// Each service connects to the hub
const botPeer = createMeshPeer(contract, "bot", {
  connection: { strategy: "hub", url: "ws://localhost:4000" },
});

botPeer.implement({
  getGuilds: async () => ["Guild A", "Guild B"],
});

// Call any other service by name
await botPeer.to("mailer").send({ to: "admin@test.com", body: "Bot started" });
const health = await botPeer.to("api").getHealth();
```

`peer.to("mailer")` returns a fully typed proxy. You get autocomplete on method names, input types, and return types.

### Direct mesh

Each service connects directly to every other. No middleman, lowest latency.

```ts
const apiPeer = createMeshPeer(contract, "api", {
  connection: {
    strategy: "mesh",
    listen: { port: 3001 },
    peers: {
      bot: "ws://localhost:3002",
      mailer: "ws://localhost:3003",
    },
  },
});
```

### Hub vs mesh

| | Hub | Mesh |
|---|---|---|
| Connections per service | 1 | N-1 |
| Latency | 2 hops | 1 hop (direct) |
| Single point of failure | Hub | None |
| Dynamic services | Easy | Hard |

Pick hub when services come and go. Pick mesh when you have a small fixed cluster and want the lowest latency. The calling code is identical either way.

See [docs/hub-topology.md](docs/hub-topology.md) and [docs/mesh-topology.md](docs/mesh-topology.md) for full guides with more examples.

## Features

- **Bidirectional RPC.** Both sides call each other. Not request-response, not pub-sub. Actual function calls in both directions.
- **Multi-service mesh.** Hub (star) or direct mesh topology. N services, one contract, typed `.to("name")` calls.
- Full TypeScript inference from the contract. No codegen, no build step.
- Zod validation on every incoming call. Bad input fails fast with a clear error.
- WebSocket transport with auto-reconnect and exponential backoff.
- Rich serialization via [devalue](https://github.com/Rich-Harris/devalue). Date, Map, Set, BigInt, RegExp all work out of the box.
- Koa-style middleware. Logging, auth, rate limiting, whatever you need.
- Typed errors across the wire. Throw a `PeerError` in a handler, catch it on the other side.
- Small. Around 1000 lines of code total.

## Docs

- [Peer-to-peer (1:1)](docs/peer-to-peer.md)
- [Hub topology](docs/hub-topology.md)
- [Mesh topology](docs/mesh-topology.md)
- [Middleware](docs/middleware.md)
- [Custom transport](docs/custom-transport.md)

## Custom transport

The `Transport` interface is simple. Implement it to run duet-rpc over anything: TCP, IPC, `postMessage`, carrier pigeon.

```ts
import type { Transport } from "duet-rpc";

class MyTransport implements Transport {
  get isOpen(): boolean {
    // return true when the connection is ready
  }

  send(data: string): void {
    // send a string to the other side
  }

  onMessage(handler: (data: string) => void): void {
    // call handler when a message arrives
  }

  onClose(handler: () => void): void {
    // call handler when the connection closes
  }

  onOpen(handler: () => void): void {
    // call handler when the connection opens
  }

  close(): void {
    // close the connection
  }
}
```

If you need a server that accepts multiple connections:

```ts
import type { TransportServer } from "duet-rpc";

class MyServer implements TransportServer {
  onConnection(handler: (transport: Transport) => void): void {
    // call handler with a Transport for each new connection
  }

  close(): void {
    // shut down the server
  }

  get address(): { port: number } {
    // return the listening port
  }
}
```

## License

MIT
