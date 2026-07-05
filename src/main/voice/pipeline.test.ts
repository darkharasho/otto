import { describe, it, expect, beforeEach } from 'vitest';
import { SpeechPipeline } from './pipeline';

const spoken: string[] = [];
let cancelled = 0;
const tts = {
  speak: (s: string) => {
    spoken.push(s);
  },
  cancel: () => {
    cancelled++;
  },
};

const delta = (sessionId: string, text: string) =>
  ({ type: 'text-delta', sessionId, messageId: 'm1', text }) as const;

beforeEach(() => {
  spoken.length = 0;
  cancelled = 0;
});

describe('SpeechPipeline', () => {
  it('speaks completed sentences from text-deltas of the enabled session', () => {
    const p = new SpeechPipeline(tts);
    p.setEnabled(true, 's1');
    p.handleSessionEvent(delta('s1', 'Hello there. More to'));
    p.handleSessionEvent(delta('s1', ' come.'));
    expect(spoken).toEqual(['Hello there.', 'More to come.']);
  });

  it('ignores deltas for other sessions and when disabled', () => {
    const p = new SpeechPipeline(tts);
    p.setEnabled(true, 's1');
    p.handleSessionEvent(delta('s2', 'Should not speak.'));
    p.setEnabled(false, null);
    p.handleSessionEvent(delta('s1', 'Also silent.'));
    expect(spoken).toEqual([]);
  });

  it('flushes the tail on message-end', () => {
    const p = new SpeechPipeline(tts);
    p.setEnabled(true, 's1');
    p.handleSessionEvent(delta('s1', 'No terminal punctuation'));
    p.handleSessionEvent({ type: 'message-end', sessionId: 's1', messageId: 'm1' });
    expect(spoken).toEqual(['No terminal punctuation']);
  });

  it('cancels speech and drops buffered text on message-cancelled and error', () => {
    const p = new SpeechPipeline(tts);
    p.setEnabled(true, 's1');
    p.handleSessionEvent(delta('s1', 'Partial sentence'));
    p.handleSessionEvent({ type: 'message-cancelled', sessionId: 's1', messageId: 'm1' });
    expect(cancelled).toBe(1);
    p.handleSessionEvent({ type: 'message-end', sessionId: 's1', messageId: 'm1' });
    expect(spoken).toEqual([]); // buffer was reset, nothing to flush
  });

  it('disabling mid-message cancels and resets', () => {
    const p = new SpeechPipeline(tts);
    p.setEnabled(true, 's1');
    p.handleSessionEvent(delta('s1', 'Buffered'));
    p.setEnabled(false, null);
    expect(cancelled).toBe(1);
  });

  it('switching sessions resets the buffer', () => {
    const p = new SpeechPipeline(tts);
    p.setEnabled(true, 's1');
    p.handleSessionEvent(delta('s1', 'Old session tail'));
    p.setEnabled(true, 's2');
    p.handleSessionEvent({ type: 'message-end', sessionId: 's2', messageId: 'm9' });
    expect(spoken).toEqual([]);
  });

  it('does not speak reasoning or tool events', () => {
    const p = new SpeechPipeline(tts);
    p.setEnabled(true, 's1');
    p.handleSessionEvent({ type: 'reasoning', sessionId: 's1', messageId: 'm1', text: 'thinking.' });
    p.handleSessionEvent({
      type: 'tool-call-start',
      sessionId: 's1',
      messageId: 'm1',
      callId: 'c1',
      name: 'bash',
      input: {},
    });
    expect(spoken).toEqual([]);
  });
});
