import WebSocket, { WebSocketServer } from 'ws';
import type { Transport, TransportServer } from './types.js';

class WsTransport implements Transport {
  private messageHandlers: Set<(data: string) => void> = new Set();
  private closeHandlers: Set<() => void> = new Set();
  private openHandlers: Set<() => void> = new Set();
  private _isOpen: boolean;

  constructor(private ws: WebSocket, alreadyOpen: boolean = false) {
    this._isOpen = alreadyOpen;

    this.ws.on('message', (raw: WebSocket.RawData) => {
      const data = raw.toString();
      for (const handler of this.messageHandlers) {
        handler(data);
      }
    });

    this.ws.on('close', () => {
      this._isOpen = false;
      for (const handler of this.closeHandlers) {
        handler();
      }
    });

    this.ws.on('open', () => {
      this._isOpen = true;
      for (const handler of this.openHandlers) {
        handler();
      }
    });

    this.ws.on('error', () => {
      // errors will trigger close
    });
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  send(data: string): void {
    if (this._isOpen) {
      this.ws.send(data);
    }
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandlers.add(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.add(handler);
  }

  onOpen(handler: () => void): void {
    this.openHandlers.add(handler);
  }

  close(): void {
    this.ws.close();
  }
}

/** Create a WebSocket transport server. */
export function createWsServer(options: { port: number }): TransportServer {
  const wss = new WebSocketServer({ port: options.port });
  let connectionHandler: ((transport: Transport) => void) | null = null;

  wss.on('connection', (ws: WebSocket) => {
    const transport = new WsTransport(ws, true);
    if (connectionHandler) {
      connectionHandler(transport);
    }
  });

  return {
    onConnection(handler: (transport: Transport) => void): void {
      connectionHandler = handler;
    },
    close(): void {
      wss.close();
    },
    get address(): { port: number } {
      const addr = wss.address();
      if (!addr || typeof addr === 'string') {
        return { port: options.port };
      }
      return { port: addr.port };
    },
  };
}

/** Create a WebSocket transport client. */
export function createWsClient(options: { url: string }): Transport {
  const ws = new WebSocket(options.url);
  return new WsTransport(ws, false);
}
