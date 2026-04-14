import { describe, it, expect } from 'bun:test';
import { PeerError } from '../src/errors';
import { generateId } from '../src/protocol';
import { serialize, deserialize } from '../src/serialization';
import { runMiddleware, type MiddlewareContext, type MiddlewareFn } from '../src/middleware';

describe('PeerError', () => {
  it('constructs with code, message, data', () => {
    const err = new PeerError('TEST_CODE', 'test message', { detail: 42 });
    expect(err.code).toBe('TEST_CODE');
    expect(err.message).toBe('test message');
    expect(err.data).toEqual({ detail: 42 });
    expect(err.name).toBe('PeerError');
    expect(err).toBeInstanceOf(Error);
  });

  it('toJSON serializes correctly', () => {
    const err = new PeerError('ERR', 'msg', [1, 2]);
    const json = err.toJSON();
    expect(json).toEqual({ code: 'ERR', message: 'msg', data: [1, 2] });
  });

  it('fromJSON reconstructs correctly', () => {
    const err = PeerError.fromJSON({ code: 'X', message: 'y', data: 'z' });
    expect(err).toBeInstanceOf(PeerError);
    expect(err.code).toBe('X');
    expect(err.message).toBe('y');
    expect(err.data).toBe('z');
  });

  it('fromJSON handles missing data', () => {
    const err = PeerError.fromJSON({ code: 'A', message: 'b' });
    expect(err).toBeInstanceOf(PeerError);
    expect(err.code).toBe('A');
    expect(err.message).toBe('b');
    expect(err.data).toBeUndefined();
  });
});

describe('Protocol', () => {
  it('generateId returns unique strings', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateId());
    }
    expect(ids.size).toBe(1000);
  });
});

describe('Serialization', () => {
  it('round-trips strings, numbers, booleans, null', () => {
    expect(deserialize(serialize('hello'))).toBe('hello');
    expect(deserialize(serialize(42))).toBe(42);
    expect(deserialize(serialize(0))).toBe(0);
    expect(deserialize(serialize(-3.14))).toBe(-3.14);
    expect(deserialize(serialize(true))).toBe(true);
    expect(deserialize(serialize(false))).toBe(false);
    expect(deserialize(serialize(null))).toBeNull();
  });

  it('round-trips Date objects', () => {
    const d = new Date('2024-01-15T12:00:00Z');
    const result = deserialize(serialize(d));
    expect(result).toBeInstanceOf(Date);
    expect((result as Date).toISOString()).toBe(d.toISOString());
  });

  it('round-trips nested objects and arrays', () => {
    const obj = { a: [1, { b: 'c' }], d: null, e: true };
    expect(deserialize(serialize(obj))).toEqual(obj);
  });

  it('round-trips Map and Set', () => {
    const map = new Map([['a', 1], ['b', 2]]);
    const resultMap = deserialize(serialize(map)) as Map<string, number>;
    expect(resultMap).toBeInstanceOf(Map);
    expect(resultMap.get('a')).toBe(1);
    expect(resultMap.get('b')).toBe(2);

    const set = new Set([10, 20, 30]);
    const resultSet = deserialize(serialize(set)) as Set<number>;
    expect(resultSet).toBeInstanceOf(Set);
    expect(resultSet.has(10)).toBe(true);
    expect(resultSet.has(20)).toBe(true);
    expect(resultSet.has(30)).toBe(true);
    expect(resultSet.size).toBe(3);
  });
});

describe('Middleware', () => {
  function makeCtx(method = 'test'): MiddlewareContext {
    return { method, params: {}, side: 'server', peer: 'client' };
  }

  it('runs handler when no middlewares', async () => {
    const result = await runMiddleware([], makeCtx(), async () => 'done');
    expect(result).toBe('done');
  });

  it('runs single middleware', async () => {
    const calls: string[] = [];
    const mw: MiddlewareFn = async (_ctx, next) => {
      calls.push('before');
      const r = await next();
      calls.push('after');
      return r;
    };
    const result = await runMiddleware([mw], makeCtx(), async () => {
      calls.push('handler');
      return 'ok';
    });
    expect(calls).toEqual(['before', 'handler', 'after']);
    expect(result).toBe('ok');
  });

  it('runs middlewares in order', async () => {
    const calls: string[] = [];
    const mw1: MiddlewareFn = async (_ctx, next) => {
      calls.push('mw1-before');
      const r = await next();
      calls.push('mw1-after');
      return r;
    };
    const mw2: MiddlewareFn = async (_ctx, next) => {
      calls.push('mw2-before');
      const r = await next();
      calls.push('mw2-after');
      return r;
    };
    await runMiddleware([mw1, mw2], makeCtx(), async () => {
      calls.push('handler');
      return null;
    });
    expect(calls).toEqual(['mw1-before', 'mw2-before', 'handler', 'mw2-after', 'mw1-after']);
  });

  it('middleware can modify result', async () => {
    const mw: MiddlewareFn = async (_ctx, next) => {
      const r = await next();
      return (r as number) * 2;
    };
    const result = await runMiddleware([mw], makeCtx(), async () => 21);
    expect(result).toBe(42);
  });

  it('middleware can short-circuit', async () => {
    let handlerCalled = false;
    const mw: MiddlewareFn = async (_ctx, _next) => {
      return 'short-circuited';
    };
    const result = await runMiddleware([mw], makeCtx(), async () => {
      handlerCalled = true;
      return 'original';
    });
    expect(result).toBe('short-circuited');
    expect(handlerCalled).toBe(false);
  });

  it('rejects if next() called twice', async () => {
    const mw: MiddlewareFn = async (_ctx, next) => {
      await next();
      return next();
    };
    expect(runMiddleware([mw], makeCtx(), async () => 'ok')).rejects.toThrow('next() called multiple times');
  });
});
