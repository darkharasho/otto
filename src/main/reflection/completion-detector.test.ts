import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CompletionDetector } from './completion-detector';

describe('CompletionDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once after onDone + idle timeout elapses', () => {
    const onTrigger = vi.fn();
    const d = new CompletionDetector({ idleMs: 90_000, onTrigger });
    d.onDone('s1');
    vi.advanceTimersByTime(89_999);
    expect(onTrigger).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onTrigger).toHaveBeenCalledTimes(1);
    expect(onTrigger).toHaveBeenCalledWith({ sessionId: 's1', sinceSeq: -1 });
  });

  it('cancels the timer when the user becomes active mid-window', () => {
    const onTrigger = vi.fn();
    const d = new CompletionDetector({ idleMs: 90_000, onTrigger });
    d.onDone('s1');
    vi.advanceTimersByTime(40_000);
    d.onUserActive('s1');
    vi.advanceTimersByTime(60_000);
    expect(onTrigger).not.toHaveBeenCalled();
  });

  it('onMarkComplete fires immediately and short-circuits the timer', () => {
    const onTrigger = vi.fn();
    const d = new CompletionDetector({ idleMs: 90_000, onTrigger });
    d.onDone('s1');
    d.onMarkComplete('s1');
    expect(onTrigger).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(90_001);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('a second onDone within the same window resets but does not double-fire', () => {
    const onTrigger = vi.fn();
    const d = new CompletionDetector({ idleMs: 1000, onTrigger });
    d.onDone('s1');
    vi.advanceTimersByTime(500);
    d.onDone('s1');
    vi.advanceTimersByTime(999);
    expect(onTrigger).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onTrigger).toHaveBeenCalledTimes(1);
  });

  it('uses notePersistedSeq to advance sinceSeq for the next firing', () => {
    const onTrigger = vi.fn();
    const d = new CompletionDetector({ idleMs: 1000, onTrigger });
    d.onDone('s1');
    vi.advanceTimersByTime(1001);
    expect(onTrigger).toHaveBeenNthCalledWith(1, { sessionId: 's1', sinceSeq: -1 });
    d.notePersistedSeq('s1', 5);
    d.onUserActive('s1');
    d.onDone('s1');
    vi.advanceTimersByTime(1001);
    expect(onTrigger).toHaveBeenNthCalledWith(2, { sessionId: 's1', sinceSeq: 5 });
  });

  it('tracks sessions independently', () => {
    const onTrigger = vi.fn();
    const d = new CompletionDetector({ idleMs: 1000, onTrigger });
    d.onDone('a');
    d.onDone('b');
    vi.advanceTimersByTime(1001);
    expect(onTrigger).toHaveBeenCalledTimes(2);
    const calls = onTrigger.mock.calls.map((c) => c[0].sessionId).sort();
    expect(calls).toEqual(['a', 'b']);
  });
});
