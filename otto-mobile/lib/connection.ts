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
  /** Called after a successful auth on a scheme that differs from the one
   *  the connection was constructed with — lets the caller persist the new
   *  baseUrl so future launches skip the fallback dance. */
  onBaseUrlChanged?(newBaseUrl: string): void;
}

function swapScheme(baseUrl: string): string {
  if (baseUrl.startsWith('https://')) return 'http://' + baseUrl.slice('https://'.length);
  if (baseUrl.startsWith('http://')) return 'https://' + baseUrl.slice('http://'.length);
  return baseUrl;
}

export class MachineConnection {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = 1000;
  private failedReconnects = 0;
  private _connected = false;
  private destroyed = false;
  /** Current effective base URL; may flip schemes after repeated failures. */
  private effectiveBaseUrl: string;
  /** Original scheme of the saved baseUrl; used to detect when we've swapped
   *  and should notify the caller to persist the new value. */
  private readonly originalBaseUrl: string;
  /** Set true once we've auth_ok'd at any scheme during this connection's
   *  lifetime. Used to gate the scheme-swap fallback. */
  private everAuthed = false;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly handlers: ConnectionHandlers,
  ) {
    this.effectiveBaseUrl = baseUrl;
    this.originalBaseUrl = baseUrl;
  }

  get connected(): boolean {
    return this._connected;
  }

  connect(): void {
    if (this.destroyed) return;
    const url = wsUrl(this.effectiveBaseUrl);
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
        this.everAuthed = true;
        if (this.effectiveBaseUrl !== this.originalBaseUrl) {
          this.handlers.onBaseUrlChanged?.(this.effectiveBaseUrl);
        }
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
      // If we've never succeeded at the current scheme, try the other one
      // on the next reconnect. Covers the case where the bridge flipped
      // between http and https (e.g. user toggled OTTO_REMOTE_HTTPS) and
      // the saved baseUrl is now stale. Flip on the 2nd consecutive miss
      // so a transient blip doesn't whiplash the scheme.
      if (!this.everAuthed && this.failedReconnects >= 2) {
        this.effectiveBaseUrl = swapScheme(this.effectiveBaseUrl);
      }
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
