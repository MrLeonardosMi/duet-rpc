import { describe, it, expect, afterAll, beforeAll } from 'bun:test';
import { z } from 'zod';
import { createContract, createHub, createMeshPeer, PeerError } from '../src/index';
import type { MiddlewareContext } from '../src/index';

const contract = createContract({
  gateway: {
    authenticate: { input: z.string(), output: z.object({ userId: z.string(), token: z.string() }) },
  },
  users: {
    getUser: { input: z.string(), output: z.object({ id: z.string(), name: z.string() }) },
    ping: { output: z.string() },
  },
  notifications: {
    sendNotification: { input: z.object({ userId: z.string(), message: z.string() }) },
  },
});

function waitFor(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('Hub topology', () => {
  const hubPort = 10000 + Math.floor(Math.random() * 50000);
  let hub: any;
  let gatewayPeer: any;
  let usersPeer: any;
  let notificationsPeer: any;

  beforeAll(async () => {
    hub = createHub({ port: hubPort });

    gatewayPeer = createMeshPeer(contract, 'gateway', {
      connection: { strategy: 'hub', url: `ws://localhost:${hubPort}` },
      heartbeatInterval: 0,
      timeout: 5000,
    });
    gatewayPeer.implement({
      authenticate: (token: string) => ({ userId: 'user-42', token }),
    });

    usersPeer = createMeshPeer(contract, 'users', {
      connection: { strategy: 'hub', url: `ws://localhost:${hubPort}` },
      heartbeatInterval: 0,
      timeout: 5000,
    });
    usersPeer.implement({
      getUser: (id: string) => ({ id, name: `User ${id}` }),
      ping: () => 'pong',
    });

    notificationsPeer = createMeshPeer(contract, 'notifications', {
      connection: { strategy: 'hub', url: `ws://localhost:${hubPort}` },
      heartbeatInterval: 0,
      timeout: 5000,
    });
    notificationsPeer.implement({
      sendNotification: (_payload: { userId: string; message: string }) => {},
    });

    await waitFor(200);
  });

  afterAll(async () => {
    gatewayPeer.close();
    usersPeer.close();
    notificationsPeer.close();
    hub.close();
  });

  it('service A calls service B through hub', async () => {
    const result = await gatewayPeer.to('users').getUser('123');
    expect(result).toEqual({ id: '123', name: 'User 123' });
  });

  it('service B calls service C through hub', async () => {
    await usersPeer.to('notifications').sendNotification({ userId: 'u1', message: 'hello' });
  });

  it('handles method not found on target', async () => {
    try {
      await (gatewayPeer.to('users') as any).nonexistent();
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(PeerError);
      expect(err.code).toBe('METHOD_NOT_FOUND');
    }
  });

  it('handles validation errors', async () => {
    try {
      await (gatewayPeer.to('users') as any).getUser(999);
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(PeerError);
      expect(err.code).toBe('VALIDATION_ERROR');
    }
  });

  it('handles target service not connected', async () => {
    const isolatedHubPort = 10000 + Math.floor(Math.random() * 50000);
    const isolatedHub: any = createHub({ port: isolatedHubPort });

    const isolatedPeer: any = createMeshPeer(contract, 'gateway', {
      connection: { strategy: 'hub', url: `ws://localhost:${isolatedHubPort}` },
      heartbeatInterval: 0,
      timeout: 500,
    });
    isolatedPeer.implement({
      authenticate: (token: string) => ({ userId: 'x', token }),
    });
    await waitFor(200);
    try {
      await isolatedPeer.to('users').getUser('no-such-service');
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(PeerError);
      const validCodes = ['NOT_CONNECTED', 'TIMEOUT'];
      expect(validCodes).toContain(err.code);
    } finally {
      isolatedPeer.close();
      isolatedHub.close();
    }
  });

  it('multiple concurrent cross-service calls', async () => {
    const results = await Promise.all([
      gatewayPeer.to('users').getUser('1'),
      gatewayPeer.to('users').getUser('2'),
      gatewayPeer.to('users').ping(),
      gatewayPeer.to('users').getUser('3'),
    ]);
    expect(results[0]).toEqual({ id: '1', name: 'User 1' });
    expect(results[1]).toEqual({ id: '2', name: 'User 2' });
    expect(results[2]).toBe('pong');
    expect(results[3]).toEqual({ id: '3', name: 'User 3' });
  });

  it('handler can throw PeerError', async () => {
    const throwingPeer: any = createMeshPeer(contract, 'gateway', {
      connection: { strategy: 'hub', url: `ws://localhost:${hubPort}` },
      heartbeatInterval: 0,
      timeout: 5000,
    });
    throwingPeer.implement({
      authenticate: (_token: string) => { throw new PeerError('AUTH_FAILED', 'invalid token'); },
    });

    const callerPeer: any = createMeshPeer(contract, 'users', {
      connection: { strategy: 'hub', url: `ws://localhost:${hubPort}` },
      heartbeatInterval: 0,
      timeout: 5000,
    });
    callerPeer.implement({
      getUser: (id: string) => ({ id, name: 'x' }),
      ping: () => 'pong',
    });

    await waitFor(200);

    try {
      await callerPeer.to('gateway').authenticate('bad-token');
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(PeerError);
      expect(err.code).toBe('AUTH_FAILED');
      expect(err.message).toBe('invalid token');
    } finally {
      throwingPeer.close();
      callerPeer.close();
    }
  });
});

describe('Mesh topology', () => {
  it('direct call between two services', async () => {
    const portA = 10000 + Math.floor(Math.random() * 50000);
    const portB = 10000 + Math.floor(Math.random() * 50000);

    const peerA: any = createMeshPeer(contract, 'gateway', {
      connection: {
        strategy: 'mesh',
        listen: { port: portA },
        peers: { users: `ws://localhost:${portB}` },
      },
      heartbeatInterval: 0,
      timeout: 5000,
    });
    peerA.implement({
      authenticate: (token: string) => ({ userId: 'u1', token }),
    });

    const peerB: any = createMeshPeer(contract, 'users', {
      connection: {
        strategy: 'mesh',
        listen: { port: portB },
        peers: { gateway: `ws://localhost:${portA}` },
      },
      heartbeatInterval: 0,
      timeout: 5000,
    });
    peerB.implement({
      getUser: (id: string) => ({ id, name: `Direct ${id}` }),
      ping: () => 'pong-direct',
    });

    await waitFor(200);

    try {
      const result = await peerA.to('users').getUser('abc');
      expect(result).toEqual({ id: 'abc', name: 'Direct abc' });
    } finally {
      peerA.close();
      peerB.close();
    }
  });

  it('bidirectional direct calls', async () => {
    const portA = 10000 + Math.floor(Math.random() * 50000);
    const portB = 10000 + Math.floor(Math.random() * 50000);

    const peerA: any = createMeshPeer(contract, 'gateway', {
      connection: {
        strategy: 'mesh',
        listen: { port: portA },
        peers: { users: `ws://localhost:${portB}` },
      },
      heartbeatInterval: 0,
      timeout: 5000,
    });
    peerA.implement({
      authenticate: (token: string) => ({ userId: 'user-from-a', token }),
    });

    const peerB: any = createMeshPeer(contract, 'users', {
      connection: {
        strategy: 'mesh',
        listen: { port: portB },
        peers: { gateway: `ws://localhost:${portA}` },
      },
      heartbeatInterval: 0,
      timeout: 5000,
    });
    peerB.implement({
      getUser: (id: string) => ({ id, name: `Bidir ${id}` }),
      ping: () => 'pong-bidir',
    });

    await waitFor(200);

    try {
      const [resultFromA, resultFromB] = await Promise.all([
        peerA.to('users').getUser('x'),
        peerB.to('gateway').authenticate('tok'),
      ]);
      expect(resultFromA).toEqual({ id: 'x', name: 'Bidir x' });
      expect(resultFromB).toEqual({ userId: 'user-from-a', token: 'tok' });
    } finally {
      peerA.close();
      peerB.close();
    }
  });
});

describe('Mesh middleware', () => {
  it('middleware runs on incoming mesh requests', async () => {
    const hubPort = 10000 + Math.floor(Math.random() * 50000);
    const hub: any = createHub({ port: hubPort });
    const calls: string[] = [];

    const serverPeer: any = createMeshPeer(contract, 'users', {
      connection: { strategy: 'hub', url: `ws://localhost:${hubPort}` },
      heartbeatInterval: 0,
      timeout: 5000,
    });
    serverPeer.use(async (ctx: MiddlewareContext, next: () => Promise<unknown>) => {
      calls.push(ctx.method);
      return next();
    });
    serverPeer.implement({
      getUser: (id: string) => ({ id, name: `MW ${id}` }),
      ping: () => 'pong',
    });

    const clientPeer: any = createMeshPeer(contract, 'gateway', {
      connection: { strategy: 'hub', url: `ws://localhost:${hubPort}` },
      heartbeatInterval: 0,
      timeout: 5000,
    });
    clientPeer.implement({
      authenticate: (token: string) => ({ userId: 'u', token }),
    });

    await waitFor(200);

    try {
      await clientPeer.to('users').getUser('mw-test');
      expect(calls.length).toBeGreaterThan(0);
      expect(calls).toContain('getUser');
    } finally {
      serverPeer.close();
      clientPeer.close();
      hub.close();
    }
  });

  it('middleware can reject mesh requests', async () => {
    const hubPort = 10000 + Math.floor(Math.random() * 50000);
    const hub: any = createHub({ port: hubPort });

    const serverPeer: any = createMeshPeer(contract, 'users', {
      connection: { strategy: 'hub', url: `ws://localhost:${hubPort}` },
      heartbeatInterval: 0,
      timeout: 5000,
    });
    serverPeer.use(async (_ctx: MiddlewareContext, _next: () => Promise<unknown>) => {
      throw new PeerError('FORBIDDEN', 'access denied');
    });
    serverPeer.implement({
      getUser: (id: string) => ({ id, name: 'x' }),
      ping: () => 'pong',
    });

    const clientPeer: any = createMeshPeer(contract, 'gateway', {
      connection: { strategy: 'hub', url: `ws://localhost:${hubPort}` },
      heartbeatInterval: 0,
      timeout: 5000,
    });
    clientPeer.implement({
      authenticate: (token: string) => ({ userId: 'u', token }),
    });

    await waitFor(200);

    try {
      await clientPeer.to('users').getUser('blocked');
      throw new Error('should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(PeerError);
      expect(err.code).toBe('FORBIDDEN');
      expect(err.message).toBe('access denied');
    } finally {
      serverPeer.close();
      clientPeer.close();
      hub.close();
    }
  });
});
