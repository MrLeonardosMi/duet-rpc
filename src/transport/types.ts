export interface Transport {
  send(data: string): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  onOpen(handler: () => void): void;
  close(): void;
  readonly isOpen: boolean;
}

export interface TransportServer {
  onConnection(handler: (transport: Transport) => void): void;
  close(): void;
  readonly address: { port: number };
}
