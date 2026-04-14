# Hub Topology

In hub topology, every service connects to one central hub. The hub routes messages between them. Services never connect to each other directly.

This is the right choice when you have three or more services and don't want to manage the full mesh of connections. With five services, a direct mesh needs ten connections. Hub topology needs five.

## How it works

```
        ┌─────┐
   ┌────│ Hub │────┐
   │    └──┬──┘    │
   │       │       │
   ↕       ↕       ↕
  api     bot    mailer
```

The hub is a dumb router. It reads the `target` field on each message and forwards the raw bytes to whichever service registered with that name. It has no knowledge of your contract, your methods, or your business logic. It just moves messages.

When a service connects, it sends a `mesh-register` message with its name. The hub stores that name-to-socket mapping. When that socket closes, the hub removes the entry.

## When to use

- Three or more services need to call each other
- Services start and stop independently (autoscaling, rolling deploys)
- You want one stable address for everything to point at instead of a full connection mesh

For two services, use the standard `createPeer` setup instead. Hub adds a network hop that buys you nothing with only two participants.

## Setup

### 1. Define the contract

The contract lists every service as a key. Each key maps to the procedures that service exposes.

```ts
// shared/contract.ts
import { z } from "zod";
import { createContract } from "duet-rpc";

export const contract = createContract({
  api: {
    getUser: {
      input: z.object({ userId: z.string() }),
      output: z.object({ id: z.string(), name: z.string(), email: z.string() }),
    },
  },
  bot: {
    sendDirectMessage: {
      input: z.object({ userId: z.string(), content: z.string() }),
      output: z.object({ messageId: z.string() }),
    },
    getGuildCount: {
      output: z.number(),
    },
  },
  mailer: {
    sendEmail: {
      input: z.object({
        to: z.string().email(),
        subject: z.string(),
        body: z.string(),
      }),
    },
  },
  payments: {
    chargeUser: {
      input: z.object({ userId: z.string(), amountCents: z.number() }),
      output: z.object({ chargeId: z.string(), success: z.boolean() }),
    },
  },
});
```

### 2. Start the hub

```ts
// hub.ts
import { createHub } from "duet-rpc";

const hub = createHub({ port: 4000 });

console.log(`Hub listening on port ${hub.address.port}`);

process.on("SIGINT", () => {
  hub.close();
  process.exit(0);
});
```

Start this first. Services can connect in any order after that.

### 3. Connect services

Each service calls `createMeshPeer` with `strategy: 'hub'` and the hub's WebSocket URL. The peer registers its name automatically on connect.

```ts
// api-service.ts
import { createMeshPeer } from "duet-rpc";
import { contract } from "./shared/contract";

const peer = createMeshPeer(contract, "api", {
  connection: {
    strategy: "hub",
    url: "ws://localhost:4000",
    reconnect: true,
  },
  timeout: 10000,
});

peer.implement({
  getUser: async ({ userId }) => {
    // fetch from your database
    return { id: userId, name: "Alice", email: "alice@example.com" };
  },
});

// Call other services via .to('name')
async function onNewSignup(userId: string) {
  const [dmResult] = await Promise.all([
    peer.to("bot").sendDirectMessage({
      userId,
      content: "Welcome to the platform!",
    }),
    peer.to("mailer").sendEmail({
      to: "alice@example.com",
      subject: "Welcome",
      body: "Thanks for signing up.",
    }),
  ]);

  console.log("Welcome DM sent:", dmResult.messageId);
}
```

```ts
// bot-service.ts
import { createMeshPeer } from "duet-rpc";
import { contract } from "./shared/contract";

const peer = createMeshPeer(contract, "bot", {
  connection: {
    strategy: "hub",
    url: "ws://localhost:4000",
    reconnect: true,
  },
});

peer.implement({
  sendDirectMessage: async ({ userId, content }) => {
    // send via Discord client
    const messageId = await discordClient.sendDM(userId, content);
    return { messageId };
  },
  getGuildCount: async () => {
    return discordClient.guilds.cache.size;
  },
});

// Bot can call other services too
async function onUserSubscribed(userId: string) {
  await peer.to("payments").chargeUser({ userId, amountCents: 999 });
  await peer.to("mailer").sendEmail({
    to: "billing@example.com",
    subject: "New subscriber",
    body: `User ${userId} subscribed.`,
  });
}
```

## Full working example

Four files you can copy and run.

**`contract.ts`**

```ts
import { z } from "zod";
import { createContract } from "duet-rpc";

export const contract = createContract({
  api: {
    getUser: {
      input: z.object({ userId: z.string() }),
      output: z.object({ id: z.string(), name: z.string() }),
    },
  },
  bot: {
    sendDirectMessage: {
      input: z.object({ userId: z.string(), content: z.string() }),
      output: z.object({ messageId: z.string() }),
    },
  },
  mailer: {
    sendEmail: {
      input: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
    },
  },
  payments: {
    chargeUser: {
      input: z.object({ userId: z.string(), amountCents: z.number() }),
      output: z.object({ chargeId: z.string(), success: z.boolean() }),
    },
  },
});
```

**`hub.ts`**

```ts
import { createHub } from "duet-rpc";

const hub = createHub({ port: 4000 });
console.log("Hub running on port", hub.address.port);
```

**`api-service.ts`**

```ts
import { createMeshPeer } from "duet-rpc";
import { contract } from "./contract";

const peer = createMeshPeer(contract, "api", {
  connection: { strategy: "hub", url: "ws://localhost:4000", reconnect: true },
});

peer.implement({
  getUser: async ({ userId }) => ({ id: userId, name: "Alice" }),
});

peer.on("connect", async () => {
  // Call bot once connected
  const result = await peer.to("bot").sendDirectMessage({
    userId: "user-123",
    content: "Hello from API",
  });
  console.log("DM sent:", result.messageId);
});
```

**`bot-service.ts`**

```ts
import { createMeshPeer } from "duet-rpc";
import { contract } from "./contract";

const peer = createMeshPeer(contract, "bot", {
  connection: { strategy: "hub", url: "ws://localhost:4000", reconnect: true },
});

peer.implement({
  sendDirectMessage: async ({ userId, content }) => {
    console.log(`DM to ${userId}: ${content}`);
    return { messageId: `msg-${Date.now()}` };
  },
});

peer.on("connect", () => console.log("Bot connected to hub"));
```

Run order: `hub.ts`, then any service in any order.

## Service discovery

The hub only knows about currently connected services. If you call `.to('payments')` and no service has registered with that name, the hub receives your message and silently drops it because there is no matching socket.

Your call times out after the configured `timeout` (default 15 seconds):

```ts
import { PeerError } from "duet-rpc";

try {
  await peer.to("payments").chargeUser({ userId, amountCents: 500 });
} catch (err) {
  if (err instanceof PeerError && err.code === "TIMEOUT") {
    console.error("payments service is not connected");
  }
}
```

There is no built-in presence query on the hub. If you need to check whether a service is up before calling it, track that yourself with `peer-connect` and `peer-disconnect` events. Those events fire in the direct mesh strategy, not in hub strategy, because the hub does not forward presence notifications. In hub mode, the only signal you get is a timeout.

The practical pattern: set a short timeout for calls where the target might be absent, and handle `TIMEOUT` as a known failure mode.

```ts
const peer = createMeshPeer(contract, "api", {
  connection: { strategy: "hub", url: "ws://localhost:4000" },
  timeout: 3000, // fail fast if payments isn't up
});
```

## Multiple instances

If two processes register with the same name, the hub's map is updated with the newer connection. The first connection is still open, but the hub no longer routes to it. Any calls targeting that name go to the second process.

This is the current behavior. There is no round-robin, no load balancing, and no error. The hub just overwrites the map entry.

If you run multiple instances of a service and want requests distributed across them, you need something in front of the hub, or a different topology entirely. For simple scaling of stateless workers, the direct mesh strategy with explicit peer addresses gives you more control.

## Error handling across services

`PeerError` travels across the wire. Throw one in a handler, and the caller receives it as a `PeerError` with the same `code`, `message`, and `data`.

```ts
// bot-service.ts
import { PeerError } from "duet-rpc";

peer.implement({
  sendDirectMessage: async ({ userId, content }) => {
    const user = await discordClient.users.fetch(userId).catch(() => null);

    if (!user) {
      throw new PeerError("USER_NOT_FOUND", `No Discord user with id ${userId}`, {
        userId,
      });
    }

    const msg = await user.send(content);
    return { messageId: msg.id };
  },
});
```

```ts
// api-service.ts
try {
  await peer.to("bot").sendDirectMessage({ userId, content: "Hello" });
} catch (err) {
  if (err instanceof PeerError) {
    if (err.code === "USER_NOT_FOUND") {
      // err.data.userId is available
      console.error("User not in Discord:", err.data);
    } else if (err.code === "TIMEOUT") {
      console.error("Bot service did not respond");
    } else {
      console.error("Unexpected error:", err.code, err.message);
    }
  }
}
```

Errors that are not `PeerError` instances, plain `throw new Error(...)` for example, get serialized as `INTERNAL_ERROR` with the error message. The stack trace does not cross the wire.
