# Peer-to-Peer (1:1)

The simplest mode. Two processes, one contract, one direct WebSocket connection. One side runs a server, the other connects as a client. Both sides can call each other.

No broker, no routing layer, no hub. Just two peers talking.

## When to use

- Two processes that need typed, bidirectional communication
- Bot + web dashboard
- Main app + background worker
- Electron main process + renderer process
- Any pair of services where one is the natural "server" and one is the natural "client"

If you have more than two participants, or need dynamic routing between many nodes, see the mesh docs instead.

## Setup

### 1. Define the contract

The contract is a plain object that describes what each side exposes. Each key is a side name. Each value is a map of procedure names to their `input` and/or `output` Zod schemas.

```ts
// contract.ts
import { z } from "zod";
import { createContract } from "duet-rpc";

export const contract = createContract({
  // Procedures the game server exposes
  gameServer: {
    joinLobby: {
      input: z.object({ playerId: z.string(), displayName: z.string() }),
      output: z.object({ lobbyId: z.string(), playerCount: z.number() }),
    },
    leaveLobby: {
      input: z.object({ playerId: z.string() }),
    },
    getPlayerCount: {
      output: z.number(),
    },
  },

  // Procedures the lobby client exposes
  lobbyClient: {
    onPlayerJoined: {
      input: z.object({ playerId: z.string(), displayName: z.string() }),
    },
    onPlayerLeft: {
      input: z.object({ playerId: z.string() }),
    },
    onLobbyReady: {
      input: z.object({ countdownSeconds: z.number() }),
    },
  },
});
```

Procedures can have `input`, `output`, both, or neither. All are optional.

### 2. Server side

The server creates a `WsServer`, waits for a connection, then creates a peer for that connection.

```ts
// server.ts
import { createWsServer, createPeer } from "duet-rpc";
import { contract } from "./contract";

const server = createWsServer({ port: 4000 });

server.onConnection((transport) => {
  const peer = createPeer(contract, "gameServer", { transport });

  // Implement your side of the contract
  peer.implement({
    joinLobby: async ({ playerId, displayName }) => {
      lobby.add(playerId, displayName);

      // Call back to the client
      await peer.remote.onPlayerJoined({ playerId, displayName });

      return { lobbyId: lobby.id, playerCount: lobby.size };
    },

    leaveLobby: async ({ playerId }) => {
      lobby.remove(playerId);
      await peer.remote.onPlayerLeft({ playerId });
    },

    getPlayerCount: () => lobby.size,
  });
});
```

`createPeer` takes three arguments:

| Argument  | Description |
|-----------|-------------|
| `contract` | The shared contract object |
| `"gameServer"` | Which side this peer implements |
| `options` | Transport and configuration |

`peer.implement` registers your handlers. TypeScript will enforce that you match the contract signatures exactly.

`peer.remote` is a fully typed proxy for calling the other side.

### 3. Client side

The client connects and creates a peer for the opposite side.

```ts
// client.ts
import { createWsClient, createPeer } from "duet-rpc";
import { contract } from "./contract";

const transport = createWsClient({ url: "ws://localhost:4000" });

const peer = createPeer(contract, "lobbyClient", { transport });

// Implement the client side
peer.implement({
  onPlayerJoined: ({ playerId, displayName }) => {
    console.log(`${displayName} (${playerId}) joined`);
  },

  onPlayerLeft: ({ playerId }) => {
    console.log(`${playerId} left`);
  },

  onLobbyReady: ({ countdownSeconds }) => {
    console.log(`Game starts in ${countdownSeconds} seconds`);
  },
});

// Call server procedures
const { lobbyId, playerCount } = await peer.remote.joinLobby({
  playerId: "u_123",
  displayName: "Alice",
});

console.log(`Joined lobby ${lobbyId}, ${playerCount} players`);
```

---

## Full working example

A chat app. The server tracks message history and online users. The client receives push notifications when things happen.

**`contract.ts`**

```ts
import { z } from "zod";
import { createContract } from "duet-rpc";

const Message = z.object({
  id: z.string(),
  authorId: z.string(),
  text: z.string(),
  sentAt: z.date(),
});

export const contract = createContract({
  server: {
    sendMessage: {
      input: z.object({ authorId: z.string(), text: z.string() }),
      output: Message,
    },
    getHistory: {
      input: z.object({ limit: z.number().int().positive().default(50) }),
      output: z.array(Message),
    },
    getOnlineUsers: {
      output: z.array(z.string()),
    },
  },

  client: {
    onNewMessage: {
      input: Message,
    },
    onUserJoined: {
      input: z.object({ userId: z.string() }),
    },
    onUserLeft: {
      input: z.object({ userId: z.string() }),
    },
  },
});
```

**`server.ts`**

```ts
import { createWsServer, createPeer, PeerError } from "duet-rpc";
import { contract } from "./contract";

const history: Array<{ id: string; authorId: string; text: string; sentAt: Date }> = [];
const onlineUsers = new Set<string>();
let msgCounter = 0;

const server = createWsServer({ port: 4000 });
console.log("Chat server listening on :4000");

server.onConnection((transport) => {
  const peer = createPeer(contract, "server", { transport });
  let connectedUserId: string | null = null;

  peer.implement({
    sendMessage: async ({ authorId, text }) => {
      if (!text.trim()) {
        throw new PeerError("INVALID_INPUT", "Message text cannot be empty");
      }

      const msg = {
        id: `msg_${++msgCounter}`,
        authorId,
        text: text.trim(),
        sentAt: new Date(),
      };

      history.push(msg);
      connectedUserId = authorId;
      onlineUsers.add(authorId);

      // Notify the client about their own message (so they can confirm it)
      await peer.remote.onNewMessage(msg);

      return msg;
    },

    getHistory: ({ limit }) => {
      return history.slice(-limit);
    },

    getOnlineUsers: () => {
      return Array.from(onlineUsers);
    },
  });

  peer.on("disconnect", () => {
    if (connectedUserId) {
      onlineUsers.delete(connectedUserId);
    }
  });
});
```

**`client.ts`**

```ts
import { createWsClient, createPeer, PeerError } from "duet-rpc";
import { contract } from "./contract";

const transport = createWsClient({ url: "ws://localhost:4000" });
const peer = createPeer(contract, "client", { transport });

peer.implement({
  onNewMessage: ({ id, authorId, text, sentAt }) => {
    console.log(`[${sentAt.toISOString()}] ${authorId}: ${text} (id: ${id})`);
  },

  onUserJoined: ({ userId }) => {
    console.log(`-> ${userId} came online`);
  },

  onUserLeft: ({ userId }) => {
    console.log(`<- ${userId} went offline`);
  },
});

peer.on("connect", async () => {
  console.log("Connected to chat server");

  // Fetch history on connect
  const history = await peer.remote.getHistory({ limit: 20 });
  console.log(`Loaded ${history.length} messages`);

  // Send a message
  try {
    const msg = await peer.remote.sendMessage({
      authorId: "alice",
      text: "Hello, world!",
    });
    console.log(`Message sent: ${msg.id}`);
  } catch (err) {
    if (err instanceof PeerError) {
      console.error(`Failed: [${err.code}] ${err.message}`);
    }
  }
});

peer.on("disconnect", () => {
  console.log("Disconnected from chat server");
});
```

---

## Error handling

Throw `PeerError` from a handler to send a structured error to the caller. The error travels across the wire with its `code`, `message`, and optional `data` intact.

```ts
import { PeerError } from "duet-rpc";

// In a handler
peer.implement({
  sendMessage: async ({ authorId, text }) => {
    const user = await db.users.findById(authorId);
    if (!user) {
      throw new PeerError("NOT_FOUND", "User does not exist", { authorId });
    }
    if (user.banned) {
      throw new PeerError("FORBIDDEN", "Banned users cannot send messages");
    }
    // ...
  },
});
```

On the caller side:

```ts
try {
  await peer.remote.sendMessage({ authorId, text });
} catch (err) {
  if (err instanceof PeerError) {
    switch (err.code) {
      case "NOT_FOUND":
        console.error("User not found:", err.data);
        break;
      case "FORBIDDEN":
        console.error("Access denied:", err.message);
        break;
      case "TIMEOUT":
        console.error("Call timed out");
        break;
      case "DISCONNECTED":
        console.error("Lost connection mid-call");
        break;
      default:
        console.error(`Unexpected error [${err.code}]:`, err.message);
    }
  }
}
```

Built-in error codes:

| Code | When it occurs |
|------|----------------|
| `TIMEOUT` | Call exceeded the configured timeout |
| `DISCONNECTED` | Connection closed while a call was in flight |
| `NOT_CONNECTED` | Called `remote.*` on a closed transport with no queue |
| `METHOD_NOT_FOUND` | Handler not registered for the called method |
| `VALIDATION_ERROR` | Input failed Zod schema validation |
| `INTERNAL_ERROR` | Handler threw a plain (non-`PeerError`) error |

Plain errors thrown from handlers become `INTERNAL_ERROR` with the original message:

```ts
// Handler throws this:
throw new Error("database connection lost");

// Caller catches this:
// PeerError { code: "INTERNAL_ERROR", message: "database connection lost" }
```

---

## Middleware

Middleware runs before every incoming handler call. Koa-style: `ctx` describes the call, `next` runs the actual handler.

**Logging middleware:**

```ts
peer.use(async (ctx, next) => {
  const start = Date.now();
  try {
    const result = await next();
    console.log(`${ctx.method} OK (${Date.now() - start}ms)`);
    return result;
  } catch (err) {
    console.error(`${ctx.method} ERROR (${Date.now() - start}ms)`, err);
    throw err;
  }
});
```

**Auth middleware:**

```ts
const VALID_TOKENS = new Set(["secret-token-abc"]);

peer.use(async (ctx, next) => {
  const token = (ctx.params as any)?.token;
  if (!VALID_TOKENS.has(token)) {
    throw new PeerError("UNAUTHORIZED", "Invalid token");
  }
  return next();
});
```

The `ctx` object:

```ts
interface MiddlewareContext {
  method: string;   // name of the procedure being called
  params: unknown;  // input params (after Zod parsing)
  side: string;     // which side is handling ("server", "client", etc.)
  peer: string;     // which side sent the request
}
```

Middleware runs in the order you add it. Call `next()` to continue. Throw to reject the call.

---

## Timeouts

By default, calls time out after 15 seconds. Configure with the `timeout` option.

```ts
const peer = createPeer(contract, "client", {
  transport,
  timeout: 5000, // 5 seconds
});
```

Timed-out calls reject with `PeerError { code: "TIMEOUT" }`:

```ts
try {
  await peer.remote.sendMessage({ authorId, text });
} catch (err) {
  if (err instanceof PeerError && err.code === "TIMEOUT") {
    console.error("Server took too long to respond");
  }
}
```

To disable the timeout entirely, set `timeout: 0`. Calls will wait forever.

---

## Reconnection

`createWsClient` returns a plain transport. If the connection drops, it stays closed. Wrap it in `ReconnectingTransport` to get automatic reconnection with exponential backoff.

```ts
import { ReconnectingTransport, createWsClient, createPeer } from "duet-rpc";
import { contract } from "./contract";

const transport = new ReconnectingTransport(
  () => createWsClient({ url: "ws://localhost:4000" }),
  {
    interval: 1000,       // first retry after 1s
    maxInterval: 30000,   // cap at 30s
    factor: 2,            // double the delay each attempt
    maxAttempts: Infinity, // keep trying forever
  }
);

const peer = createPeer(contract, "client", { transport });
```

The factory function `() => createWsClient(...)` is called fresh on each reconnect attempt. The delays go: 1s, 2s, 4s, 8s, 16s, 30s, 30s, ...

To stop reconnecting:

```ts
transport.stop();  // stop retrying, leave current connection open
transport.close(); // close the connection and stop retrying
```

If you need to queue outgoing calls while disconnected and flush them on reconnect:

```ts
const peer = createPeer(contract, "client", {
  transport,
  queueOnDisconnect: true,
});
```

---

## Lifecycle events

```ts
peer.on("connect", () => {
  console.log("Connected");
  // Safe to call peer.remote.* here
});

peer.on("disconnect", () => {
  console.log("Disconnected");
  // In-flight calls have already been rejected with DISCONNECTED
});

peer.on("error", (err) => {
  console.error("Peer error:", err);
});
```

The `"connect"` event fires each time the underlying transport opens, including after reconnects. Use it to re-run any initialization logic that depends on the connection being live.

To close the peer and its transport:

```ts
peer.close();
```

This stops the heartbeat, rejects all pending calls with `DISCONNECTED`, and closes the underlying transport.
