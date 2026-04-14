import type { Transport } from './transport/types';
import type { ContractSide, ImplementationOf, RemoteOf, ProcedureDef } from './contract';
import type { MiddlewareFn, MiddlewareContext } from './middleware';
import type { RpcMessage, RpcRequest, RpcResponse } from './protocol';
import { generateId } from './protocol';
import { serialize, deserialize } from './serialization';
import { runMiddleware } from './middleware';
import { PeerError } from './errors';

export interface PeerOptions {
  transport: Transport;
  /** Heartbeat interval in ms. 0 to disable. Default 30000. */
  heartbeatInterval?: number;
  /** Call timeout in ms. Default 15000. */
  timeout?: number;
  /** Queue outgoing calls when disconnected. Default false. */
  queueOnDisconnect?: boolean;
}

export interface PeerInstance<Local extends ContractSide, Remote extends ContractSide> {
  implement(handlers: ImplementationOf<Local>): void;
  remote: RemoteOf<Remote>;
  use(middleware: MiddlewareFn): void;
  on(event: 'connect' | 'disconnect' | 'error', handler: (...args: any[]) => void): void;
  close(): void;
  readonly connected: boolean;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Create an RPC peer bound to one side of a contract. */
export function createPeer<
  C extends Record<string, ContractSide>,
  S extends string & keyof C
>(
  contract: C,
  side: S,
  options: PeerOptions
): PeerInstance<C[S], C[Exclude<keyof C, S>]> {
  const { transport } = options;
  const heartbeatInterval = options.heartbeatInterval ?? 30000;
  const timeout = options.timeout ?? 15000;
  const queueOnDisconnect = options.queueOnDisconnect ?? false;

  const sides = Object.keys(contract);
  const localDef = contract[side];
  const remoteSide = sides.find((s) => s !== (side as string))!;
  const remoteDef = contract[remoteSide];

  const handlers = new Map<string, Function>();
  const pending = new Map<string, PendingCall>();
  const middlewares: MiddlewareFn[] = [];
  const eventListeners = new Map<string, Set<Function>>();
  const queue: string[] = [];

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastPong = Date.now();
  let heartbeatCheckTimer: ReturnType<typeof setInterval> | null = null;
  let _connected = transport.isOpen;

  function emit(event: string, ...args: unknown[]): void {
    const listeners = eventListeners.get(event);
    if (listeners) {
      for (const fn of listeners) {
        fn(...args);
      }
    }
  }

  function sendRaw(data: string): void {
    if (transport.isOpen) {
      transport.send(data);
    } else if (queueOnDisconnect) {
      queue.push(data);
    }
  }

  function flushQueue(): void {
    while (queue.length > 0 && transport.isOpen) {
      transport.send(queue.shift()!);
    }
  }

  function startHeartbeat(): void {
    if (heartbeatInterval <= 0) return;

    lastPong = Date.now();

    heartbeatTimer = setInterval(() => {
      sendRaw(serialize({ type: 'ping' }));
    }, heartbeatInterval);

    heartbeatCheckTimer = setInterval(() => {
      if (Date.now() - lastPong > heartbeatInterval * 2) {
        transport.close();
      }
    }, heartbeatInterval);
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (heartbeatCheckTimer !== null) {
      clearInterval(heartbeatCheckTimer);
      heartbeatCheckTimer = null;
    }
  }

  function clearPending(): void {
    for (const [id, call] of pending) {
      clearTimeout(call.timer);
      call.reject(new PeerError('DISCONNECTED', 'Connection lost'));
    }
    pending.clear();
  }

  async function handleRequest(msg: RpcRequest): Promise<void> {
    const handler = handlers.get(msg.method);

    if (!handler) {
      const response: RpcResponse = {
        id: msg.id,
        type: 'response',
        error: { code: 'METHOD_NOT_FOUND', message: `Method "${msg.method}" not found` },
      };
      sendRaw(serialize(response));
      return;
    }

    const procDef: ProcedureDef | undefined = localDef[msg.method];
    let params = msg.params;

    if (procDef?.input) {
      const result = procDef.input.safeParse(params);
      if (!result.success) {
        const response: RpcResponse = {
          id: msg.id,
          type: 'response',
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Input validation failed',
            data: result.error.issues,
          },
        };
        sendRaw(serialize(response));
        return;
      }
      params = result.data;
    }

    const ctx: MiddlewareContext = {
      method: msg.method,
      params,
      side: side as string,
      peer: remoteSide,
    };

    try {
      const result = await runMiddleware(middlewares, ctx, () => {
        return Promise.resolve(handler(ctx.params));
      });
      const response: RpcResponse = {
        id: msg.id,
        type: 'response',
        result,
      };
      sendRaw(serialize(response));
    } catch (err) {
      const response: RpcResponse = {
        id: msg.id,
        type: 'response',
        error:
          err instanceof PeerError
            ? err.toJSON()
            : {
                code: 'INTERNAL_ERROR',
                message: err instanceof Error ? err.message : String(err),
              },
      };
      sendRaw(serialize(response));
    }
  }

  function handleResponse(msg: RpcResponse): void {
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

  function handleMessage(data: string): void {
    let msg: RpcMessage;
    try {
      msg = deserialize(data) as RpcMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'request':
        handleRequest(msg);
        break;
      case 'response':
        handleResponse(msg);
        break;
      case 'ping':
        sendRaw(serialize({ type: 'pong' }));
        break;
      case 'pong':
        lastPong = Date.now();
        break;
    }
  }

  transport.onMessage(handleMessage);

  transport.onOpen(() => {
    _connected = true;
    lastPong = Date.now();
    startHeartbeat();
    flushQueue();
    emit('connect');
  });

  transport.onClose(() => {
    _connected = false;
    stopHeartbeat();
    clearPending();
    emit('disconnect');
  });

  if (transport.isOpen) {
    startHeartbeat();
  }

  const remote = new Proxy({} as RemoteOf<C[Exclude<keyof C, S>]>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;

      return (input?: unknown) => {
        if (!transport.isOpen && !queueOnDisconnect) {
          return Promise.reject(new PeerError('NOT_CONNECTED', 'Transport is not connected'));
        }

        return new Promise((resolve, reject) => {
          const id = generateId();
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new PeerError('TIMEOUT', `Call to "${prop}" timed out`));
          }, timeout);

          pending.set(id, { resolve, reject, timer });

          const request: RpcRequest = {
            id,
            type: 'request',
            method: prop,
            params: input,
          };

          sendRaw(serialize(request));
        });
      };
    },
  });

  return {
    implement(impl: ImplementationOf<C[S]>): void {
      for (const [method, fn] of Object.entries(impl)) {
        handlers.set(method, fn as Function);
      }
    },

    remote,

    use(middleware: MiddlewareFn): void {
      middlewares.push(middleware);
    },

    on(event: 'connect' | 'disconnect' | 'error', handler: (...args: any[]) => void): void {
      let listeners = eventListeners.get(event);
      if (!listeners) {
        listeners = new Set();
        eventListeners.set(event, listeners);
      }
      listeners.add(handler);
    },

    close(): void {
      stopHeartbeat();
      clearPending();
      transport.close();
    },

    get connected(): boolean {
      return _connected;
    },
  };
}
