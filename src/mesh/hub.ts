import { WebSocketServer, WebSocket } from 'ws';
import { serialize, deserialize } from '../serialization';
import type { MeshMessage } from './protocol';

export interface HubOptions {
  port: number;
}

export interface Hub {
  close(): void;
  readonly address: { port: number };
  readonly peers: ReadonlyMap<string, unknown>;
}

/** Create a hub router for star-topology mesh networking. */
export function createHub(options: HubOptions): Hub {
  const wss = new WebSocketServer({ port: options.port });
  const peers = new Map<string, WebSocket>();

  wss.on('connection', (ws: WebSocket) => {
    let peerName: string | null = null;

    ws.on('message', (raw) => {
      let msg: MeshMessage;
      try {
        msg = deserialize(raw.toString()) as MeshMessage;
      } catch {
        return;
      }

      if (msg.type === 'mesh-register') {
        peerName = msg.name;
        peers.set(peerName, ws);
        return;
      }

      if (msg.type === 'ping') {
        ws.send(serialize({ type: 'pong' }));
        return;
      }

      if (msg.type === 'pong') {
        return;
      }

      if (msg.type === 'mesh-request' || msg.type === 'mesh-response') {
        const targetWs = peers.get(msg.target);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
          targetWs.send(raw.toString());
        }
      }
    });

    ws.on('close', () => {
      if (peerName) {
        peers.delete(peerName);
      }
    });
  });

  return {
    close(): void {
      for (const ws of peers.values()) {
        (ws as WebSocket).close();
      }
      wss.close();
    },
    get address(): { port: number } {
      const addr = wss.address();
      if (!addr || typeof addr === 'string') {
        return { port: options.port };
      }
      return { port: addr.port };
    },
    get peers(): ReadonlyMap<string, unknown> {
      return peers;
    },
  };
}
