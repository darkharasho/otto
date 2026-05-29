// MachineConnection: manages the WebSocket lifecycle for a single Otto desktop.
// Extracted from the PWA's Chat component so it can be used imperatively
// without coupling to React rendering.

import { wsUrl, type WsOutboundFrame } from './wire';

export interface ConnectionHandlers {
  onAuthOk(deviceLabel: string): void;
  onEvent(e: { type: string; [k: string]: unknown }): void;
  onConnected(): void;
  onDisconnected(): void;
  onUnreachable(): void;
}

export class MachineConnection {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = 1000;
  private failedReconnects = 0;
  private _connected = false;
  private destroyed = false;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly handlers: ConnectionHandlers,
  ) {}

  get connected(): boolean {
    return this._connected;
  }

  connect(): void {
    if (this.destroyed) return;
    const url = wsUrl(this.baseUrl);
    const ws = new WebSocket(url);

    ws.onopen = () => {
      ws.send(JSON.stringify({ v: 1, type: 'auth', token: this.token }));
    };

    ws.onmessage = (ev) => {
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (!msg.type) return;

      if (msg.type === 'auth_ok') {
        this._connected = true;
        this.failedReconnects = 0;
        this.backoff = 1000;
        this.handlers.onConnected();
        this.handlers.onAuthOk(typeof msg.deviceLabel === 'string' ? msg.deviceLabel : '');
        this.startPing();
        return;
      }

      this.handlers.onEvent(msg as { type: string; [k: string]: unknown });
    };

    ws.onclose = () => {
      this._connected = false;
      this.handlers.onDisconnected();
      this.stopPing();
      this.failedReconnects += 1;
      if (this.failedReconnects >= 3) {
        this.handlers.onUnreachable();
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose will fire after onerror — reconnect logic lives there.
    };

    this.ws = ws;
  }

  send(msg: WsOutboundFrame): void {
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch {
      // Socket may be closed.
    }
  }

  disconnect(): void {
    this.destroyed = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      // Already closed.
    }
    this.ws = null;
    this._connected = false;
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ v: 1, type: 'ping' });
    }, 20_000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    const delay = Math.min(this.backoff, 30_000);
    this.backoff = Math.min(this.backoff * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      if (!this.destroyed) this.connect();
    }, delay);
  }
}
