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
      streaming: false,
      error: null,
    });
  });

  it('handles message-start by appending an empty assistant placeholder', () => {
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().applyEvent({
      type: 'message-start',
      sessionId: 's1',
      messageId: 'm1',
    });
    const a = useOttoStore.getState().activeSession!;
    expect(a.streaming).toBe(true);
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

  it('marks streaming false on done', () => {
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().applyEvent({ type: 'message-start', sessionId: 's1', messageId: 'm1' });
    useOttoStore.getState().applyEvent({ type: 'done', sessionId: 's1' });
    expect(useOttoStore.getState().activeSession!.streaming).toBe(false);
  });
});
