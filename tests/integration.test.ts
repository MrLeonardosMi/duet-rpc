import { describe, it, expect, afterAll, beforeAll } from 'bun:test';
import { z } from 'zod';
import { createContract, createPeer, createWsServer, createWsClient, PeerError } from '../src/index';
import type { TransportServer, Transport, MiddlewareContext, MiddlewareFn } from '../src/index';
const contract = createContract({
  server: {
    greet: { input: z.string(), output: z.string() },
    add: { input: z.object({ a: z.number(), b: z.number() }), output: z.number() },
    getTime: { output: z.date() },
    crash: {},
    noArgs: {},
    crashPlain: {},
    slow: {},
  },
  client: {
    notify: { input: z.string() },
    getStatus: { output: z.string() },
  },
});

function waitFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForConnection(transport: Transport): Promise<void> {
  return new Promise((resolve) => {
    if (transport.isOpen) {
      resolve();
      return;
    }
    transport.onOpen(() => resolve());
  });
}

describe('Bidirectional RPC', () => {
  const port = 10000 + Math.floor(Math.random() * 50000);
  let wsServer: TransportServer;
  let serverPeer: any;
  let clientPeer: any;
  let clientTransport: Transport;

  beforeAll(async () => {
    wsServer = createWsServer({ port });

    wsServer.onConnection((transport) => {
      serverPeer = createPeer(contract, 'server', { transport, heartbeatInterval: 0 });
      serverPeer.implement({
        greet: (name: string) => `Hello, ${name}!`,
        add: ({ a, b }: { a: number; b: number }) => a + b,
        getTime: () => new Date('2024-06-15T10:30:00Z'),
        crash: () => { throw new PeerError('BOOM', 'test error'); },
        noArgs: () => {},
        crashPlain: () => { throw new Error('something broke'); },
        slow: () => new Promise(() => {}),
      });
    });

    clientTransport = createWsClient({ url: `ws://localhost:${port}` });
    clientPeer = createPeer(contract, 'client', { transport: clientTransport, heartbeatInterval: 0 });
    clientPeer.implement({
      notify: (_msg: string) => {},
      getStatus: () => 'all good',
    });

    await waitForConnection(clientTransport);
    await waitFor(50);
  });

  afterAll(() => {
    clientPeer.close();
    wsServer.close();
  });

  it('client calls server method with input and output', async () => {
    const result = await clientPeer.remote.greet('World');
    expect(result).toBe('Hello, World!');
  });

  it('server calls client method', async () => {
    const result = await serverPeer.remote.getStatus();
    expect(result).toBe('all good');
  });

  it('handles methods with no arguments', async () => {
    await clientPeer.remote.noArgs();
  });

  it('handles methods that return Date objects', async () => {
    const result = await clientPeer.remote.getTime();
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).toISOString()).toBe('2024-06-15T10:30:00.000Z');
  });

  it('rejects with METHOD_NOT_FOUND for unknown methods', async () => {
    try {
      await (clientPeer.remote as any).nonexistent();
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(PeerError);
      expect(err.code).toBe('METHOD_NOT_FOUND');
    }
  });

  it('rejects with VALIDATION_ERROR for bad input', async () => {
    try {
      await (clientPeer.remote as any).add('not an object');
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(PeerError);
      expect(err.code).toBe('VALIDATION_ERROR');
    }
  });

  it('server handler can throw PeerError and client receives it', async () => {
    try {
      await clientPeer.remote.crash();
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(PeerError);
      expect(err.code).toBe('BOOM');
      expect(err.message).toBe('test error');
    }
  });

  it('server handler can throw plain Error and client gets INTERNAL_ERROR', async () => {
    try {
      await clientPeer.remote.crashPlain();
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(PeerError);
      expect(err.code).toBe('INTERNAL_ERROR');
      expect(err.message).toBe('something broke');
    }
  });

  it('multiple concurrent calls resolve correctly', async () => {
    const results = await Promise.all([
      clientPeer.remote.greet('A'),
      clientPeer.remote.greet('B'),
      clientPeer.remote.add({ a: 10, b: 20 }),
      clientPeer.remote.greet('C'),
    ]);
    expect(results[0]).toBe('Hello, A!');
    expect(results[1]).toBe('Hello, B!');
    expect(results[2]).toBe(30);
    expect(results[3]).toBe('Hello, C!');
  });
});

describe('Timeout', () => {
  const port = 10000 + Math.floor(Math.random() * 50000);
  let wsServer: TransportServer;
  let clientPeer: any;
  let clientTransport: Transport;

  beforeAll(async () => {
    wsServer = createWsServer({ port });

    wsServer.onConnection((transport) => {
      const sp = createPeer(contract, 'server', { transport, heartbeatInterval: 0 });
      sp.implement({
        greet: (name: string) => `Hello, ${name}!`,
        add: ({ a, b }: { a: number; b: number }) => a + b,
        getTime: () => new Date(),
        crash: () => { throw new PeerError('BOOM', 'test error'); },
        noArgs: () => {},
        crashPlain: () => { throw new Error('broke'); },
        slow: () => new Promise(() => {}),
      });
    });

    clientTransport = createWsClient({ url: `ws://localhost:${port}` });
    clientPeer = createPeer(contract, 'client', { transport: clientTransport, heartbeatInterval: 0, timeout: 200 });
    clientPeer.implement({
      notify: (_msg: string) => {},
      getStatus: () => 'ok',
    });

    await waitForConnection(clientTransport);
    await waitFor(50);
  });

  afterAll(() => {
    clientPeer.close();
    wsServer.close();
  });

  it('timeout rejects calls that take too long', async () => {
    try {
      await clientPeer.remote.slow();
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(PeerError);
      expect(err.code).toBe('TIMEOUT');
    }
  });
});

describe('Disconnect', () => {
  const port = 10000 + Math.floor(Math.random() * 50000);
  let wsServer: TransportServer;
  let clientPeer: any;
  let clientTransport: Transport;

  beforeAll(async () => {
    wsServer = createWsServer({ port });

    wsServer.onConnection((transport) => {
      const sp = createPeer(contract, 'server', { transport, heartbeatInterval: 0 });
      sp.implement({
        greet: (name: string) => `Hello, ${name}!`,
        add: ({ a, b }: { a: number; b: number }) => a + b,
        getTime: () => new Date(),
        crash: () => {},
        noArgs: () => {},
        crashPlain: () => {},
        slow: () => new Promise(() => {}),
      });
    });

    clientTransport = createWsClient({ url: `ws://localhost:${port}` });
    clientPeer = createPeer(contract, 'client', { transport: clientTransport, heartbeatInterval: 0, timeout: 5000 });
    clientPeer.implement({
      notify: (_msg: string) => {},
      getStatus: () => 'ok',
    });

    await waitForConnection(clientTransport);
    await waitFor(50);
  });

  afterAll(() => {
    wsServer.close();
  });

  it('client disconnects and pending calls reject with DISCONNECTED', async () => {
    const slowPromise = clientPeer.remote.slow();
    await waitFor(50);
    clientPeer.close();
    try {
      await slowPromise;
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(PeerError);
      expect(err.code).toBe('DISCONNECTED');
    }
  });
});

describe('Middleware', () => {
  const port = 10000 + Math.floor(Math.random() * 50000);
  let wsServer: TransportServer;
  let serverPeer: any;
  let clientPeer: any;
  let clientTransport: Transport;
  const middlewareCalls: { method: string; params: unknown }[] = [];

  beforeAll(async () => {
    wsServer = createWsServer({ port });

    wsServer.onConnection((transport) => {
      serverPeer = createPeer(contract, 'server', { transport, heartbeatInterval: 0 });
      serverPeer.use(async (ctx: MiddlewareContext, next: () => Promise<unknown>) => {
        middlewareCalls.push({ method: ctx.method, params: ctx.params });
        return next();
      });
      serverPeer.implement({
        greet: (name: string) => `Hello, ${name}!`,
        add: ({ a, b }: { a: number; b: number }) => a + b,
        getTime: () => new Date(),
        crash: () => {},
        noArgs: () => {},
        crashPlain: () => {},
        slow: () => new Promise(() => {}),
      });
    });

    clientTransport = createWsClient({ url: `ws://localhost:${port}` });
    clientPeer = createPeer(contract, 'client', { transport: clientTransport, heartbeatInterval: 0 });
    clientPeer.implement({
      notify: (_msg: string) => {},
      getStatus: () => 'ok',
    });

    await waitForConnection(clientTransport);
    await waitFor(50);
  });

  afterAll(() => {
    clientPeer.close();
    wsServer.close();
  });

  it('middleware runs on incoming requests', async () => {
    middlewareCalls.length = 0;
    await clientPeer.remote.greet('test');
    expect(middlewareCalls.length).toBeGreaterThan(0);
  });

  it('middleware sees correct method and params', async () => {
    middlewareCalls.length = 0;
    await clientPeer.remote.add({ a: 5, b: 3 });
    expect(middlewareCalls[0].method).toBe('add');
    expect(middlewareCalls[0].params).toEqual({ a: 5, b: 3 });
  });

  it('middleware can reject a request', async () => {
    const port2 = 10000 + Math.floor(Math.random() * 50000);
    const ws2 = createWsServer({ port: port2 });
    let sp2: any;

    ws2.onConnection((transport) => {
      sp2 = createPeer(contract, 'server', { transport, heartbeatInterval: 0 });
      sp2.use(async (_ctx: MiddlewareContext, _next: () => Promise<unknown>) => {
        throw new PeerError('FORBIDDEN', 'access denied');
      });
      sp2.implement({
        greet: (name: string) => `Hello, ${name}!`,
        add: ({ a, b }: { a: number; b: number }) => a + b,
        getTime: () => new Date(),
        crash: () => {},
        noArgs: () => {},
        crashPlain: () => {},
        slow: () => new Promise(() => {}),
      });
    });

    const ct2 = createWsClient({ url: `ws://localhost:${port2}` });
    const cp2 = createPeer(contract, 'client', { transport: ct2, heartbeatInterval: 0 });
    cp2.implement({
      notify: (_msg: string) => {},
      getStatus: () => 'ok',
    });

    await waitForConnection(ct2);
    await waitFor(50);

    try {
      await cp2.remote.greet('test');
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(PeerError);
      expect(err.code).toBe('FORBIDDEN');
      expect(err.message).toBe('access denied');
    } finally {
      cp2.close();
      ws2.close();
    }
  });
});

describe('Lifecycle events', () => {
  it('emits connect when client connects', async () => {
    const port = 10000 + Math.floor(Math.random() * 50000);
    const ws = createWsServer({ port });
    let serverConnected = false;

    ws.onConnection((transport) => {
      const sp = createPeer(contract, 'server', { transport, heartbeatInterval: 0 });
      sp.on('connect', () => { serverConnected = true; });
      sp.implement({
        greet: (name: string) => `Hello, ${name}!`,
        add: ({ a, b }: { a: number; b: number }) => a + b,
        getTime: () => new Date(),
        crash: () => {},
        noArgs: () => {},
        crashPlain: () => {},
        slow: () => new Promise(() => {}),
      });
    });

    const ct = createWsClient({ url: `ws://localhost:${port}` });
    let clientConnected = false;
    const cp = createPeer(contract, 'client', { transport: ct, heartbeatInterval: 0 });
    cp.on('connect', () => { clientConnected = true; });
    cp.implement({
      notify: (_msg: string) => {},
      getStatus: () => 'ok',
    });

    await waitForConnection(ct);
    await waitFor(50);

    expect(clientConnected).toBe(true);

    cp.close();
    ws.close();
  });

  it('emits disconnect when client disconnects', async () => {
    const port = 10000 + Math.floor(Math.random() * 50000);
    const ws = createWsServer({ port });
    let serverDisconnected = false;

    ws.onConnection((transport) => {
      const sp = createPeer(contract, 'server', { transport, heartbeatInterval: 0 });
      sp.on('disconnect', () => { serverDisconnected = true; });
      sp.implement({
        greet: (name: string) => `Hello, ${name}!`,
        add: ({ a, b }: { a: number; b: number }) => a + b,
        getTime: () => new Date(),
        crash: () => {},
        noArgs: () => {},
        crashPlain: () => {},
        slow: () => new Promise(() => {}),
      });
    });

    const ct = createWsClient({ url: `ws://localhost:${port}` });
    const cp = createPeer(contract, 'client', { transport: ct, heartbeatInterval: 0 });
    cp.implement({
      notify: (_msg: string) => {},
      getStatus: () => 'ok',
    });

    await waitForConnection(ct);
    await waitFor(50);

    cp.close();
    await waitFor(200);

    expect(serverDisconnected).toBe(true);

    ws.close();
  });
});

describe('Multiple clients', () => {
  it('server handles multiple clients independently', async () => {
    const port = 10000 + Math.floor(Math.random() * 50000);
    const ws = createWsServer({ port });
    let clientCount = 0;

    ws.onConnection((transport) => {
      clientCount++;
      const id = clientCount;
      const sp = createPeer(contract, 'server', { transport, heartbeatInterval: 0 });
      sp.implement({
        greet: (name: string) => `Hello from server ${id}, ${name}!`,
        add: ({ a, b }: { a: number; b: number }) => a + b + id,
        getTime: () => new Date(),
        crash: () => {},
        noArgs: () => {},
        crashPlain: () => {},
        slow: () => new Promise(() => {}),
      });
    });

    const ct1 = createWsClient({ url: `ws://localhost:${port}` });
    const cp1 = createPeer(contract, 'client', { transport: ct1, heartbeatInterval: 0 });
    cp1.implement({ notify: (_msg: string) => {}, getStatus: () => 'client1' });

    await waitForConnection(ct1);
    await waitFor(50);

    const ct2 = createWsClient({ url: `ws://localhost:${port}` });
    const cp2 = createPeer(contract, 'client', { transport: ct2, heartbeatInterval: 0 });
    cp2.implement({ notify: (_msg: string) => {}, getStatus: () => 'client2' });

    await waitForConnection(ct2);
    await waitFor(50);

    const r1 = await cp1.remote.greet('Alice');
    const r2 = await cp2.remote.greet('Bob');

    expect(r1).toBe('Hello from server 1, Alice!');
    expect(r2).toBe('Hello from server 2, Bob!');

    const sum1 = await cp1.remote.add({ a: 1, b: 2 });
    const sum2 = await cp2.remote.add({ a: 1, b: 2 });

    expect(sum1).toBe(4);
    expect(sum2).toBe(5);

    cp1.close();
    cp2.close();
    ws.close();
  });
});
