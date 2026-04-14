# Custom Transport

The built-in WebSocket transport covers most cases. But any channel that can send and receive strings works. Implement the `Transport` interface and pass it to `createPeer()`.

---

## Transport interface

```ts
interface Transport {
  send(data: string): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  onOpen(handler: () => void): void;
  close(): void;
  readonly isOpen: boolean;
}
```

All six members are required:

| Member      | Description                                                     |
|-------------|-----------------------------------------------------------------|
| `send`      | Write a string to the channel                                   |
| `onMessage` | Register a callback fired on each incoming message              |
| `onClose`   | Register a callback fired when the connection closes            |
| `onOpen`    | Register a callback fired when the connection opens             |
| `close`     | Tear down the connection                                        |
| `isOpen`    | `true` if the transport is currently connected and ready        |

---

## Example: In-memory transport (for testing)

Useful for unit tests. Two `MemoryTransport` instances are wired together so each one's `send` calls the other's message handler.

```ts
class MemoryTransport implements Transport {
  private messageHandlers: Array<(data: string) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private openHandlers: Array<() => void> = [];
  private _isOpen = false;
  private peer: MemoryTransport | null = null;

  get isOpen() { return this._isOpen; }

  link(other: MemoryTransport) {
    this.peer = other;
  }

  open() {
    this._isOpen = true;
    this.openHandlers.forEach(h => h());
  }

  send(data: string) {
    if (!this._isOpen || !this.peer) return;
    // Deliver async so call stacks don't interleave
    Promise.resolve().then(() => this.peer!.receive(data));
  }

  receive(data: string) {
    this.messageHandlers.forEach(h => h(data));
  }

  onMessage(handler: (data: string) => void) { this.messageHandlers.push(handler); }
  onClose(handler: () => void)               { this.closeHandlers.push(handler); }
  onOpen(handler: () => void)                { this.openHandlers.push(handler); }

  close() {
    this._isOpen = false;
    this.closeHandlers.forEach(h => h());
  }
}

// Wire a pair together
function createMemoryPair(): [MemoryTransport, MemoryTransport] {
  const a = new MemoryTransport();
  const b = new MemoryTransport();
  a.link(b);
  b.link(a);
  return [a, b];
}
```

Usage in a test:

```ts
const [clientTransport, serverTransport] = createMemoryPair();

const server = createPeer(contract, 'server', { transport: serverTransport });
const client = createPeer(contract, 'client', { transport: clientTransport });

server.implement({ greet: (name) => `Hello, ${name}` });

clientTransport.open();
serverTransport.open();

const reply = await client.remote.greet('world');
// reply === 'Hello, world'
```

No network, no ports, no setup.

---

## Example: TCP transport

Wrap a Node.js `net.Socket` when you need raw TCP instead of WebSockets.

```ts
import net from 'net';

class TcpTransport implements Transport {
  private messageHandlers: Array<(data: string) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private openHandlers: Array<() => void> = [];

  constructor(private socket: net.Socket) {
    let buffer = '';

    socket.on('connect', () => this.openHandlers.forEach(h => h()));
    socket.on('close',   () => this.closeHandlers.forEach(h => h()));

    // Accumulate chunks and split on newline framing
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        if (line) this.messageHandlers.forEach(h => h(line));
      }
    });
  }

  get isOpen() { return !this.socket.destroyed; }

  send(data: string)                         { this.socket.write(data + '\n'); }
  onMessage(handler: (data: string) => void) { this.messageHandlers.push(handler); }
  onClose(handler: () => void)               { this.closeHandlers.push(handler); }
  onOpen(handler: () => void)                { this.openHandlers.push(handler); }
  close()                                    { this.socket.destroy(); }
}
```

Note: TCP is a stream protocol, not a message protocol. The newline framing above is one approach. Use a length-prefix or another delimiter if your payloads may contain newlines.

---

## Example: Stdin/Stdout transport

For parent-child IPC where the child process communicates over stdio:

```ts
import readline from 'readline';

class StdioTransport implements Transport {
  private messageHandlers: Array<(data: string) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private openHandlers: Array<() => void> = [];
  private _isOpen = true;

  constructor() {
    const rl = readline.createInterface({ input: process.stdin });

    rl.on('line', (line) => {
      if (line) this.messageHandlers.forEach(h => h(line));
    });

    rl.on('close', () => {
      this._isOpen = false;
      this.closeHandlers.forEach(h => h());
    });

    // Signal ready immediately
    Promise.resolve().then(() => this.openHandlers.forEach(h => h()));
  }

  get isOpen() { return this._isOpen; }

  send(data: string)                         { process.stdout.write(data + '\n'); }
  onMessage(handler: (data: string) => void) { this.messageHandlers.push(handler); }
  onClose(handler: () => void)               { this.closeHandlers.push(handler); }
  onOpen(handler: () => void)                { this.openHandlers.push(handler); }
  close()                                    { this._isOpen = false; process.stdin.destroy(); }
}
```

The parent spawns the child and communicates over the child's stdin/stdout. Each side runs its own `StdioTransport`.

---

## Using custom transports

Pass the transport in `PeerOptions`:

```ts
import { createPeer } from 'duet-rpc';

const [clientTransport, serverTransport] = createMemoryPair();

const server = createPeer(contract, 'server', { transport: serverTransport });
const client = createPeer(contract, 'client', { transport: clientTransport });
```

For mesh peers, the `connection` option expects a URL or topology descriptor, not a raw transport. To use a custom transport with mesh, wrap it at the hub level or use the `'mesh'` strategy with direct peer URLs that your custom server listens on. The built-in `createMeshPeer` connects via its own transport internally, so custom transports are most useful with `createPeer`.
