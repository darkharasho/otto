import { describe, it, expect, beforeEach } from 'vitest';
import { useOttoStore } from './store';

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
