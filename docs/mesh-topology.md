# Mesh Topology (Direct Connections)

In mesh mode, each service connects directly to every other service. There is no hub, no middleman. Each message travels one hop. This is the right choice for small, fixed clusters where you know all addresses upfront and want the lowest possible latency.

## How it works

```
  API ←──→ Bot
   ↕  ╲  ╱  ↕
   ↕   ╲╱   ↕
   ↕   ╱╲   ↕
  Worker ←→ DB
```

Each service starts a WebSocket server on its own port and opens outbound connections to every other service. When `api` starts, it listens on port 3001 and connects to `bot` on 3002, `worker` on 3003, and so on. Every pair of services has a direct socket between them.

A service sends a `mesh-register` frame on connect so the other side knows its name. After that, calls go directly between the two endpoints with no relay.

## When to use

- Small number of services (2-5 is ideal)
- Fixed infrastructure where all addresses are known ahead of time
- You need the lowest possible call latency (one hop instead of two)
- You want no single point of failure

## When NOT to use

- Services scale dynamically or addresses change at runtime
- More than roughly 5 services. Connections grow as N×(N-1)/2, so 10 services means 45 connections.
- You do not know all peer addresses before starting

## Setup

### 1. Define the contract

Declare every service as a key. Each key maps to the procedures that service exposes.

```ts
// shared/contract.ts
import { z } from "zod";
import { createContract } from "duet-rpc";

export const contract = createContract({
  api: {
    getUser: {
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), name: z.string() }),
    },
  },
  worker: {
    enqueueJob: {
      input: z.object({ type: z.string(), payload: z.unknown() }),
      output: z.object({ jobId: z.string() }),
    },
  },
  bot: {
    sendAlert: {
      input: z.object({ message: z.string() }),
    },
  },
});
```

### 2. Each service: listen + connect

Use `strategy: 'mesh'` in the connection options. Set `listen.port` to the port this service will accept connections on. Set `peers` to a map of every other service name and its WebSocket URL.

Each service needs to know the addresses of all peers it wants to call. If a service only needs to receive calls and never initiate them, you can omit the `peers` entry for services you will not call, but the calling service must still list you as a peer.

```ts
// api.ts
import { createMeshPeer } from "duet-rpc";
import { contract } from "./shared/contract";

const peer = createMeshPeer(contract, "api", {
  connection: {
    strategy: "mesh",
    listen: { port: 3001 },       // accept connections here
    peers: {
      worker: "ws://localhost:3002",
      bot:    "ws://localhost:3003",
    },
  },
});

peer.implement({
  getUser: async ({ id }) => {
    return { id, name: "Alice" };
  },
});

// Call another service
const { jobId } = await peer.to("worker").enqueueJob({
  type: "email",
  payload: { to: "alice@example.com" },
});
```

```ts
// worker.ts
import { createMeshPeer } from "duet-rpc";
import { contract } from "./shared/contract";

const peer = createMeshPeer(contract, "worker", {
  connection: {
    strategy: "mesh",
    listen: { port: 3002 },
    peers: {
      api: "ws://localhost:3001",
      bot: "ws://localhost:3003",
    },
  },
});

peer.implement({
  enqueueJob: async ({ type, payload }) => {
    const jobId = crypto.randomUUID();
    // ... queue the job
    return { jobId };
  },
});
```

Note the difference from the hub strategy: instead of `peer.remote.*`, mesh uses `peer.to("serviceName").*`. The target service name must match a key in the contract.

## Full working example

Three services. `api` calls `worker` to queue jobs. `worker` calls `bot` when a job finishes.

```ts
// shared/contract.ts
import { z } from "zod";
import { createContract } from "duet-rpc";

export const contract = createContract({
  api: {
    getStatus: {
      output: z.object({ ok: z.boolean() }),
    },
  },
  worker: {
    enqueueJob: {
      input: z.object({ type: z.string() }),
      output: z.object({ jobId: z.string() }),
    },
  },
  bot: {
    sendAlert: {
      input: z.object({ text: z.string() }),
    },
  },
});
```

```ts
// service-a.ts  (the "api" service)
import { createMeshPeer } from "duet-rpc";
import { contract } from "./shared/contract";

const peer = createMeshPeer(contract, "api", {
  connection: {
    strategy: "mesh",
    listen: { port: 3001 },
    peers: {
      worker: "ws://localhost:3002",
      bot:    "ws://localhost:3003",
    },
  },
});

peer.implement({
  getStatus: async () => ({ ok: true }),
});

peer.on("peer-connect", (name) => {
  console.log(`[api] connected to ${name}`);
});

// Queue a job once the worker is ready
peer.on("connect", async () => {
  const { jobId } = await peer.to("worker").enqueueJob({ type: "report" });
  console.log(`[api] queued job ${jobId}`);
});
```

```ts
// service-b.ts  (the "worker" service)
import { createMeshPeer } from "duet-rpc";
import { contract } from "./shared/contract";

const peer = createMeshPeer(contract, "worker", {
  connection: {
    strategy: "mesh",
    listen: { port: 3002 },
    peers: {
      api: "ws://localhost:3001",
      bot: "ws://localhost:3003",
    },
  },
});

peer.implement({
  enqueueJob: async ({ type }) => {
    const jobId = crypto.randomUUID();
    console.log(`[worker] queued ${type} as ${jobId}`);

    // Notify the bot when the job is done
    setTimeout(async () => {
      await peer.to("bot").sendAlert({ text: `Job ${jobId} finished` });
    }, 500);

    return { jobId };
  },
});
```

## Hub vs Mesh comparison

|                        | Hub                         | Mesh                      |
|------------------------|-----------------------------|---------------------------|
| Connections            | N (one per service)         | N×(N-1)/2                 |
| Latency                | 2 hops (service→hub→service)| 1 hop (direct)            |
| Single point of failure| Hub                         | None                      |
| Dynamic services       | Easy                        | Hard                      |
| Setup complexity       | Low                         | Medium                    |

For two services the difference is one connection either way. At five services, mesh opens 10 connections. At ten services it opens 45. The hub stays at N regardless.

## Reconnection

Pass `reconnect: true` to have each outbound connection automatically reconnect with exponential backoff if the socket drops.

```ts
const peer = createMeshPeer(contract, "api", {
  connection: {
    strategy: "mesh",
    listen: { port: 3001 },
    peers: {
      worker: "ws://localhost:3002",
    },
    reconnect: true,   // auto-reconnect on disconnect
  },
});
```

This only applies to outbound connections (the ones listed in `peers`). Inbound connections from peers that reconnect to your listening port are handled automatically by the server side.

Calls made while a peer is disconnected reject immediately with a `NOT_CONNECTED` error. Buffer them yourself if you need them to survive a reconnect window.
