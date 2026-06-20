// Wire helpers: thin wrappers around the BridgeServer HTTP+WS surface. The
// server is reached at the same origin the PWA was served from.

import type { ContentBlock } from '@shared/messages';

export type ImageRef = Extract<ContentBlock, { type: 'image-ref' }>;

/** Frames the PWA sends to the bridge server over WS. */
export type WsOutboundFrame =
  | { v: 1; type: 'auth'; token: string }
  | { v: 1; type: 'prompt'; sessionId: string; text: string; attachmentIds?: string[] }
  | { v: 1; type: 'attach'; sessionId: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; bytesBase64: string; clientCorrelationId: string }
  | { v: 1; type: 'approval'; decisionId: string; decision: 'approve' | 'deny' }
  | { v: 1; type: 'sudo'; promptId: string; password: string | null }
  | { v: 1; type: 'interrupt'; sessionId?: string }
  | { v: 1; type: 'ping' }
  | { v: 1; type: 'switch_session'; sessionId: string }
  | { v: 1; type: 'new_session' };

/** Frames the bridge server sends to the PWA over WS. */
export type WsInboundFrame =
  | { v: 1; type: 'auth_ok'; deviceLabel: string }
  | { v: 1; type: 'pong' }
  | { v: 1; type: 'session_switched'; sessionId: string }
  | { v: 1; type: 'attach_ok'; clientCorrelationId: string; ref: ImageRef }
  | { v: 1; type: 'attach_err'; clientCorrelationId: string; message: string }
  | { v: 1; type: string; [k: string]: unknown };

export interface PairResult {
  token: string;
  deviceId: string;
  wsUrl: string;
}

export async function pair(code: string, deviceLabel: string): Promise<PairResult> {
  const res = await fetch('/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceLabel }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`pair failed (${res.status}): ${txt || res.statusText}`);
  }
  return (await res.json()) as PairResult;
}

export interface HistoryEntry {
  seq: number;
  event: unknown;
}

export async function getHistory(token: string, sessionId: string, sinceSeq: number): Promise<{ events: HistoryEntry[]; truncated: boolean }> {
  const url = `/history?session_id=${encodeURIComponent(sessionId)}&since=${sinceSeq}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`history failed (${res.status})`);
  return (await res.json()) as { events: HistoryEntry[]; truncated: boolean };
}

export interface RemoteSessionSummary {
  id: string;
  title: string | null;
  createdAt: number;
  lastActive: number;
  status: string;
}

export async function listSessions(token: string, limit = 50): Promise<{ sessions: RemoteSessionSummary[] }> {
  const res = await fetch(`/sessions?limit=${limit}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`sessions failed (${res.status})`);
  return (await res.json()) as { sessions: RemoteSessionSummary[] };
}

export async function loadMessages(token: string, sessionId: string): Promise<{ messages: Array<Record<string, unknown>> }> {
  const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`messages failed (${res.status})`);
  return (await res.json()) as { messages: Array<Record<string, unknown>> };
}

export interface WsHandlers {
  onAuthOk(d: { deviceLabel: string }): void;
  onEvent(e: { type: string; [k: string]: unknown }): void;
  onClose(): void;
  onError?(err: Event): void;
}

export interface WsHandle {
  send(msg: unknown): void;
  close(): void;
  ws: WebSocket;
}

export function openWs(token: string, handlers: WsHandlers): WsHandle {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${scheme}//${window.location.host}/ws`);

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ v: 1, type: 'auth', token }));
  });

  ws.addEventListener('message', (ev) => {
    let msg: { type?: string; [k: string]: unknown };
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
    if (!msg.type) return;
    if (msg.type === 'auth_ok') {
      handlers.onAuthOk({ deviceLabel: typeof msg.deviceLabel === 'string' ? msg.deviceLabel : '' });
      return;
    }
    handlers.onEvent(msg as { type: string });
  });

  ws.addEventListener('close', () => handlers.onClose());
  ws.addEventListener('error', (err) => handlers.onError?.(err));

  return {
    ws,
    send(msg) { try { ws.send(JSON.stringify(msg)); } catch { /* socket may be closed */ } },
    close() { try { ws.close(); } catch { /* already closed */ } },
  };
}

// Bearer-authed fetch of a signed screenshot URL. Returns an object URL for
// <img src=...>; caller is responsible for revoking it.
export async function fetchScreenshot(token: string, signedUrl: string): Promise<string> {
  const res = await fetch(signedUrl, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`screenshot fetch failed (${res.status})`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
