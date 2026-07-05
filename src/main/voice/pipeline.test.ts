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
    // With coalescing: the first sentence is spoken immediately for low latency.
    // Subsequent sentences from later handleSessionEvent calls accumulate in the
    // coalesce buffer and are not emitted until it reaches ~140 chars or flush.
    // Here 'More to come.' (13 chars) stays buffered until message-end.
    const p = new SpeechPipeline(tts);
    p.setEnabled(true, 's1');
    p.handleSessionEvent(delta('s1', 'Hello there. More to'));
    p.handleSessionEvent(delta('s1', ' come.'));
    // First sentence spoken immediately; second is buffered (< 140 chars).
    expect(spoken).toEqual(['Hello there.']);
    // Flush via message-end to emit the coalesced remainder.
    p.handleSessionEvent({ type: 'message-end', sessionId: 's1', messageId: 'm1' });
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

  it('flushes the tail on done when message-end is absent', () => {
    const p = new SpeechPipeline(tts);
    p.setEnabled(true, 's1');
    p.handleSessionEvent(delta('s1', 'Tail without message-end'));
    p.handleSessionEvent({ type: 'done', sessionId: 's1' });
    expect(spoken).toEqual(['Tail without message-end']);
  });

  it('coalescing: first sentence emitted alone, subsequent short sentences merged', () => {
    const p = new SpeechPipeline(tts);
    p.setEnabled(true, 's1');
    // First delta: produces one sentence via SpeechTextStream → spoken immediately.
    p.handleSessionEvent(delta('s1', 'Hello there.'));
    expect(spoken).toEqual(['Hello there.']);
    // Second delta: produces another short sentence → coalesced, not spoken yet.
    p.handleSessionEvent(delta('s1', ' Short one.'));
    expect(spoken).toEqual(['Hello there.']); // still buffered
    // Third delta: another short sentence → still below 140 chars.
    p.handleSessionEvent(delta('s1', ' And another.'));
    expect(spoken).toEqual(['Hello there.']); // still buffered
    // message-end flushes the coalesce buffer as one chunk.
    p.handleSessionEvent({ type: 'message-end', sessionId: 's1', messageId: 'm1' });
    expect(spoken).toEqual(['Hello there.', 'Short one. And another.']);
  });

  it('coalescing: a long sentence is not merged (emits immediately once buffer fills)', () => {
    const p = new SpeechPipeline(tts);
    p.setEnabled(true, 's1');
    // A long sentence that comes in a second delta — after firstSpoken is true.
    p.handleSessionEvent(delta('s1', 'First sentence.'));
    expect(spoken).toEqual(['First sentence.']);
    // Push a 200-char sentence that should exceed COALESCE_TARGET=140 immediately.
    const long = 'A'.repeat(150) + '.';
    p.handleSessionEvent(delta('s1', ' ' + long));
    // Should have been emitted immediately (buffer exceeded 140).
    expect(spoken).toEqual(['First sentence.', long]);
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
