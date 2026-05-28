import { describe, expect, it } from 'vitest';
import {
  IDLE_GATE_MS,
  SIMILARITY_THRESHOLD,
  CONTEXT_WINDOW_CHARS,
  TOPIC_SHIFT_EVALUATE_TIMEOUT_MS,
} from './topic-shift-constants';

describe('topic-shift constants', () => {
  it('IDLE_GATE_MS is 5 minutes', () => {
    expect(IDLE_GATE_MS).toBe(5 * 60 * 1000);
  });

  it('SIMILARITY_THRESHOLD is 0.35', () => {
    expect(SIMILARITY_THRESHOLD).toBe(0.35);
  });

  it('CONTEXT_WINDOW_CHARS is 2000', () => {
    expect(CONTEXT_WINDOW_CHARS).toBe(2000);
  });

  it('TOPIC_SHIFT_EVALUATE_TIMEOUT_MS is 2 seconds', () => {
    expect(TOPIC_SHIFT_EVALUATE_TIMEOUT_MS).toBe(2000);
  });
});
