// MachineConnection: the WebSocket to one Otto desktop. Authenticates, keeps the
// link alive with pings, notices dead links, and reconnects with backoff.

import type { WsInboundFrame, WsOutboundFrame } from '@shared/remote-protocol';
import { wsUrl } from './wire';

export interface ConnectionHandlers {
  onAuthOk(frame: Extract<WsInboundFrame, { type: 'auth_ok' }>): void;
  onFrame(frame: WsInboundFrame): void;
  onDisconnected(): void;
  /** Several reconnects in a row have failed. */
  onUnreachable(): void;
  /** Connected only after switching scheme (http <-> https): the caller should
   *  save the new baseUrl so the next launch doesn't have to fall back again. */
  onBaseUrlChanged?(newBaseUrl: string): void;
}

const PING_EVERY_MS = 20_000;
/** No frame at all for this long after a ping means the link is dead. iOS can
 *  keep a half-open socket "open" after a network change or a sleeping desktop. */
const PONG_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

/** Hosts where a plain-HTTP fallback is acceptable: loopback and Tailscale,
 *  whose traffic WireGuard already encrypts. On a LAN address we never
 *  downgrade a saved https URL, since the token would cross it in clear. */
export function canDowngradeToHttp(baseUrl: string): boolean {
  let host: string;
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { return false; }
  if (host === 'localhost' || host.endsWith('.ts.net')) return true;
  const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 127 || (a === 100 && b >= 64 && b <= 127);
}

/** The other scheme to try after failures, or null when we shouldn't. */
export function alternateBaseUrl(baseUrl: string): string | null {
  if (baseUrl.startsWith('http://')) return 'https://' + baseUrl.slice('http://'.length);
  if (baseUrl.startsWith('https://') && canDowngradeToHttp(baseUrl)) return 'http://' + baseUrl.slice('https://'.length);
  return null;
}

export class MachineConnection {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoff = 1000;
  private failedReconnects = 0;
  private authed = false;
  private destroyed = false;
  /** Base URL in use; may differ from the saved one after a scheme fallback. */
  private baseUrl: string;
  private readonly savedBaseUrl: string;
  /** Once we've authenticated at some scheme, stop trying the other one. */
  private everAuthed = false;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly handlers: ConnectionHandlers,
  ) {
    this.baseUrl = baseUrl;
    this.savedBaseUrl = baseUrl;
  }

  get connected(): boolean {
    return this.authed;
  }

  /** Open a fresh socket, dropping any existing one and any pending retry. */
  connect(): void {
    if (this.destroyed) return;
    this.clearReconnect();
    this.dropSocket();

    const ws = new WebSocket(wsUrl(this.baseUrl));
    this.ws = ws;
    // Every handler checks it still belongs to the current socket: a replaced
    // socket's late close or message must not touch the new one's state.
    ws.onopen = () => {
      if (this.ws !== ws) return;
      ws.send(JSON.stringify({ v: 1, type: 'auth', token: this.token } satisfies WsOutboundFrame));
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.clearPongTimer();
      let frame: WsInboundFrame;
      try {
        frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as WsInboundFrame;
      } catch {
        return;
      }
      if (!frame || typeof frame.type !== 'string') return;
      if (frame.type === 'auth_ok') {
        this.authed = true;
        this.everAuthed = true;
        this.failedReconnects = 0;
        this.backoff = 1000;
        if (this.baseUrl !== this.savedBaseUrl) this.handlers.onBaseUrlChanged?.(this.baseUrl);
        this.startPing();
        this.handlers.onAuthOk(frame);
        return;
      }
      this.handlers.onFrame(frame);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.handleClosed();
    };
    ws.onerror = () => {
      // onclose follows; reconnect logic lives there.
    };
  }

  /** The app came back to the foreground: reconnect now if we're down, or
   *  check a link that looks up, since iOS may have killed it while suspended. */
  resume(): void {
    if (this.destroyed) return;
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.backoff = 1000;
      this.connect();
    } else if (this.authed) {
      this.ping();
    }
  }

  send(msg: WsOutboundFrame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  disconnect(): void {
    this.destroyed = true;
    this.clearReconnect();
    this.dropSocket();
  }

  private handleClosed(): void {
    this.dropSocket();
    this.handlers.onDisconnected();
    this.failedReconnects += 1;
    // Never connected at this scheme: on the 2nd miss in a row try the other
    // one, in case the desktop switched between http and https
    // (OTTO_REMOTE_HTTPS) and the saved URL is stale.
    if (!this.everAuthed && this.failedReconnects >= 2) {
      const alt = alternateBaseUrl(this.baseUrl);
      if (alt) this.baseUrl = alt;
    }
    if (this.failedReconnects >= 3) this.handlers.onUnreachable();
    this.scheduleReconnect();
  }

  /** Detach and close the current socket without firing its handlers. */
  private dropSocket(): void {
    this.stopPing();
    const ws = this.ws;
    this.ws = null;
    this.authed = false;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(); } catch { /* already closed */ }
  }

  private ping(): void {
    if (!this.send({ v: 1, type: 'ping' })) return;
    if (this.pongTimer) return;
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      // Half-open: closing may never fire onclose, so tear down ourselves.
      if (this.ws) this.handleClosed();
    }, PONG_TIMEOUT_MS);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.ping(), PING_EVERY_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearPongTimer();
  }

  private clearPongTimer(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    this.clearReconnect();
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
