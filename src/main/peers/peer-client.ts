import os from 'node:os';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { RemoteEvent } from '@shared/delegation';
import { logger } from '../logger';

export type ConnectionState = 'connected' | 'reconnecting' | 'lost';
export type DelegateResult =
  | { kind: 'started'; sessionId: string }
  | { kind: 'busy'; activeSessionId: string | null };

export interface PeerClientOpts {
  baseUrl: string;
  token: string;
  connectTimeoutMs?: number;
  reconnectWindowMs?: number;
}

export function parsePairingUrl(url: string): { baseUrl: string; code: string } {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error('Not an Otto pairing link'); }
  const code = u.searchParams.get('code');
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !code) throw new Error('Not an Otto pairing link');
  return { baseUrl: u.origin, code };
}

export async function pairWithPeer(baseUrl: string, code: string, deviceLabel: string = `Otto on ${os.hostname()}`): Promise<{ token: string; deviceId: string }> {
  const res = await fetch(`${baseUrl}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceLabel }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`pair failed (${res.status}): ${txt || res.statusText}`);
  }
  const body = (await res.json()) as { token: string; deviceId: string };
  return { token: body.token, deviceId: body.deviceId };
}

const BUS_FRAME_TYPES = new Set(['event', 'approval_pending', 'approval_resolved', 'session_state', 'error']);
const MAX_BUFFERED = 1000;

interface SessionState {
  /** Highest bridge history seq reflected in what we have received. */
  lastSeq: number;
  /** Live frames received since lastSeq was established (live frames carry no seq). */
  liveSinceSeq: number;
  listeners: Set<(e: RemoteEvent) => void>;
  /** Frames received while nobody listens; flushed to the first listener. */
  buffer: RemoteEvent[];
  /** While true, live frames are held instead of delivered (baseline/resync in flight). */
  syncing: boolean;
  held: RemoteEvent[];
}

interface Pending {
  resolve: (r: DelegateResult) => void;
  reject: (e: Error) => void;
}

export class PeerClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly connectTimeoutMs: number;
  private readonly reconnectWindowMs: number;
  private ws: WebSocket | null = null;
  private closed = false;
  private state: ConnectionState | null = null;
  private readonly stateListeners = new Set<(s: ConnectionState) => void>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly pending = new Map<string, Pending>();
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(opts: PeerClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 5000;
    this.reconnectWindowMs = opts.reconnectWindowMs ?? 60_000;
  }

  async connect(): Promise<void> {
    const ws = await this.openSocket();
    this.attach(ws);
    this.setState('connected');
  }

  private openSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.baseUrl.replace(/^http/, 'ws')}/ws`);
      let settled = false;
      const timer = setTimeout(() => fail(new Error('unreachable')), this.connectTimeoutMs);
      timer.unref();
      const done = () => { settled = true; clearTimeout(timer); ws.off('message', onMessage); ws.off('close', onClose); ws.off('error', onError); };
      const fail = (err: Error) => {
        if (settled) return;
        done();
        ws.on('error', () => { /* swallow late errors */ });
        try { ws.terminate(); } catch { /* already gone */ }
        reject(err);
      };
      const onMessage = (data: WebSocket.RawData) => {
        let m: { type?: string };
        try { m = JSON.parse(data.toString()); } catch { return; }
        if (m.type === 'auth_ok' && !settled) { done(); resolve(ws); }
      };
      const onClose = (code: number) => fail(new Error(code === 4001 ? 'unauthorized' : 'unreachable'));
      const onError = () => fail(new Error('unreachable'));
      ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'auth', token: this.token })));
      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.on('error', onError);
    });
  }

  private attach(ws: WebSocket): void {
    this.ws = ws;
    ws.on('message', (data) => this.onMessage(data));
    ws.on('error', () => { /* close follows */ });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed) return;
      this.rejectPending(new Error('connection lost'));
      void this.reconnect();
    });
  }

  private rejectPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private async reconnect(): Promise<void> {
    this.setState('reconnecting');
    const deadline = Date.now() + this.reconnectWindowMs;
    let delay = 200;
    while (!this.closed && Date.now() < deadline) {
      try {
        const ws = await this.openSocket();
        if (this.closed) { ws.terminate(); return; }
        this.attach(ws);
        await this.resyncAll();
        this.setState('connected');
        return;
      } catch (err) {
        if (err instanceof Error && err.message === 'unauthorized') break;
      }
      await this.sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
      delay = Math.min(delay * 1.5, 2000);
    }
    if (!this.closed) this.setState('lost');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; resolve(); }, ms);
      this.reconnectTimer.unref();
    });
  }

  private setState(s: ConnectionState): void {
    if (this.state === s) return;
    const first = this.state === null;
    this.state = s;
    if (first) return; // the initial connect() resolves; nothing to announce
    for (const cb of [...this.stateListeners]) {
      try { cb(s); } catch (err) { logger.warn(`peer-client: state listener threw: ${err}`); }
    }
  }

  private onMessage(data: WebSocket.RawData): void {
    let m: Record<string, unknown> & { type?: string };
    try { m = JSON.parse(data.toString()); } catch { return; }
    const type = m.type;
    if (typeof type !== 'string') return;
    if (type === 'delegate_started' || type === 'delegate_busy' || type === 'delegate_err') {
      const id = m.correlationId as string;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (type === 'delegate_started') p.resolve({ kind: 'started', sessionId: m.sessionId as string });
      else if (type === 'delegate_busy') p.resolve({ kind: 'busy', activeSessionId: (m.activeSessionId as string | null) ?? null });
      else p.reject(new Error(typeof m.message === 'string' ? m.message : 'delegation failed'));
      return;
    }
    if (!BUS_FRAME_TYPES.has(type) || typeof m.sessionId !== 'string') return;
    const st = this.sessions.get(m.sessionId);
    if (!st) return;
    const frame = m as RemoteEvent;
    if (st.syncing) { st.held.push(frame); return; }
    st.liveSinceSeq++;
    this.deliver(st, frame);
  }

  private deliver(st: SessionState, e: RemoteEvent): void {
    if (st.listeners.size === 0) {
      st.buffer.push(e);
      if (st.buffer.length > MAX_BUFFERED) st.buffer.shift();
      return;
    }
    for (const cb of [...st.listeners]) {
      try { cb(e); } catch (err) { logger.warn(`peer-client: event listener threw: ${err}`); }
    }
  }

  private session(sessionId: string): SessionState {
    let st = this.sessions.get(sessionId);
    if (!st) {
      st = { lastSeq: 0, liveSinceSeq: 0, listeners: new Set(), buffer: [], syncing: false, held: [] };
      this.sessions.set(sessionId, st);
    }
    return st;
  }

  private async authedGet<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: { authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error(`${path.split('?')[0]} failed (${res.status})`);
    return (await res.json()) as T;
  }

  private history(sessionId: string, since: number) {
    return this.authedGet<{ events: Array<{ seq: number; event: Record<string, unknown> }>; truncated: boolean }>(
      `/history?session_id=${encodeURIComponent(sessionId)}&since=${since}`,
    );
  }

  /** Establish the seq baseline for a session after delegate_started. */
  private async baseline(sessionId: string): Promise<void> {
    const st = this.session(sessionId);
    st.syncing = true;
    try {
      const h = await this.history(sessionId, 0);
      st.lastSeq = h.events.reduce((mx, e) => Math.max(mx, e.seq), 0);
      st.liveSinceSeq = 0;
      // Frames held before the baseline are already inside it; hand them over once, uncounted.
      for (const e of st.held.splice(0)) this.deliver(st, e);
    } catch (err) {
      logger.warn(`peer-client: baseline history failed: ${err}`);
      for (const e of st.held.splice(0)) { st.liveSinceSeq++; this.deliver(st, e); }
    } finally {
      st.syncing = false;
    }
  }

  private async resyncAll(): Promise<void> {
    for (const [sessionId, st] of this.sessions) {
      try { await this.resync(sessionId, st); } catch (err) { logger.warn(`peer-client: resync ${sessionId} failed: ${err}`); }
    }
  }

  private async resync(sessionId: string, st: SessionState): Promise<void> {
    st.syncing = true;
    try {
      // Live frames delivered so far are an in-order prefix of events after lastSeq.
      let skip = st.liveSinceSeq;
      for (;;) {
        const h = await this.history(sessionId, st.lastSeq);
        if (h.truncated) {
          const { messages } = await this.authedGet<{ messages: unknown[] }>(`/sessions/${encodeURIComponent(sessionId)}/messages`);
          this.deliver(st, { v: 1, sessionId, type: 'event', kind: 'backfill-messages', messages } as RemoteEvent);
          st.lastSeq = h.events.reduce((mx, e) => Math.max(mx, e.seq), st.lastSeq);
          skip = 0;
        } else {
          for (const { seq, event } of h.events) {
            if (skip > 0) skip--;
            else this.deliver(st, { v: 1, sessionId, ...event } as unknown as RemoteEvent);
            st.lastSeq = seq;
          }
        }
        st.liveSinceSeq = 0;
        if (h.events.length === 0) break;
        skip = 0;
      }
      // Held frames arrived during the final empty fetch, so they are newer than anything replayed.
      for (const e of st.held.splice(0)) { st.liveSinceSeq++; this.deliver(st, e); }
    } finally {
      st.syncing = false;
    }
  }

  delegate(args: { text: string; sessionId?: string; ifBusy?: 'reject' | 'interrupt' }): Promise<DelegateResult> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('not connected'));
    const correlationId = randomUUID();
    const result = new Promise<DelegateResult>((resolve, reject) => {
      this.pending.set(correlationId, { resolve, reject });
    });
    ws.send(JSON.stringify({ v: 1, type: 'delegate', text: args.text, correlationId, sessionId: args.sessionId, ifBusy: args.ifBusy }));
    return result.then(async (r) => {
      if (r.kind === 'started') await this.baseline(r.sessionId);
      return r;
    });
  }

  onEvent(sessionId: string, cb: (e: RemoteEvent) => void): () => void {
    const st = this.session(sessionId);
    st.listeners.add(cb);
    if (st.buffer.length > 0) {
      for (const e of st.buffer.splice(0)) {
        try { cb(e); } catch (err) { logger.warn(`peer-client: event listener threw: ${err}`); }
      }
    }
    return () => { st.listeners.delete(cb); };
  }

  onConnectionChange(cb: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(cb);
    return () => { this.stateListeners.delete(cb); };
  }

  decide(decisionId: string, decision: 'approve' | 'approve-session' | 'deny'): void {
    this.send({ v: 1, type: 'approval', decisionId, decision });
  }

  sudo(promptId: string, password: string | null): void {
    this.send({ v: 1, type: 'sudo', promptId, password });
  }

  interrupt(sessionId: string): void {
    this.send({ v: 1, type: 'interrupt', sessionId });
  }

  private send(frame: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(frame)); } catch { /* socket closing; reconnect handles it */ }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this.rejectPending(new Error('closed'));
    const ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(); } catch { /* already closed */ } }
    this.stateListeners.clear();
  }
}
