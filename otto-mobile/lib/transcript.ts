// The chat screen's state as a pure reducer over bridge frames, so it can be
// tested without React Native. The screen owns I/O (socket, fetches, timers)
// and feeds the results in as actions.
//
// Sync model: every event the desktop publishes for a session has a seq. Live
// frames carry it; /history replays it. We remember the last seq applied and
// ignore anything at or below it, so a reconnect replays only what was missed.
// A saved transcript (/sessions/:id/messages) only holds finished messages, so
// loading one also replays the event buffer for the turn still in progress.

import type { ContentBlock, Message } from '@shared/messages';
import type { HistoryEntry, ImageRef, RemoteEventFrame, WsInboundFrame } from '@shared/remote-protocol';
import { summarizeInput } from '@shared/tool-presenters';

export type ToolStatus = 'pending' | 'resolved' | 'denied';
export type OutcomeBlock = Extract<ContentBlock, { type: 'outcome' }>;

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string; images: ImageRef[] }
  | { kind: 'text'; id: string; text: string; done: boolean }
  | { kind: 'reasoning'; id: string; text: string; done: boolean }
  | {
      kind: 'tool'; id: string; callId: string; name: string; input: unknown; status: ToolStatus;
      result?: unknown; isError?: boolean; deniedReason?: string;
      /** Live stdout/stderr while it runs; the final result replaces it. */
      output?: string;
      takeaway?: string; why?: string;
    }
  | { kind: 'outcome'; id: string; block: OutcomeBlock }
  | { kind: 'notice'; id: string; text: string };

export interface PendingApproval {
  decisionId: string;
  callId: string;
  tool: string;
  actionClass: string;
  summary: string;
  reason: string;
  /** Denylisted command: the desktop only allows approving it there. */
  catastrophic: boolean;
}

export interface SudoPrompt {
  promptId: string;
  callId: string;
  command: string;
  /** Set on a retry after a wrong password. */
  error?: string;
}

export interface TranscriptState {
  sessionId: string | null;
  lastSeq: number;
  /** Set when the screen should (re)load the session's transcript. */
  needsLoad: boolean;
  items: TranscriptItem[];
  approvals: PendingApproval[];
  sudos: SudoPrompt[];
  /** Turns started (message-start) and not yet done. */
  openTurns: number;
  queueDepth: number;
  /** A prompt was sent and nothing has come back yet. */
  awaitingReply: boolean;
  error: string | null;
  /** Ids of the open streaming text/reasoning bubbles, if any. */
  textId: string | null;
  reasoningId: string | null;
  /** Counter for locally made item ids. */
  n: number;
}

export type TranscriptAction =
  | { type: 'frame'; frame: WsInboundFrame }
  /** Events missed while disconnected, from /history. */
  | { type: 'replay'; entries: HistoryEntry[] }
  /** Show `sessionId` (from auth_ok, session_switched or the drawer); loads it. */
  | { type: 'open'; sessionId: string }
  /** The saved transcript plus the event buffer, for the open session. */
  | { type: 'loaded'; sessionId: string; messages: Message[]; seq?: number; entries: HistoryEntry[] }
  | { type: 'sent' }
  | { type: 'reply-timeout' }
  | { type: 'approval-answered'; decisionId: string }
  | { type: 'sudo-answered'; promptId: string }
  | { type: 'error'; message: string }
  | { type: 'dismiss-error' };

export const initialTranscript: TranscriptState = {
  sessionId: null,
  lastSeq: 0,
  needsLoad: false,
  items: [],
  approvals: [],
  sudos: [],
  openTurns: 0,
  queueDepth: 0,
  awaitingReply: false,
  error: null,
  textId: null,
  reasoningId: null,
  n: 0,
};

export function isBusy(s: TranscriptState): boolean {
  return s.openTurns > 0 || s.awaitingReply || s.queueDepth > 0;
}

export function transcriptReducer(s: TranscriptState, a: TranscriptAction): TranscriptState {
  switch (a.type) {
    case 'frame':
      return applyFrame(s, a.frame);
    case 'replay': {
      let next = s;
      for (const e of a.entries) {
        if (e.seq <= next.lastSeq) continue;
        const ev = asEvent(e.event);
        next = { ...(ev ? applyEvent(next, ev) : next), lastSeq: e.seq };
      }
      return next;
    }
    case 'open':
      return { ...initialTranscript, sessionId: a.sessionId, needsLoad: true, n: s.n };
    case 'loaded': {
      if (a.sessionId !== s.sessionId) return s;
      let next: TranscriptState = {
        ...initialTranscript,
        sessionId: s.sessionId,
        items: itemsFromMessages(a.messages),
        n: s.n,
        // Keep a prompt the user sent while this was loading.
        awaitingReply: s.awaitingReply,
      };
      // Rebuild the turn in progress from the buffer: skip events for messages
      // the transcript already has, and older events that belong to no message.
      const saved = new Set(a.messages.map((m) => m.id));
      const snapshot = a.seq ?? Infinity;
      for (const e of a.entries) {
        const ev = asEvent(e.event);
        if (ev && !(e.seq <= snapshot && isCovered(ev, saved))) next = applyEvent(next, ev);
        next = { ...next, lastSeq: Math.max(next.lastSeq, e.seq) };
      }
      return next;
    }
    case 'sent':
      return { ...s, awaitingReply: true, error: null };
    case 'reply-timeout':
      return s.awaitingReply ? { ...s, awaitingReply: false, error: 'No response from Otto. Try again.' } : s;
    case 'approval-answered':
      return { ...s, approvals: s.approvals.filter((p) => p.decisionId !== a.decisionId) };
    case 'sudo-answered':
      return { ...s, sudos: s.sudos.filter((p) => p.promptId !== a.promptId) };
    case 'error':
      return { ...s, error: a.message };
    case 'dismiss-error':
      return { ...s, error: null };
  }
}

function applyFrame(s: TranscriptState, f: WsInboundFrame): TranscriptState {
  switch (f.type) {
    case 'session_switched':
      return f.sessionId === s.sessionId ? s : transcriptReducer(s, { type: 'open', sessionId: f.sessionId });
    case 'error':
      // Bridge-level failure (e.g. the desktop couldn't start the turn).
      return { ...s, awaitingReply: false, openTurns: 0, error: f.message || 'Something went wrong.' };
    case 'event': {
      if (s.sessionId !== f.sessionId) {
        // The desktop moved to another conversation (prompts always run in the
        // desktop's active one): follow it. The load replays this event.
        return transcriptReducer(s, { type: 'open', sessionId: f.sessionId });
      }
      if (typeof f.seq === 'number') {
        if (f.seq <= s.lastSeq) return s;
        return { ...applyEvent(s, f), lastSeq: f.seq };
      }
      return applyEvent(s, f);
    }
    default:
      return s;
  }
}

function asEvent(e: unknown): RemoteEventFrame | null {
  return e && typeof e === 'object' && (e as { type?: unknown }).type === 'event' ? (e as RemoteEventFrame) : null;
}

/** Whether a buffered event is already reflected in the saved transcript. */
function isCovered(ev: RemoteEventFrame, saved: Set<string>): boolean {
  if ('noteId' in ev && saved.has(ev.noteId)) return true;
  if ('messageId' in ev) return saved.has(ev.messageId);
  return true; // done, error, steer-promoted: only matter live
}

function nextId(s: TranscriptState, prefix: string): [string, TranscriptState] {
  return [`${prefix}-${s.n}`, { ...s, n: s.n + 1 }];
}

/** Close the open streaming bubbles so what comes next starts a new one. */
function closeBubbles(s: TranscriptState): TranscriptState {
  if (!s.textId && !s.reasoningId) return s;
  return {
    ...s,
    textId: null,
    reasoningId: null,
    items: s.items.map((it) => (it.kind === 'text' || it.kind === 'reasoning') && !it.done ? { ...it, done: true } : it),
  };
}

function updateTool(s: TranscriptState, callId: string, patch: (it: Extract<TranscriptItem, { kind: 'tool' }>) => Partial<Extract<TranscriptItem, { kind: 'tool' }>>): TranscriptState {
  return {
    ...s,
    items: s.items.map((it) => it.kind === 'tool' && it.callId === callId ? { ...it, ...patch(it) } : it),
  };
}

function appendStreaming(s: TranscriptState, kind: 'text' | 'reasoning', text: string): TranscriptState {
  const openId = kind === 'text' ? s.textId : s.reasoningId;
  const idx = openId ? s.items.findIndex((it) => it.id === openId) : -1;
  if (idx !== -1) {
    const items = s.items.slice();
    const it = items[idx] as Extract<TranscriptItem, { kind: 'text' | 'reasoning' }>;
    items[idx] = { ...it, text: it.text + text };
    return { ...s, items };
  }
  // Reasoning comes before the text it explains: a new reasoning bubble closes the text one.
  const base = kind === 'reasoning' ? closeBubbles(s) : { ...s, reasoningId: null, items: s.items.map((it) => it.kind === 'reasoning' && !it.done ? { ...it, done: true } : it) };
  const [id, t] = nextId(base, kind);
  return {
    ...t,
    items: [...t.items, { kind, id, text, done: false }],
    ...(kind === 'text' ? { textId: id } : { reasoningId: id }),
  };
}

function imagesOf(content: ContentBlock[] | undefined): ImageRef[] {
  return (content ?? []).filter((b): b is ImageRef => b.type === 'image-ref');
}

function addUser(s: TranscriptState, id: string, text: string, content: ContentBlock[] | undefined): TranscriptState {
  if (s.items.some((it) => it.id === id)) return s;
  return { ...s, items: [...s.items, { kind: 'user', id, text, images: imagesOf(content) }] };
}

function textOf(m: Message): string {
  return m.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('');
}

function applyEvent(s0: TranscriptState, ev: RemoteEventFrame): TranscriptState {
  const s = s0.awaitingReply ? { ...s0, awaitingReply: false } : s0;
  switch (ev.kind) {
    case 'user-message':
      return addUser(s, ev.messageId, ev.text, ev.content);
    case 'steer-queued': {
      // Sent mid-turn; it folds into the running turn. What Otto says next goes below it.
      const closed = closeBubbles(s);
      return addUser({ ...closed, items: closed.items.filter((it) => !(it.kind === 'text' && !it.text)) }, ev.noteId, ev.text, ev.content);
    }
    case 'steer-promoted':
      // The note missed its turn; a user-message with the same id follows.
      return { ...s, items: s.items.filter((it) => it.id !== ev.noteId) };
    case 'steer-folded':
      return s;
    case 'user-message-queued':
    case 'user-message-consumed':
      return { ...s, queueDepth: ev.queueDepth };
    case 'message-start':
      return { ...closeBubbles(s), openTurns: s.openTurns + 1 };
    case 'text-delta':
      return appendStreaming(s, 'text', ev.text);
    case 'reasoning':
      return appendStreaming(s, 'reasoning', ev.text);
    case 'tool-call-start': {
      const closed = closeBubbles(s);
      if (closed.items.some((it) => it.kind === 'tool' && it.callId === ev.callId)) return closed;
      return { ...closed, items: [...closed.items, { kind: 'tool', id: `tool-${ev.callId}`, callId: ev.callId, name: ev.name, input: ev.input, status: 'pending' }] };
    }
    case 'tool-call-output':
      return updateTool(s, ev.callId, (it) => ({ output: ((it.output ?? '') + ev.data).slice(-4000) }));
    case 'tool-call-result':
      return updateTool(s, ev.callId, () => ({ status: 'resolved', result: ev.result, isError: ev.isError, output: undefined }));
    case 'tool-result-annotated':
      return updateTool(s, ev.callId, () => ({ takeaway: ev.takeaway, why: ev.why }));
    case 'tool-call-denied':
      return {
        ...updateTool(s, ev.callId, () => ({ status: 'denied', deniedReason: ev.reason })),
        approvals: s.approvals.filter((p) => p.callId !== ev.callId),
      };
    case 'tool-call-pending': {
      if (s.approvals.some((p) => p.decisionId === ev.decisionId)) return s;
      const approval: PendingApproval = {
        decisionId: ev.decisionId,
        callId: ev.callId,
        tool: ev.name,
        actionClass: ev.actionClass,
        summary: summarizeInput(ev.name, ev.input) ?? '',
        reason: ev.reason,
        catastrophic: Boolean(ev.catastrophic),
      };
      return { ...s, approvals: [...s.approvals, approval] };
    }
    case 'tool-call-decided':
      return { ...s, approvals: s.approvals.filter((p) => p.decisionId !== ev.decisionId) };
    case 'sudo-prompt': {
      // A retry after a wrong password comes with a new promptId for the same call.
      const others = s.sudos.filter((p) => p.callId !== ev.callId);
      return { ...s, sudos: [...others, { promptId: ev.promptId, callId: ev.callId, command: ev.command, error: ev.error }] };
    }
    case 'sudo-resolved':
      return { ...s, sudos: s.sudos.filter((p) => p.callId !== ev.callId) };
    case 'outcome': {
      const [id, t] = nextId(closeBubbles(s), 'outcome');
      return { ...t, items: [...t.items, { kind: 'outcome', id, block: ev.block }] };
    }
    case 'system-message': {
      const text = textOf(ev.message);
      if (!text || s.items.some((it) => it.id === ev.message.id)) return s;
      return { ...s, items: [...s.items, { kind: 'notice', id: ev.message.id, text }] };
    }
    case 'message-end':
    case 'message-cancelled':
      return closeBubbles(s);
    case 'done': {
      // One done per turn; a queued turn whose message-start already came stays open.
      const closed = closeBubbles(s);
      return { ...closed, openTurns: Math.max(0, s.openTurns - 1) };
    }
    case 'error':
      return { ...closeBubbles(s), openTurns: 0, awaitingReply: false, error: ev.error.message };
    case 'tool-call-snapshot':
    case 'process-spawned':
    case 'process-stdout':
    case 'process-stderr':
    case 'process-exited':
    case 'process-killed':
      return s;
    default:
      return s;
  }
}

/** Rebuild transcript items from saved messages. */
export function itemsFromMessages(messages: Message[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  const tools = new Map<string, number>();
  const patchTool = (callId: string, patch: Partial<Extract<TranscriptItem, { kind: 'tool' }>>) => {
    const idx = tools.get(callId);
    if (idx === undefined) return;
    out[idx] = { ...(out[idx] as Extract<TranscriptItem, { kind: 'tool' }>), ...patch };
  };
  for (const m of messages) {
    if (m.role === 'user') {
      const text = textOf(m);
      const images = imagesOf(m.content);
      if (text || images.length > 0) out.push({ kind: 'user', id: m.id, text, images });
      continue;
    }
    if (m.role === 'system') {
      const text = textOf(m);
      if (text) out.push({ kind: 'notice', id: m.id, text });
      continue;
    }
    let buf = '';
    let part = 0;
    const flush = () => {
      if (buf) out.push({ kind: 'text', id: `${m.id}-t${part++}`, text: buf, done: true });
      buf = '';
    };
    for (const b of m.content) {
      switch (b.type) {
        case 'text':
          buf += b.text;
          break;
        case 'thinking':
          flush();
          if (b.text) out.push({ kind: 'reasoning', id: `${m.id}-r${part++}`, text: b.text, done: true });
          break;
        case 'tool_use':
          flush();
          if (!tools.has(b.callId)) {
            tools.set(b.callId, out.length);
            out.push({ kind: 'tool', id: `tool-${b.callId}`, callId: b.callId, name: b.name, input: b.input, status: 'pending' });
          }
          break;
        case 'tool_result':
          patchTool(b.callId, { status: 'resolved', result: b.result, isError: Boolean(b.isError), takeaway: b.takeaway, why: b.why });
          break;
        case 'tool_denied':
          if (!tools.has(b.callId)) {
            flush();
            tools.set(b.callId, out.length);
            out.push({ kind: 'tool', id: `tool-${b.callId}`, callId: b.callId, name: b.name, input: b.input, status: 'denied', deniedReason: b.reason });
          } else {
            patchTool(b.callId, { status: 'denied', deniedReason: b.reason });
          }
          break;
        case 'pending_tool_use':
          if (b.decision === 'denied') patchTool(b.callId, { status: 'denied', deniedReason: b.reason });
          break;
        case 'user_note':
          flush();
          out.push({ kind: 'user', id: b.id, text: b.text, images: imagesOf(b.content) });
          break;
        case 'outcome':
          flush();
          out.push({ kind: 'outcome', id: `${m.id}-o${part++}`, block: b });
          break;
        default:
          break;
      }
    }
    flush();
  }
  // A call whose result never got saved (cancelled turn) isn't still running.
  return out.map((it) => it.kind === 'tool' && it.status === 'pending' ? { ...it, status: 'resolved' } : it);
}
