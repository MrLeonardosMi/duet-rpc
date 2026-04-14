export interface RpcRequest {
  id: string;
  type: 'request';
  method: string;
  params: unknown;
}

export interface RpcResponse {
  id: string;
  type: 'response';
  result?: unknown;
  error?: { code: string; message: string; data?: unknown };
}

export interface RpcPing {
  type: 'ping';
}

export interface RpcPong {
  type: 'pong';
}

export type RpcMessage = RpcRequest | RpcResponse | RpcPing | RpcPong;

let counter = 0;

export function generateId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `msg_${++counter}_${Date.now()}`;
  }
}
