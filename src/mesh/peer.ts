import type { ContractSide, ContractDef, ImplementationOf, RemoteOf, ProcedureDef } from '../contract';
import type { MiddlewareFn, MiddlewareContext } from '../middleware';
import type { Transport } from '../transport/types';
import type { MeshMessage, MeshRequest, MeshResponse } from './protocol';
import { generateId } from '../protocol';
import { serialize, deserialize } from '../serialization';
import { runMiddleware } from '../middleware';
import { PeerError } from '../errors';
import { createWsClient, createWsServer } from '../transport/ws';
import { ReconnectingTransport } from '../reconnect';

export interface MeshHubStrategy {
  strategy: 'hub';
  url: string;
  reconnect?: boolean;
}

export interface MeshDirectStrategy {
  strategy: 'mesh';
  peers: Record<string, string>;
  listen?: { port: number };
  reconnect?: boolean;
}

export type MeshStrategy = MeshHubStrategy | MeshDirectStrategy;

export interface MeshPeerOptions {
  connection: MeshStrategy;
  heartbeatInterval?: number;
  timeout?: number;
}

export interface MeshPeerInstance<C extends ContractDef, S extends string & keyof C> {
  implement(handlers: ImplementationOf<C[S]>): void;
  to<T extends string & Exclude<keyof C, S>>(target: T): RemoteOf<C[T]>;
  use(middleware: MiddlewareFn): void;
  on(event: 'connect' | 'disconnect' | 'error' | 'peer-connect' | 'peer-disconnect', handler: (...args: any[]) => void): void;
  close(): void;
  readonly connected: boolean;
  readonly connectedPeers: string[];
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface MeshCore {
  handlers: Map<string, Function>;
  pending: Map<string, PendingCall>;
  middlewares: MiddlewareFn[];
  eventListeners: Map<string, Set<Function>>;
  emit(event: string, ...args: unknown[]): void;
  handleIncoming(msg: MeshMessage, sendFn: (data: string) => void): void;
  createRemoteProxy<T extends ContractSide>(target: string, sendFn: (data: string) => void): RemoteOf<T>;
}

function createMeshCore(side: string, localDef: ContractSide, options: { timeout: number }): MeshCore {
  const handlers = new Map<string, Function>();
  const pending = new Map<string, PendingCall>();
  const middlewares: MiddlewareFn[] = [];
  const eventListeners = new Map<string, Set<Function>>();

  function emit(event: string, ...args: unknown[]): void {
    const listeners = eventListeners.get(event);
    if (listeners) {
      for (const fn of listeners) {
        fn(...args);
      }
    }
  }

  async function handleRequest(msg: MeshRequest, sendFn: (data: string) => void): Promise<void> {
    const handler = handlers.get(msg.method);

    if (!handler) {
      const response: MeshResponse = {
        id: msg.id,
        type: 'mesh-response',
        source: side,
        target: msg.source,
        error: { code: 'METHOD_NOT_FOUND', message: `Method "${msg.method}" not found` },
      };
      sendFn(serialize(response));
      return;
    }

    const procDef: ProcedureDef | undefined = localDef[msg.method];
    let params = msg.params;

    if (procDef?.input) {
      const result = procDef.input.safeParse(params);
      if (!result.success) {
        const response: MeshResponse = {
          id: msg.id,
          type: 'mesh-response',
          source: side,
          target: msg.source,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Input validation failed',
            data: result.error.issues,
          },
        };
        sendFn(serialize(response));
        return;
      }
      params = result.data;
    }

    const ctx: MiddlewareContext = {
      method: msg.method,
      params,
      side,
      peer: msg.source,
    };

    try {
      const result = await runMiddleware(middlewares, ctx, () => {
        return Promise.resolve(handler(ctx.params));
      });
      const response: MeshResponse = {
        id: msg.id,
        type: 'mesh-response',
        source: side,
        target: msg.source,
        result,
      };
      sendFn(serialize(response));
    } catch (err) {
      const response: MeshResponse = {
        id: msg.id,
        type: 'mesh-response',
        source: side,
        target: msg.source,
        error:
          err instanceof PeerError
            ? err.toJSON()
            : {
                code: 'INTERNAL_ERROR',
                message: err instanceof Error ? err.message : String(err),
              },
      };
      sendFn(serialize(response));
    }
  }

  function handleResponse(msg: MeshResponse): void {
    const call = pending.get(msg.id);
    if (!call) return;

    clearTimeout(call.timer);
    pending.delete(msg.id);

    if (msg.error) {
      call.reject(PeerError.fromJSON(msg.error));
    } else {
      call.resolve(msg.result);
    }
  }

  function handleIncoming(msg: MeshMessage, sendFn: (data: string) => void): void {
    switch (msg.type) {
      case 'mesh-request':
        handleRequest(msg, sendFn);
        break;
      case 'mesh-response':
        handleResponse(msg);
        break;
      case 'ping':
        sendFn(serialize({ type: 'pong' }));
        break;
      case 'pong':
        break;
      case 'mesh-register':
        break;
    }
  }

  function createRemoteProxy<T extends ContractSide>(target: string, sendFn: (data: string) => void): RemoteOf<T> {
    return new Proxy({} as RemoteOf<T>, {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;

        return (input?: unknown) => {
          return new Promise((resolve, reject) => {
            const id = generateId();
            const timer = setTimeout(() => {
              pending.delete(id);
              reject(new PeerError('TIMEOUT', `Call to "${prop}" timed out`));
            }, options.timeout);

            pending.set(id, { resolve, reject, timer });

            const request: MeshRequest = {
              id,
              type: 'mesh-request',
              source: side,
              target,
              method: prop,
              params: input,
            };

            sendFn(serialize(request));
          });
        };
      },
    });
  }

  return {
    handlers,
    pending,
    middlewares,
    eventListeners,
    emit,
    handleIncoming,
    createRemoteProxy,
  };
}

function clearPending(pending: Map<string, PendingCall>): void {
  for (const [, call] of pending) {
    clearTimeout(call.timer);
    call.reject(new PeerError('DISCONNECTED', 'Connection lost'));
  }
  pending.clear();
}

function createTransport(url: string, reconnect: boolean): Transport {
  if (reconnect) {
    return new ReconnectingTransport(() => createWsClient({ url }));
  }
  return createWsClient({ url });
}

/** Create a mesh peer that communicates with N services via hub or direct topology. */
export function createMeshPeer<C extends ContractDef, S extends string & keyof C>(
  contract: C,
  side: S,
  options: MeshPeerOptions
): MeshPeerInstance<C, S> {
  const timeout = options.timeout ?? 15000;
  const heartbeatInterval = options.heartbeatInterval ?? 30000;
  const localDef = contract[side];
  const core = createMeshCore(side as string, localDef, { timeout });

  const transports = new Map<string, Transport>();
  const connectedPeerSet = new Set<string>();
  let _connected = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let server: ReturnType<typeof createWsServer> | null = null;

  function startHeartbeat(transport: Transport): void {
    if (heartbeatInterval <= 0) return;
    if (heartbeatTimer !== null) return;

    heartbeatTimer = setInterval(() => {
      for (const t of transports.values()) {
        if (t.isOpen) {
          t.send(serialize({ type: 'ping' }));
        }
      }
    }, heartbeatInterval);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function wireTransport(transport: Transport, peerName: string | null): void {
    transport.onMessage((data: string) => {
      let msg: MeshMessage;
      try {
        msg = deserialize(data) as MeshMessage;
      } catch {
        return;
      }

      if (msg.type === 'mesh-register' && !peerName) {
        const name = msg.name;
        transports.set(name, transport);
        connectedPeerSet.add(name);
        core.emit('peer-connect', name);
        return;
      }

      const sendFn = (d: string) => {
        if (transport.isOpen) {
          transport.send(d);
        }
      };

      core.handleIncoming(msg, sendFn);
    });

    transport.onOpen(() => {
      _connected = true;
      startHeartbeat(transport);

      transport.send(serialize({ type: 'mesh-register', name: side as string }));

      if (peerName) {
        connectedPeerSet.add(peerName);
        core.emit('peer-connect', peerName);
      }

      core.emit('connect');
    });

    transport.onClose(() => {
      if (peerName) {
        connectedPeerSet.delete(peerName);
        transports.delete(peerName);
        core.emit('peer-disconnect', peerName);
      }

      const anyOpen = Array.from(transports.values()).some((t) => t.isOpen);
      if (!anyOpen) {
        _connected = false;
        stopHeartbeat();
        core.emit('disconnect');
      }
    });

    if (transport.isOpen) {
      _connected = true;
      startHeartbeat(transport);
      transport.send(serialize({ type: 'mesh-register', name: side as string }));
      if (peerName) {
        connectedPeerSet.add(peerName);
      }
    }
  }

  const conn = options.connection;

  if (conn.strategy === 'hub') {
    const transport = createTransport(conn.url, conn.reconnect ?? false);
    transports.set('__hub__', transport);

    transport.onMessage((data: string) => {
      let msg: MeshMessage;
      try {
        msg = deserialize(data) as MeshMessage;
      } catch {
        return;
      }

      const sendFn = (d: string) => {
        if (transport.isOpen) {
          transport.send(d);
        }
      };

      core.handleIncoming(msg, sendFn);
    });

    transport.onOpen(() => {
      _connected = true;
      startHeartbeat(transport);
      transport.send(serialize({ type: 'mesh-register', name: side as string }));
      core.emit('connect');
    });

    transport.onClose(() => {
      _connected = false;
      stopHeartbeat();
      clearPending(core.pending);
      core.emit('disconnect');
    });

    if (transport.isOpen) {
      _connected = true;
      startHeartbeat(transport);
      transport.send(serialize({ type: 'mesh-register', name: side as string }));
    }
  } else {
    if (conn.listen) {
      server = createWsServer({ port: conn.listen.port });
      server.onConnection((transport: Transport) => {
        wireTransport(transport, null);
      });
    }

    for (const [name, url] of Object.entries(conn.peers)) {
      const transport = createTransport(url, conn.reconnect ?? false);
      transports.set(name, transport);
      wireTransport(transport, name);
    }
  }

  return {
    implement(impl: ImplementationOf<C[S]>): void {
      for (const [method, fn] of Object.entries(impl)) {
        core.handlers.set(method, fn as Function);
      }
    },

    to<T extends string & Exclude<keyof C, S>>(target: T): RemoteOf<C[T]> {
      if (conn.strategy === 'hub') {
        const hubTransport = transports.get('__hub__');
        if (!hubTransport || !hubTransport.isOpen) {
          const failProxy = new Proxy({} as RemoteOf<C[T]>, {
            get(_, prop) {
              if (typeof prop !== 'string') return undefined;
              return () => Promise.reject(new PeerError('NOT_CONNECTED', 'Hub transport is not connected'));
            },
          });
          return failProxy;
        }
        const sendFn = (d: string) => {
          if (hubTransport.isOpen) {
            hubTransport.send(d);
          }
        };
        return core.createRemoteProxy<C[T]>(target as string, sendFn);
      }

      const peerTransport = transports.get(target as string);
      if (!peerTransport || !peerTransport.isOpen) {
        const failProxy = new Proxy({} as RemoteOf<C[T]>, {
          get(_, prop) {
            if (typeof prop !== 'string') return undefined;
            return () => Promise.reject(new PeerError('NOT_CONNECTED', `Peer "${target}" is not connected`));
          },
        });
        return failProxy;
      }
      const sendFn = (d: string) => {
        if (peerTransport.isOpen) {
          peerTransport.send(d);
        }
      };
      return core.createRemoteProxy<C[T]>(target as string, sendFn);
    },

    use(middleware: MiddlewareFn): void {
      core.middlewares.push(middleware);
    },

    on(event: 'connect' | 'disconnect' | 'error' | 'peer-connect' | 'peer-disconnect', handler: (...args: any[]) => void): void {
      let listeners = core.eventListeners.get(event);
      if (!listeners) {
        listeners = new Set();
        core.eventListeners.set(event, listeners);
      }
      listeners.add(handler);
    },

    close(): void {
      stopHeartbeat();
      clearPending(core.pending);
      for (const t of transports.values()) {
        t.close();
      }
      transports.clear();
      connectedPeerSet.clear();
      if (server) {
        server.close();
        server = null;
      }
    },

    get connected(): boolean {
      return _connected;
    },

    get connectedPeers(): string[] {
      return Array.from(connectedPeerSet);
    },
  };
}
