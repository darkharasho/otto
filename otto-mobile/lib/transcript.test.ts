import { describe, it, expect } from 'vitest';
import type { Message } from '@shared/messages';
import type { RemoteEventFrame, WsInboundFrame } from '@shared/remote-protocol';
import { initialTranscript, isBusy, itemsFromMessages, transcriptReducer as r, type TranscriptState } from './transcript';

const SID = 's1';
type EventBody = RemoteEventFrame extends infer F ? F extends RemoteEventFrame ? Omit<F, 'type' | 'v' | 'sessionId' | 'seq'> : never : never;

function ev(body: EventBody, seq?: number, sessionId = SID): WsInboundFrame {
  return { v: 1, type: 'event', sessionId, ...(seq === undefined ? {} : { seq }), ...body } as WsInboundFrame;
}
function frames(s: TranscriptState, ...fs: WsInboundFrame[]): TranscriptState {
  return fs.reduce((acc, frame) => r(acc, { type: 'frame', frame }), s);
}
function opened(): TranscriptState {
  return r(r(initialTranscript, { type: 'open', sessionId: SID }), { type: 'loaded', sessionId: SID, messages: [], seq: 0, entries: [] });
}
function texts(s: TranscriptState): string[] {
  return s.items.flatMap((it) => it.kind === 'text' ? [it.text] : []);
}

const turn = [
  ev({ kind: 'message-start', messageId: 'a1' }, 1),
  ev({ kind: 'text-delta', messageId: 'a1', text: 'Hel' }, 2),
  ev({ kind: 'text-delta', messageId: 'a1', text: 'lo' }, 3),
  ev({ kind: 'tool-call-start', messageId: 'a1', callId: 'c1', name: 'shell_exec', input: { command: 'ls' } }, 4),
  ev({ kind: 'tool-call-result', messageId: 'a1', callId: 'c1', result: 'ok', isError: false }, 5),
  ev({ kind: 'message-end', messageId: 'a1' }, 6),
  ev({ kind: 'done' }, 7),
];

describe('transcriptReducer: live events', () => {
  it('builds a turn from deltas and tool calls', () => {
    const s = frames(opened(), ...turn);
    expect(texts(s)).toEqual(['Hello']);
    expect(s.items.find((it) => it.kind === 'tool')).toMatchObject({ callId: 'c1', status: 'resolved', result: 'ok' });
    expect(s.lastSeq).toBe(7);
    expect(isBusy(s)).toBe(false);
  });

  it('ignores frames at or below the last seq (no duplicates when a replay overlaps)', () => {
    const once = frames(opened(), ...turn);
    const twice = frames(once, ...turn);
    expect(twice.items).toEqual(once.items);
    const replayed = r(once, { type: 'replay', entries: turn.map((f, i) => ({ seq: i + 1, event: f })) });
    expect(replayed.items).toEqual(once.items);
  });

  it('a reconnect replay applies only what was missed', () => {
    const partial = frames(opened(), ...turn.slice(0, 3));
    const caughtUp = r(partial, { type: 'replay', entries: turn.map((f, i) => ({ seq: i + 1, event: f })) });
    expect(caughtUp).toEqual(frames(opened(), ...turn));
  });

  it('stays busy while a queued turn is still open', () => {
    let s = frames(opened(), ev({ kind: 'message-start', messageId: 'a1' }, 1), ev({ kind: 'message-start', messageId: 'a2' }, 2));
    s = frames(s, ev({ kind: 'done' }, 3));
    expect(isBusy(s)).toBe(true);
    s = frames(s, ev({ kind: 'done' }, 4));
    expect(isBusy(s)).toBe(false);
  });

  it('shows agent errors and ends the turn', () => {
    const s = frames(opened(), ev({ kind: 'message-start', messageId: 'a1' }, 1),
      ev({ kind: 'error', error: { kind: 'rate-limit', message: 'Rate limited', retryable: true } }, 2));
    expect(s.error).toBe('Rate limited');
    expect(isBusy(s)).toBe(false);
  });

  it('shows bridge errors and clears a pending send', () => {
    const s = frames(r(opened(), { type: 'sent' }), { v: 1, type: 'error', code: 'send-failed', message: 'no model' });
    expect(s.error).toBe('no model');
    expect(s.awaitingReply).toBe(false);
  });

  it('keeps reasoning separate from the reply text', () => {
    const s = frames(opened(),
      ev({ kind: 'message-start', messageId: 'a1' }, 1),
      ev({ kind: 'reasoning', messageId: 'a1', text: 'thinking' }, 2),
      ev({ kind: 'text-delta', messageId: 'a1', text: 'answer' }, 3));
    expect(s.items.map((it) => it.kind)).toEqual(['reasoning', 'text']);
    expect(s.items[0]).toMatchObject({ text: 'thinking', done: true });
  });

  it('tracks approvals with their reason and catastrophic flag', () => {
    let s = frames(opened(), ev({ kind: 'tool-call-pending', messageId: 'a1', callId: 'c1', decisionId: 'd1', name: 'shell_exec', input: { command: 'rm -rf /tmp/x' }, actionClass: 'destructive', reason: 'deletes files', catastrophic: true }, 1));
    expect(s.approvals).toEqual([expect.objectContaining({ decisionId: 'd1', reason: 'deletes files', catastrophic: true })]);
    s = frames(s, ev({ kind: 'tool-call-decided', messageId: 'a1', callId: 'c1', decisionId: 'd1', decision: 'approve' }, 2));
    expect(s.approvals).toEqual([]);
  });

  it('replaces a sudo prompt on retry and clears it when resolved', () => {
    let s = frames(opened(), ev({ kind: 'sudo-prompt', messageId: 'a1', callId: 'c1', promptId: 'p1', command: 'apt update' }, 1));
    s = frames(s, ev({ kind: 'sudo-prompt', messageId: 'a1', callId: 'c1', promptId: 'p2', command: 'apt update', error: 'wrong password' }, 2));
    expect(s.sudos).toEqual([{ promptId: 'p2', callId: 'c1', command: 'apt update', error: 'wrong password' }]);
    s = frames(s, ev({ kind: 'sudo-resolved', messageId: 'a1', callId: 'c1', status: 'unlocked' }, 3));
    expect(s.sudos).toEqual([]);
  });

  it('drops a promoted steer note', () => {
    let s = frames(opened(), ev({ kind: 'steer-queued', messageId: 'a1', noteId: 'n1', text: 'also x', content: [] }, 1));
    expect(s.items.map((it) => it.id)).toEqual(['n1']);
    s = frames(s, ev({ kind: 'steer-promoted', noteId: 'n1' }, 2));
    expect(s.items).toEqual([]);
  });

  it('follows the desktop to another session and asks to load it', () => {
    const s = frames(frames(opened(), ...turn), ev({ kind: 'message-start', messageId: 'b1' }, 1, 's2'));
    expect(s.sessionId).toBe('s2');
    expect(s.needsLoad).toBe(true);
    expect(s.items).toEqual([]);
    expect(s.lastSeq).toBe(0);
  });

  it('times out a send nothing answered, but not one that was answered', () => {
    const sent = r(opened(), { type: 'sent' });
    expect(r(sent, { type: 'reply-timeout' }).error).toMatch(/No response/);
    const answered = frames(sent, turn[0]!);
    expect(r(answered, { type: 'reply-timeout' }).error).toBeNull();
  });
});

describe('transcriptReducer: loading a session', () => {
  const saved: Message[] = [
    { id: 'u1', sessionId: SID, seq: 1, createdAt: 1, role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { id: 'a1', sessionId: SID, seq: 2, createdAt: 2, role: 'assistant', cancelled: false, errored: false, content: [{ type: 'text', text: 'Hello' }] },
  ];

  it('replays the in-progress turn on top of the saved transcript, without repeating saved ones', () => {
    const entries = [
      { seq: 1, event: ev({ kind: 'user-message', messageId: 'u1', text: 'hi' }) },
      { seq: 2, event: ev({ kind: 'message-start', messageId: 'a1' }) },
      { seq: 3, event: ev({ kind: 'text-delta', messageId: 'a1', text: 'Hello' }) },
      { seq: 4, event: ev({ kind: 'done' }) },
      { seq: 5, event: ev({ kind: 'user-message', messageId: 'u2', text: 'more' }) },
      { seq: 6, event: ev({ kind: 'message-start', messageId: 'a2' }) },
      { seq: 7, event: ev({ kind: 'text-delta', messageId: 'a2', text: 'Work' }) },
    ];
    const s = r(r(initialTranscript, { type: 'open', sessionId: SID }), { type: 'loaded', sessionId: SID, messages: saved, seq: 6, entries });
    expect(s.items.map((it) => it.kind === 'user' || it.kind === 'text' ? it.text : it.kind)).toEqual(['hi', 'Hello', 'more', 'Work']);
    expect(s.lastSeq).toBe(7);
    expect(isBusy(s)).toBe(true);
    expect(s.needsLoad).toBe(false);
  });

  it('ignores a load for a session that is no longer open', () => {
    const s = r(initialTranscript, { type: 'open', sessionId: 's2' });
    expect(r(s, { type: 'loaded', sessionId: SID, messages: saved, entries: [] })).toBe(s);
  });
});

describe('itemsFromMessages', () => {
  it('rebuilds tools, denials, reasoning, notes and outcomes', () => {
    const items = itemsFromMessages([
      {
        id: 'a1', sessionId: SID, seq: 1, createdAt: 1, role: 'assistant', cancelled: false, errored: false,
        content: [
          { type: 'thinking', text: 'plan' },
          { type: 'tool_use', callId: 'c1', name: 'shell_exec', input: {} },
          { type: 'tool_result', callId: 'c1', result: 'ok', takeaway: 'fine' },
          { type: 'tool_use', callId: 'c2', name: 'shell_exec', input: {} },
          { type: 'pending_tool_use', callId: 'c2', decisionId: 'd', name: 'shell_exec', input: {}, actionClass: 'destructive', reason: 'r', decision: 'denied' },
          { type: 'tool_use', callId: 'c3', name: 'read_file', input: {} },
          { type: 'user_note', id: 'n1', text: 'also', content: [] },
          { type: 'text', text: 'Done' },
          { type: 'outcome', title: 'Fixed', durationMs: 1, toolCalls: 3 },
        ],
      },
    ]);
    expect(items.map((it) => it.kind)).toEqual(['reasoning', 'tool', 'tool', 'tool', 'user', 'text', 'outcome']);
    expect(items[1]).toMatchObject({ status: 'resolved', takeaway: 'fine' });
    expect(items[2]).toMatchObject({ status: 'denied' });
    expect(items[3]).toMatchObject({ status: 'resolved' }); // never got a result: not "running" forever
  });
});
