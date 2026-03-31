declare module 'ws' {
  export type RawData = any;
  export class WebSocket {
    static readonly OPEN: number;
    readonly readyState: number;
    send(data: unknown, options?: unknown): void;
    close(code?: number, reason?: string): void;
    on(event: string, listener: (...args: any[]) => void): this;
  }

  export class WebSocketServer {
    readonly clients: Set<WebSocket>;
    constructor(options?: unknown);
    on(event: string, listener: (...args: any[]) => void): this;
    handleUpgrade(
      request: unknown,
      socket: unknown,
      head: unknown,
      callback: (socket: WebSocket) => void
    ): void;
    emit(event: string, ...args: any[]): boolean;
    close(callback?: (error?: Error) => void): void;
  }
}
