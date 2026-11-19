// Wire protocol between the remote bridge (src/main/remote/bridge-server.ts)
// and its phone clients: the PWA (src/renderer-remote) and the iOS app
// (otto-mobile, which imports this file through its `@shared/*` path).
// Types only, so it costs the apps nothing at runtime.

import type { ContentBlock } from './messages';
import type { SessionEvent } from './ipc-contract';

export type ImageRef = Extract<ContentBlock, { type: 'image-ref' }>;
export type ImageMimeType = ImageRef['mimeType'];

/** Frames a client sends to the bridge over WS. */
export type WsOutboundFrame =
  | { v: 1; type: 'auth'; token: string }
  | { v: 1; type: 'prompt'; sessionId: string; text: string; attachmentIds?: string[] }
  | { v: 1; type: 'attach'; sessionId: string; mimeType: ImageMimeType; bytesBase64: string; clientCorrelationId: string }
  | { v: 1; type: 'approval'; decisionId: string; decision: 'approve' | 'approve-session' | 'deny' }
  /** `password: null` cancels the prompt. */
  | { v: 1; type: 'sudo'; promptId: string; password: string | null }
  | { v: 1; type: 'interrupt'; sessionId?: string }
  | { v: 1; type: 'ping' }
  | { v: 1; type: 'switch_session'; sessionId: string }
  | { v: 1; type: 'new_session' }
  | { v: 1; type: 'delegate'; text: string; correlationId: string; sessionId?: string; ifBusy?: 'reject' | 'interrupt' };

/**
 * A session event as the bridge forwards it: the desktop's SessionEvent with
 * its `type` moved to `kind`, plus the bus's per-session `seq` (live frames
 * only; events replayed from /history carry their seq on the entry instead).
 */
export type RemoteEventFrame = {
  [K in SessionEvent['type']]: { v?: 1; type: 'event'; kind: K; seq?: number }
    & Omit<Extract<SessionEvent, { type: K }>, 'type'>;
}[SessionEvent['type']];

/** Frames the bridge sends to a client over WS. */
export type WsInboundFrame =
  /** activeSessionId: the conversation open on the desktop (older desktops omit it). */
  | { v: 1; type: 'auth_ok'; deviceLabel: string; activeSessionId?: string | null }
  | { v: 1; type: 'pong' }
  | { v: 1; type: 'session_switched'; sessionId: string }
  | { v: 1; type: 'attach_ok'; clientCorrelationId: string; ref: ImageRef }
  | { v: 1; type: 'attach_err'; clientCorrelationId: string; message: string }
  | { v: 1; type: 'delegate_started'; correlationId: string; sessionId: string }
  | { v: 1; type: 'delegate_busy'; correlationId: string; activeSessionId: string | null }
  | { v: 1; type: 'delegate_err'; correlationId: string; message: string }
  | { v: 1; type: 'error'; code?: string; message: string; fatal?: boolean }
  | RemoteEventFrame;

/** POST /pair response. */
export interface PairResult {
  token: string;
  deviceId: string;
  wsUrl: string;
  hostLabel?: string;
  /** process.platform of the desktop: 'darwin' | 'win32' | 'linux'. */
  platform?: string;
}

/** GET /history entry. */
export interface HistoryEntry {
  seq: number;
  event: unknown;
}

/** GET /sessions entry. */
export interface RemoteSessionSummary {
  id: string;
  title: string | null;
  createdAt: number;
  lastActive: number;
  status: string;
}
