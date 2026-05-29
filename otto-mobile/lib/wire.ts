// Wire helpers: host-parameterized version of renderer-remote/wire.ts.
// Every function takes a `baseUrl` (e.g. "http://100.64.0.1:17829") instead
// of using the browser's same-origin.

import type { ImageRef } from './types';

/** Frames the app sends to the bridge server over WS. */
export type WsOutboundFrame =
  | { v: 1; type: 'auth'; token: string }
  | { v: 1; type: 'prompt'; sessionId: string; text: string; attachmentIds?: string[] }
  | { v: 1; type: 'attach'; sessionId: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; bytesBase64: string; clientCorrelationId: string }
  | { v: 1; type: 'approval'; decisionId: string; decision: 'approve' | 'deny' }
  | { v: 1; type: 'interrupt'; sessionId?: string }
  | { v: 1; type: 'ping' }
  | { v: 1; type: 'switch_session'; sessionId: string }
  | { v: 1; type: 'new_session' };

/** Frames the bridge server sends to the app over WS. */
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
  hostLabel?: string;
  /** 'darwin' | 'win32' | 'linux' etc. */
  platform?: string;
}

export async function pair(baseUrl: string, code: string, deviceLabel: string): Promise<PairResult> {
  const res = await fetch(`${baseUrl}/pair`, {
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

export async function getHistory(baseUrl: string, token: string, sessionId: string, sinceSeq: number): Promise<{ events: HistoryEntry[]; truncated: boolean }> {
  const url = `${baseUrl}/history?session_id=${encodeURIComponent(sessionId)}&since=${sinceSeq}`;
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

export async function listSessions(baseUrl: string, token: string, limit = 50): Promise<{ sessions: RemoteSessionSummary[] }> {
  const res = await fetch(`${baseUrl}/sessions?limit=${limit}`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`sessions failed (${res.status})`);
  return (await res.json()) as { sessions: RemoteSessionSummary[] };
}

export async function loadMessages(baseUrl: string, token: string, sessionId: string): Promise<{ messages: Array<Record<string, unknown>> }> {
  const res = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/messages`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`messages failed (${res.status})`);
  return (await res.json()) as { messages: Array<Record<string, unknown>> };
}

/** Returns the full URL for a screenshot, ready for <Image source={{uri}}> */
export function screenshotUrl(baseUrl: string, token: string, signedPath: string): string {
  // signedPath is relative, e.g. "/screenshot/abc?...sig=..."
  return `${baseUrl}${signedPath}`;
}

/** Returns the full URL for a user-uploaded image */
export function userUploadUrl(baseUrl: string, token: string, sessionId: string, fileId: string, ext: string): string {
  return `${baseUrl}/user-upload/${sessionId}/${fileId}.${ext}?token=${encodeURIComponent(token)}`;
}

/** Returns headers needed for authenticated image fetches */
export function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** Build a WebSocket URL from a base HTTP URL */
export function wsUrl(baseUrl: string): string {
  return baseUrl.replace(/^http/, 'ws') + '/ws';
}

/** Parse a QR/pairing URL into host base URL and code */
export function parsePairingUrl(input: string): { baseUrl: string; code: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get('code');
    if (!code) return null;
    const baseUrl = `${url.protocol}//${url.host}`;
    return { baseUrl, code };
  } catch {
    return null;
  }
}
