import type { Transport } from './transport/types.js';

export interface ReconnectOptions {
  /** Base interval in ms (default 1000) */
  interval?: number;
  /** Max backoff interval in ms (default 30000) */
  maxInterval?: number;
  /** Max reconnect attempts (default Infinity) */
  maxAttempts?: number;
  /** Backoff multiplier (default 2) */
  factor?: number;
}

/** A transport wrapper that automatically reconnects on close. */
export class ReconnectingTransport implements Transport {
  private inner: Transport | null = null;
  private messageHandlers: Set<(data: string) => void> = new Set();
  private closeHandlers: Set<() => void> = new Set();
  private openHandlers: Set<() => void> = new Set();
  private stopped = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private interval: number;
  private maxInterval: number;
  private maxAttempts: number;
  private factor: number;

  constructor(
    private factory: () => Transport,
    options?: ReconnectOptions
  ) {
    this.interval = options?.interval ?? 1000;
    this.maxInterval = options?.maxInterval ?? 30000;
    this.maxAttempts = options?.maxAttempts ?? Infinity;
    this.factor = options?.factor ?? 2;
    this.connect();
  }

  get isOpen(): boolean {
    return this.inner?.isOpen ?? false;
  }

  send(data: string): void {
    if (this.inner?.isOpen) {
      this.inner.send(data);
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
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.inner?.close();
  }

  /** Stop reconnection without closing the underlying transport. */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;

    this.inner = this.factory();
    this.attachHandlers(this.inner);
  }

  private attachHandlers(transport: Transport): void {
    transport.onMessage((data) => {
      for (const handler of this.messageHandlers) {
        handler(data);
      }
    });

    transport.onOpen(() => {
      this.attempts = 0;
      for (const handler of this.openHandlers) {
        handler();
      }
    });

    transport.onClose(() => {
      for (const handler of this.closeHandlers) {
        handler();
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.attempts >= this.maxAttempts) return;

    const delay = Math.min(
      this.interval * Math.pow(this.factor, this.attempts),
      this.maxInterval
    );
    this.attempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
