export class PeerError extends Error {
  public code: string;
  public data?: unknown;

  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = 'PeerError';
    this.code = code;
    this.data = data;
  }

  toJSON(): { code: string; message: string; data?: unknown } {
    return { code: this.code, message: this.message, data: this.data };
  }

  static fromJSON(json: { code: string; message: string; data?: unknown }): PeerError {
    return new PeerError(json.code, json.message, json.data);
  }
}
