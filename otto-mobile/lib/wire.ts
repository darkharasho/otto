// HTTP side of the bridge protocol, for a desktop at `baseUrl`
// (e.g. "http://100.64.0.1:17829"). Frame and payload types are shared with
// the desktop in src/shared/remote-protocol.ts.

import type { HistoryEntry, ImageRef, PairResult, RemoteSessionSummary } from '@shared/remote-protocol';
import type { Message } from '@shared/messages';

export type { ImageRef, ImageMimeType, PairResult, RemoteSessionSummary, WsInboundFrame, WsOutboundFrame } from '@shared/remote-protocol';

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

/** Events published for `sessionId` after `sinceSeq`. `truncated` means some
 *  were already dropped from the desktop's buffer: reload the transcript. */
export async function getHistory(baseUrl: string, token: string, sessionId: string, sinceSeq: number): Promise<{ events: HistoryEntry[]; truncated: boolean }> {
  const url = `${baseUrl}/history?session_id=${encodeURIComponent(sessionId)}&since=${sinceSeq}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`history failed (${res.status})`);
  return (await res.json()) as { events: HistoryEntry[]; truncated: boolean };
}

export async function listSessions(baseUrl: string, token: string, limit = 50): Promise<{ sessions: RemoteSessionSummary[] }> {
  const res = await fetch(`${baseUrl}/sessions?limit=${limit}`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`sessions failed (${res.status})`);
  return (await res.json()) as { sessions: RemoteSessionSummary[] };
}

/** The saved transcript, plus the session's latest event seq when it was read
 *  (older desktops omit it). */
export async function loadMessages(baseUrl: string, token: string, sessionId: string): Promise<{ messages: Message[]; seq?: number }> {
  const res = await fetch(`${baseUrl}/sessions/${encodeURIComponent(sessionId)}/messages`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`messages failed (${res.status})`);
  return (await res.json()) as { messages: Message[]; seq?: number };
}

const EXT: Record<ImageRef['mimeType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** An image the user attached. Fetch it with authHeaders(token). */
export function userUploadUrl(baseUrl: string, ref: ImageRef): string {
  return `${baseUrl}/user-upload/${encodeURIComponent(ref.sessionId)}/${encodeURIComponent(ref.id)}.${EXT[ref.mimeType]}`;
}

export function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export function wsUrl(baseUrl: string): string {
  return baseUrl.replace(/^http/, 'ws') + '/ws';
}

/** Parse a QR/pairing URL into the desktop's base URL and the pairing code. */
export function parsePairingUrl(input: string): { baseUrl: string; code: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get('code');
    if (!code) return null;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return { baseUrl: `${url.protocol}//${url.host}`, code };
  } catch {
    return null;
  }
}
