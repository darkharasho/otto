import { describe, it, expect, beforeEach } from 'vitest';
import { useOttoStore, canProactivelyReset, type ActiveSessionState } from './store';

beforeEach(() => {
  useOttoStore.getState().reset();
});

describe('useOttoStore', () => {
  it('starts in bar mode with no active session', () => {
    const s = useOttoStore.getState();
    expect(s.windowMode).toBe('bar');
    expect(s.activeSession).toBeNull();
  });

  it('transitions to panel mode', () => {
    useOttoStore.getState().setWindowMode('panel');
    expect(useOttoStore.getState().windowMode).toBe('panel');
  });

  it('begins a new active session with empty messages', () => {
    useOttoStore.getState().beginSession('s1');
    expect(useOttoStore.getState().activeSession).toEqual({
      id: 's1',
      messages: [],
      currentTurnActive: false,
      queueDepth: 0,
      error: null,
    });
  });

  it('marks the active session private when beginSession opts.private is true', () => {
    useOttoStore.getState().beginSession('p1', { private: true });
    expect(useOttoStore.getState().activeSession?.private).toBe(true);
  });

  it('begins a non-private session by default', () => {
    useOttoStore.getState().beginSession('s2');
    expect(useOttoStore.getState().activeSession?.private).toBeFalsy();
  });

  it('handles message-start by appending an empty assistant placeholder', () => {
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().applyEvent({
      type: 'message-start',
      sessionId: 's1',
      messageId: 'm1',
    });
    const a = useOttoStore.getState().activeSession!;
    expect(a.currentTurnActive).toBe(true);
    expect(a.messages).toHaveLength(1);
    expect(a.messages[0]).toMatchObject({ id: 'm1', role: 'assistant', content: [] });
  });

  it('appends text deltas to the active assistant message', () => {
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().applyEvent({ type: 'message-start', sessionId: 's1', messageId: 'm1' });
    useOttoStore.getState().applyEvent({ type: 'text-delta', sessionId: 's1', messageId: 'm1', text: 'he' });
    useOttoStore.getState().applyEvent({ type: 'text-delta', sessionId: 's1', messageId: 'm1', text: 'llo' });
    const a = useOttoStore.getState().activeSession!;
    expect(a.messages[0]!.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('appends tool_use and tool_result blocks', () => {
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().applyEvent({ type: 'message-start', sessionId: 's1', messageId: 'm1' });
    useOttoStore.getState().applyEvent({
      type: 'tool-call-start',
      sessionId: 's1',
      messageId: 'm1',
      callId: 'c1',
      name: 'echo',
      input: { msg: 'hi' },
    });
    useOttoStore.getState().applyEvent({
      type: 'tool-call-result',
      sessionId: 's1',
      messageId: 'm1',
      callId: 'c1',
      result: 'hi',
      isError: false,
    });
    const a = useOttoStore.getState().activeSession!;
    expect(a.messages[0]!.content).toEqual([
      { type: 'tool_use', callId: 'c1', name: 'echo', input: { msg: 'hi' } },
      { type: 'tool_result', callId: 'c1', result: 'hi', isError: false },
    ]);
  });

  it('strips inline base64 image data from tool results before storing', () => {
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().applyEvent({ type: 'message-start', sessionId: 's1', messageId: 'm1' });
    useOttoStore.getState().applyEvent({
      type: 'tool-call-result',
      sessionId: 's1',
      messageId: 'm1',
      callId: 'c1',
      result: {
        content: [
          { type: 'image', data: 'A'.repeat(4096), mimeType: 'image/jpeg' },
          { type: 'text', text: 'meta' },
        ],
      },
      isError: false,
    });
    const block = useOttoStore.getState().activeSession!.messages[0]!.content[0] as {
      result: { content: Array<{ type: string; data?: string; text?: string }> };
    };
    expect(block.result.content[0]!.data).toBe('');
    expect(block.result.content[1]!.text).toBe('meta');
  });

  it('strips inline base64 from tool results when loading a legacy session', () => {
    useOttoStore.getState().loadSession('s9', [
      {
        id: 'm1',
        sessionId: 's9',
        seq: 0,
        createdAt: 1,
        role: 'assistant',
        status: 'complete',
        content: [
          {
            type: 'tool_result',
            callId: 'c1',
            result: { content: [{ type: 'image', data: 'B'.repeat(4096), mimeType: 'image/jpeg' }] },
            isError: false,
          },
        ],
      } as never,
    ]);
    const block = useOttoStore.getState().activeSession!.messages[0]!.content[0] as {
      result: { content: Array<{ data?: string }> };
    };
    expect(block.result.content[0]!.data).toBe('');
  });

  it('records errors and clears them on next send', () => {
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().applyEvent({
      type: 'error',
      sessionId: 's1',
      error: { kind: 'sdk-stream', message: 'boom', retryable: true },
    });
    expect(useOttoStore.getState().activeSession!.error?.message).toBe('boom');
    useOttoStore.getState().appendUserMessage('m2', 'retry');
    expect(useOttoStore.getState().activeSession!.error).toBeNull();
  });

  it('appends a user message immediately on send', () => {
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().appendUserMessage('m1', 'hello');
    const a = useOttoStore.getState().activeSession!;
    expect(a.messages).toHaveLength(1);
    expect(a.messages[0]).toMatchObject({ role: 'user' });
    expect(a.messages[0]!.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('marks currentTurnActive false on done', () => {
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().applyEvent({ type: 'message-start', sessionId: 's1', messageId: 'm1' });
    useOttoStore.getState().applyEvent({ type: 'done', sessionId: 's1' });
    expect(useOttoStore.getState().activeSession!.currentTurnActive).toBe(false);
  });

  it('dedupes backend user-message against an optimistic message with image attachments', () => {
    const s = useOttoStore.getState();
    s.beginSession('s1');
    s.appendUserMessage('opt-1', 'hello', [
      { type: 'image-ref', id: 'img1', sessionId: 's1', path: '/tmp/x.png', width: 10, height: 10, mimeType: 'image/png', source: 'user' },
    ]);
    s.applyEvent({
      type: 'user-message',
      sessionId: 's1',
      messageId: 'backend-1',
      text: 'hello',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image-ref', id: 'img1', sessionId: 's1', path: '/tmp/x.png', width: 10, height: 10, mimeType: 'image/png', source: 'user' },
      ],
    });
    expect(useOttoStore.getState().activeSession!.messages).toHaveLength(1);
  });

  it('tracks queueDepth across queued and consumed events', () => {
    const s = useOttoStore.getState();
    s.beginSession('sess');
    s.applyEvent({ type: 'user-message-queued', sessionId: 'sess', messageId: 'm1', queueDepth: 1 });
    s.applyEvent({ type: 'user-message-queued', sessionId: 'sess', messageId: 'm2', queueDepth: 2 });
    expect(useOttoStore.getState().activeSession?.queueDepth).toBe(2);
    s.applyEvent({ type: 'user-message-consumed', sessionId: 'sess', messageId: 'm1', queueDepth: 1 });
    expect(useOttoStore.getState().activeSession?.queueDepth).toBe(1);
  });
});

describe('autonomy mode state', () => {
  it('defaults to balanced', () => {
    expect(useOttoStore.getState().mode).toBe('balanced');
  });

  it('setMode updates the mode', () => {
    useOttoStore.getState().setMode('strict');
    expect(useOttoStore.getState().mode).toBe('strict');
  });
});

describe('store: tool approval events', () => {
  beforeEach(() => {
    useOttoStore.getState().reset();
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().applyEvent({
      type: 'message-start',
      sessionId: 's1',
      messageId: 'm1',
    });
  });

  it('handles tool-call-pending by appending a pending_tool_use block', () => {
    useOttoStore.getState().applyEvent({
      type: 'tool-call-pending',
      sessionId: 's1',
      messageId: 'm1',
      callId: 'c1',
      decisionId: 'd1',
      name: 'fake-mutate',
      input: { target: 'x' },
      actionClass: 'destructive',
      reason: 'mode=balanced',
    });
    const blocks = useOttoStore.getState().activeSession!.messages[0]!.content;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'pending_tool_use',
      callId: 'c1',
      decisionId: 'd1',
      decision: 'pending',
      actionClass: 'destructive',
    });
  });

  it('propagates the catastrophic flag onto the pending block', () => {
    useOttoStore.getState().applyEvent({
      type: 'tool-call-pending',
      sessionId: 's1',
      messageId: 'm1',
      callId: 'c1',
      decisionId: 'd1',
      name: 'shell_exec',
      input: { command: 'mkfs.ext4 /dev/sda1' },
      actionClass: 'irreversible',
      reason: 'catastrophic=mkfs, mode=full-allow',
      catastrophic: true,
    });
    const blocks = useOttoStore.getState().activeSession!.messages[0]!.content;
    expect(blocks[0]).toMatchObject({ type: 'pending_tool_use', catastrophic: true });
  });

  it('transforms pending block on tool-call-decided approve', () => {
    useOttoStore.getState().applyEvent({
      type: 'tool-call-pending',
      sessionId: 's1',
      messageId: 'm1',
      callId: 'c1',
      decisionId: 'd1',
      name: 'fake-mutate',
      input: { target: 'x' },
      actionClass: 'destructive',
      reason: 'mode=balanced',
    });
    useOttoStore.getState().applyEvent({
      type: 'tool-call-decided',
      sessionId: 's1',
      messageId: 'm1',
      callId: 'c1',
      decisionId: 'd1',
      decision: 'approve',
    });
    const blocks = useOttoStore.getState().activeSession!.messages[0]!.content;
    expect(blocks[0]).toMatchObject({ type: 'pending_tool_use', decision: 'approved' });
  });

  it('transforms pending block on tool-call-decided deny', () => {
    useOttoStore.getState().applyEvent({
      type: 'tool-call-pending',
      sessionId: 's1',
      messageId: 'm1',
      callId: 'c1',
      decisionId: 'd1',
      name: 'fake-mutate',
      input: { target: 'x' },
      actionClass: 'destructive',
      reason: 'mode=balanced',
    });
    useOttoStore.getState().applyEvent({
      type: 'tool-call-decided',
      sessionId: 's1',
      messageId: 'm1',
      callId: 'c1',
      decisionId: 'd1',
      decision: 'deny',
    });
    const blocks = useOttoStore.getState().activeSession!.messages[0]!.content;
    expect(blocks[0]).toMatchObject({ type: 'pending_tool_use', decision: 'denied' });
  });

  it('appends tool_denied block on tool-call-denied', () => {
    useOttoStore.getState().applyEvent({
      type: 'tool-call-denied',
      sessionId: 's1',
      messageId: 'm1',
      callId: 'c2',
      name: 'fake-wipe',
      input: { target: 'y' },
      reason: 'mode=strict, class=irreversible',
    });
    const blocks = useOttoStore.getState().activeSession!.messages[0]!.content;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'tool_denied',
      callId: 'c2',
      name: 'fake-wipe',
      reason: 'mode=strict, class=irreversible',
    });
  });
});

describe('store: shell process events', () => {
  beforeEach(() => {
    useOttoStore.getState().reset();
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().applyEvent({
      type: 'message-start',
      sessionId: 's1',
      messageId: 'm1',
    });
  });

  it('process-spawned appends a process_output block with status running', () => {
    useOttoStore.getState().applyEvent({
      type: 'process-spawned',
      sessionId: 's1',
      messageId: 'm1',
      handle: 'h1',
      pid: 1234,
      command: 'sleep 30',
      cwd: '/tmp',
    });
    const blocks = useOttoStore.getState().activeSession!.messages[0]!.content;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'process_output',
      handle: 'h1',
      command: 'sleep 30',
      cwd: '/tmp',
      status: 'running',
      lines: [],
      exitCode: null,
    });
  });

  it('process-stdout appends a stdout line to the matching block', () => {
    useOttoStore.getState().applyEvent({
      type: 'process-spawned',
      sessionId: 's1',
      messageId: 'm1',
      handle: 'h1',
      pid: 1,
      command: 'x',
      cwd: '/tmp',
    });
    useOttoStore.getState().applyEvent({
      type: 'process-stdout',
      sessionId: 's1',
      messageId: 'm1',
      handle: 'h1',
      data: 'hello',
    });
    const blocks = useOttoStore.getState().activeSession!.messages[0]!.content;
    const b = blocks[0]!;
    if (b.type !== 'process_output') throw new Error('unexpected block');
    expect(b.lines).toEqual([{ stream: 'stdout', data: 'hello' }]);
  });

  it('process-stderr appends a stderr line', () => {
    useOttoStore.getState().applyEvent({
      type: 'process-spawned',
      sessionId: 's1',
      messageId: 'm1',
      handle: 'h1',
      pid: 1,
      command: 'x',
      cwd: '/tmp',
    });
    useOttoStore.getState().applyEvent({
      type: 'process-stderr',
      sessionId: 's1',
      messageId: 'm1',
      handle: 'h1',
      data: 'oops',
    });
    const blocks = useOttoStore.getState().activeSession!.messages[0]!.content;
    const b = blocks[0]!;
    if (b.type !== 'process_output') throw new Error('unexpected block');
    expect(b.lines).toEqual([{ stream: 'stderr', data: 'oops' }]);
  });

  it('process-exited sets status to exited with exitCode', () => {
    useOttoStore.getState().applyEvent({
      type: 'process-spawned',
      sessionId: 's1',
      messageId: 'm1',
      handle: 'h1',
      pid: 1,
      command: 'x',
      cwd: '/tmp',
    });
    useOttoStore.getState().applyEvent({
      type: 'process-exited',
      sessionId: 's1',
      messageId: 'm1',
      handle: 'h1',
      exitCode: 0,
      signal: null,
    });
    const blocks = useOttoStore.getState().activeSession!.messages[0]!.content;
    const b = blocks[0]!;
    if (b.type !== 'process_output') throw new Error('unexpected block');
    expect(b.status).toBe('exited');
    expect(b.exitCode).toBe(0);
  });

  it('process-killed sets status to killed', () => {
    useOttoStore.getState().applyEvent({
      type: 'process-spawned',
      sessionId: 's1',
      messageId: 'm1',
      handle: 'h1',
      pid: 1,
      command: 'x',
      cwd: '/tmp',
    });
    useOttoStore.getState().applyEvent({
      type: 'process-killed',
      sessionId: 's1',
      messageId: 'm1',
      handle: 'h1',
    });
    const blocks = useOttoStore.getState().activeSession!.messages[0]!.content;
    const b = blocks[0]!;
    if (b.type !== 'process_output') throw new Error('unexpected block');
    expect(b.status).toBe('killed');
  });
});

describe('canProactivelyReset', () => {
  const base: ActiveSessionState = {
    id: 's1',
    messages: [{ id: 'm1' } as never],
    currentTurnActive: false,
    queueDepth: 0,
    error: null,
  };

  it('allows reset for an idle non-private session with messages', () => {
    expect(canProactivelyReset(base)).toBe(true);
  });

  it('never resets when there is no active session or no messages', () => {
    expect(canProactivelyReset(null)).toBe(false);
    expect(canProactivelyReset({ ...base, messages: [] })).toBe(false);
  });

  it('never resets a busy session (running turn or queued messages)', () => {
    expect(canProactivelyReset({ ...base, currentTurnActive: true })).toBe(false);
    expect(canProactivelyReset({ ...base, queueDepth: 1 })).toBe(false);
  });

  it('never resets a private session (not recoverable from history)', () => {
    expect(canProactivelyReset({ ...base, private: true })).toBe(false);
  });
});

describe('store: streamed tool output (tool-call-output)', () => {
  beforeEach(() => {
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().applyEvent({ type: 'message-start', sessionId: 's1', messageId: 'm1' });
    useOttoStore.getState().applyEvent({
      type: 'tool-call-start', sessionId: 's1', messageId: 'm1',
      callId: 'c1', name: 'shell_exec', input: { command: 'du -sh /' },
    });
  });

  it('buffers stdout and stderr chunks per callId', () => {
    useOttoStore.getState().applyEvent({ type: 'tool-call-output', sessionId: 's1', messageId: 'm1', callId: 'c1', stream: 'stdout', data: '12G\t/home\n' });
    useOttoStore.getState().applyEvent({ type: 'tool-call-output', sessionId: 's1', messageId: 'm1', callId: 'c1', stream: 'stdout', data: '3G\t/var\n' });
    useOttoStore.getState().applyEvent({ type: 'tool-call-output', sessionId: 's1', messageId: 'm1', callId: 'c1', stream: 'stderr', data: 'du: cannot read\n' });
    const out = useOttoStore.getState().activeSession!.toolOutput!['c1']!;
    expect(out.stdout).toBe('12G\t/home\n3G\t/var\n');
    expect(out.stderr).toBe('du: cannot read\n');
  });

  it('drops the partial buffer once the tool result lands', () => {
    useOttoStore.getState().applyEvent({ type: 'tool-call-output', sessionId: 's1', messageId: 'm1', callId: 'c1', stream: 'stdout', data: 'partial' });
    useOttoStore.getState().applyEvent({
      type: 'tool-call-result', sessionId: 's1', messageId: 'm1',
      callId: 'c1', result: { stdout: 'partial-and-more', exitCode: 0 }, isError: false,
    });
    expect(useOttoStore.getState().activeSession!.toolOutput?.['c1']).toBeUndefined();
  });

  it('keeps only the tail of oversized streamed output', () => {
    useOttoStore.getState().applyEvent({ type: 'tool-call-output', sessionId: 's1', messageId: 'm1', callId: 'c1', stream: 'stdout', data: 'x'.repeat(70_000) });
    useOttoStore.getState().applyEvent({ type: 'tool-call-output', sessionId: 's1', messageId: 'm1', callId: 'c1', stream: 'stdout', data: 'END' });
    const out = useOttoStore.getState().activeSession!.toolOutput!['c1']!;
    expect(out.stdout.length).toBeLessThanOrEqual(64_000);
    expect(out.stdout.endsWith('END')).toBe(true);
  });
});

describe('store: watch snapshots (tool-call-snapshot)', () => {
  beforeEach(() => {
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().applyEvent({ type: 'message-start', sessionId: 's1', messageId: 'm1' });
    useOttoStore.getState().applyEvent({
      type: 'tool-call-start', sessionId: 's1', messageId: 'm1',
      callId: 'c1', name: 'observe', input: { label: 'load', command: 'cat /proc/loadavg', unit: '%' },
    });
  });

  it('keeps only the latest snapshot per callId', () => {
    useOttoStore.getState().applyEvent({
      type: 'tool-call-snapshot', sessionId: 's1', messageId: 'm1', callId: 'c1',
      snapshot: { kind: 'observe', label: 'load', unit: '%', startedAt: 1, series: [3] },
    });
    useOttoStore.getState().applyEvent({
      type: 'tool-call-snapshot', sessionId: 's1', messageId: 'm1', callId: 'c1',
      snapshot: { kind: 'observe', label: 'load', unit: '%', startedAt: 1, series: [3, 4] },
    });
    const snap = useOttoStore.getState().activeSession!.toolSnapshot!['c1'] as { series: number[] };
    expect(snap.series).toEqual([3, 4]);
  });

  it('drops the snapshot once the tool result lands', () => {
    useOttoStore.getState().applyEvent({
      type: 'tool-call-snapshot', sessionId: 's1', messageId: 'm1', callId: 'c1',
      snapshot: { kind: 'observe', label: 'load', unit: '%', startedAt: 1, series: [3] },
    });
    useOttoStore.getState().applyEvent({
      type: 'tool-call-result', sessionId: 's1', messageId: 'm1',
      callId: 'c1', result: { kind: 'observe', label: 'load', unit: '%', startedAt: 1, endedAt: 9, series: [3, 4] }, isError: false,
    });
    expect(useOttoStore.getState().activeSession!.toolSnapshot?.['c1']).toBeUndefined();
  });
});

describe('store: outcome event', () => {
  it('appends the outcome block to the streaming assistant message', () => {
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().applyEvent({ type: 'message-start', sessionId: 's1', messageId: 'm1' });
    useOttoStore.getState().applyEvent({
      type: 'outcome', sessionId: 's1', messageId: 'm1',
      block: { type: 'outcome', title: 'Stopped the frame hitches', durationMs: 720_000, toolCalls: 9, fix: 'balooctl suspend' },
    });
    const msg = useOttoStore.getState().activeSession!.messages[0]!;
    expect(msg.content[msg.content.length - 1]).toMatchObject({
      type: 'outcome', title: 'Stopped the frame hitches', toolCalls: 9,
    });
  });
});

describe('store: tool-result-annotated', () => {
  it('merges takeaway/why into the matching tool_result block', () => {
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().applyEvent({ type: 'message-start', sessionId: 's1', messageId: 'm1' });
    useOttoStore.getState().applyEvent({
      type: 'tool-call-start', sessionId: 's1', messageId: 'm1',
      callId: 'c1', name: 'shell_exec', input: { command: 'iostat' },
    });
    useOttoStore.getState().applyEvent({
      type: 'tool-call-result', sessionId: 's1', messageId: 'm1',
      callId: 'c1', result: { stdout: 'x', exitCode: 0 }, isError: false,
    });
    useOttoStore.getState().applyEvent({
      type: 'tool-result-annotated', sessionId: 's1', messageId: 'm1',
      callId: 'c1', takeaway: 'disk saturated during the hitch',
    });
    const msg = useOttoStore.getState().activeSession!.messages[0]!;
    const tr = msg.content.find((b) => b.type === 'tool_result');
    expect(tr).toMatchObject({ callId: 'c1', takeaway: 'disk saturated during the hitch' });
  });
});
