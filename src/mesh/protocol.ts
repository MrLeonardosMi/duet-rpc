export interface MeshRequest {
  id: string;
  type: 'mesh-request';
  source: string;
  target: string;
  method: string;
  params: unknown;
}

export interface MeshResponse {
  id: string;
  type: 'mesh-response';
  source: string;
  target: string;
  result?: unknown;
  error?: { code: string; message: string; data?: unknown };
}

export interface MeshRegister {
  type: 'mesh-register';
  name: string;
}

export type MeshMessage =
  | MeshRequest
  | MeshResponse
  | MeshRegister
  | { type: 'ping' }
  | { type: 'pong' };
