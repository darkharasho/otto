import { describe, it, expect } from 'vitest';
import { initialSnapshot, reduceDelegation, summarizeForModel, type RemoteEvent } from './delegation';

const ev = (kind: string, extra: Record<string, unknown> = {}): RemoteEvent => ({ type: 'event', kind, sessionId: 'r1', ...extra });
const run = (events: RemoteEvent[]) => events.reduce(reduceDelegation, initialSnapshot('Desk'));

describe('reduceDelegation', () => {
  it('accumulates text deltas and records the session id', () => {
    const s = run([ev('message-start'), ev('text-delta', { text: 'Hel' }), ev('text-delta', { text: 'lo' })]);
    expect(s.items).toEqual([{ kind: 'text', text: 'Hello' }]);
    expect(s.status).toBe('running');
    expect(s.remoteSessionId).toBe('r1');
  });

  it('start/result pair yields one done tool item', () => {
    const s = run([ev('tool-call-start', { callId: 'c1', name: 'shell_exec', input: { command: 'ls' } }), ev('tool-call-result', { callId: 'c1', result: 'ok', isError: false })]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ kind: 'tool', callId: 'c1', status: 'done', result: 'ok' });
  });

  it('marks errored results', () => {
    const s = run([ev('tool-call-start', { callId: 'c1', name: 'x', input: {} }), ev('tool-call-result', { callId: 'c1', result: 'bad', isError: true })]);
    expect(s.items[0]).toMatchObject({ status: 'error' });
  });

  it('truncates long results and replaces images', () => {
    const s = run([
      ev('tool-call-start', { callId: 'c1', name: 'x', input: {} }),
      ev('tool-call-result', { callId: 'c1', result: 'a'.repeat(5000) }),
      ev('tool-call-start', { callId: 'c2', name: 'x', input: {} }),
      ev('tool-call-result', { callId: 'c2', result: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'AAAA' }, { type: 'image-ref', id: 'i' }] }),
    ]);
    const r1 = (s.items[0] as { result: string }).result;
    expect(r1.length).toBe(2000);
    expect(r1.endsWith('…')).toBe(true);
    expect((s.items[1] as { result: string }).result).toBe('hi\n[image]\n[image]');
  });

  it('sets then clears pending approval on tool-call-decided', () => {
    let s = run([ev('tool-call-pending', { decisionId: 'd1', name: 'shell_exec', input: { command: 'rm x' }, actionClass: 'destructive', reason: 'r', catastrophic: true })]);
    expect(s.pendingApproval).toMatchObject({ decisionId: 'd1', actionClass: 'destructive', catastrophic: true });
    s = reduceDelegation(s, ev('tool-call-decided', { decisionId: 'd1', decision: 'approve' }));
    expect(s.pendingApproval).toBeNull();
  });

  it('sets and clears sudo prompt', () => {
    let s = run([ev('sudo-prompt', { callId: 'c', promptId: 'p1', command: 'sudo ls', error: 'bad pw' })]);
    expect(s.pendingSudo).toEqual({ promptId: 'p1', command: 'sudo ls', error: 'bad pw' });
    s = reduceDelegation(s, ev('sudo-resolved', { callId: 'c', status: 'unlocked' }));
    expect(s.pendingSudo).toBeNull();
  });

  it('message-cancelled -> interrupted, and done does not override it', () => {
    let s = run([ev('message-start'), ev('message-cancelled')]);
    expect(s.status).toBe('interrupted');
    s = reduceDelegation(s, ev('done'));
    expect(s.status).toBe('interrupted');
  });

  it('error sets message', () => {
    const s = run([ev('error', { error: { kind: 'x', message: 'boom', retryable: false } })]);
    expect(s).toMatchObject({ status: 'error', error: 'boom' });
  });

  it('done: finalText is the text after the last tool', () => {
    const s = run([
      ev('text-delta', { text: 'before' }),
      ev('tool-call-start', { callId: 'c1', name: 'x', input: {} }),
      ev('tool-call-result', { callId: 'c1', result: 'r' }),
      ev('text-delta', { text: 'all ' }),
      ev('text-delta', { text: 'done' }),
      ev('done'),
    ]);
    expect(s.status).toBe('done');
    expect(s.finalText).toBe('all done');
  });

  it('records denied tools and mentions them in the summary', () => {
    const s = run([ev('tool-call-start', { callId: 'c1', name: 'shell_exec', input: {} }), ev('tool-call-denied', { callId: 'c1', name: 'shell_exec', input: {}, reason: 'no' }), ev('done')]);
    expect(s.items[0]).toMatchObject({ status: 'denied' });
    expect(summarizeForModel(s)).toContain('shell_exec');
  });

  it('ignores user-message echo, unknown kinds and garbage without throwing', () => {
    const s0 = initialSnapshot('Desk');
    const s = [ev('user-message', { text: 'task' }), ev('weird'), { type: 'event' } as RemoteEvent, ev('tool-call-result', { callId: 'nope' }), ev('text-delta', { text: 5 })].reduce(reduceDelegation, s0);
    expect(s.items).toEqual([{ kind: 'text', text: '5' }]);
  });

  it('caps items at 200, dropping oldest', () => {
    const events: RemoteEvent[] = [];
    for (let i = 0; i < 250; i++) events.push(ev('tool-call-start', { callId: `c${i}`, name: 'x', input: {} }));
    const s = run(events);
    expect(s.items).toHaveLength(200);
    expect((s.items[0] as { callId: string }).callId).toBe('c50');
  });

  it('backfill-messages rebuilds items and finalText', () => {
    const s0 = run([ev('text-delta', { text: 'stale' })]);
    const s = reduceDelegation(s0, ev('backfill-messages', {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'task' }] },
        { role: 'assistant', content: [
          { type: 'text', text: 'looking' },
          { type: 'tool_use', callId: 'c1', name: 'shell_exec', input: { command: 'ls' } },
          { type: 'tool_result', callId: 'c1', result: 'files', isError: false },
          { type: 'text', text: 'found it' },
        ] },
      ],
    }));
    expect(s.items.map((i) => i.kind)).toEqual(['text', 'tool', 'text']);
    expect(s.items[1]).toMatchObject({ status: 'done', result: 'files' });
    expect(s.finalText).toBe('found it');
  });
});

describe('summarizeForModel', () => {
  it('has the machine/status prefix and caps at 2000 chars', () => {
    const s = run([ev('text-delta', { text: 'x'.repeat(5000) }), ev('done')]);
    const out = summarizeForModel(s);
    expect(out.startsWith('Desk: done. ')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(2000);
  });
});
