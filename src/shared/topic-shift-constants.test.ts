import { describe, expect, it } from 'vitest';
import {
  IDLE_GATE_MS,
  SIMILARITY_THRESHOLD,
  MIN_PROMPT_WORDS,
  CONTEXT_WINDOW_CHARS,
  TOPIC_SHIFT_EVALUATE_TIMEOUT_MS,
  paramsForSensitivity,
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

  it('TOPIC_SHIFT_EVALUATE_TIMEOUT_MS covers the confirmer round-trip', () => {
    expect(TOPIC_SHIFT_EVALUATE_TIMEOUT_MS).toBe(8000);
  });
});

describe('paramsForSensitivity', () => {
  it('off is disabled and never flags', () => {
    const p = paramsForSensitivity('off');
    expect(p.enabled).toBe(false);
    // An idle gate of Infinity means the renderer never even consults the detector.
    expect(p.idleGateMs).toBe(Infinity);
    expect(p.confirmerConservative).toBe(false);
  });

  it('low is the calmest enabled level: longest idle gate, strictest threshold, conservative confirmer', () => {
    const p = paramsForSensitivity('low');
    expect(p.enabled).toBe(true);
    expect(p.idleGateMs).toBe(15 * 60 * 1000);
    expect(p.similarityThreshold).toBe(0.28);
    expect(p.minPromptWords).toBe(6);
    expect(p.confirmerConservative).toBe(true);
  });

  it('medium reuses the legacy constants and is not conservative', () => {
    const p = paramsForSensitivity('medium');
    expect(p.enabled).toBe(true);
    expect(p.idleGateMs).toBe(IDLE_GATE_MS);
    expect(p.similarityThreshold).toBe(SIMILARITY_THRESHOLD);
    expect(p.minPromptWords).toBe(MIN_PROMPT_WORDS);
    expect(p.confirmerConservative).toBe(false);
  });

  it('high fires most eagerly: shortest idle gate, loosest threshold, fewest words', () => {
    const p = paramsForSensitivity('high');
    expect(p.enabled).toBe(true);
    expect(p.idleGateMs).toBe(2 * 60 * 1000);
    expect(p.similarityThreshold).toBe(0.45);
    expect(p.minPromptWords).toBe(3);
  });

  it('sensitivity increases monotonically from low to high', () => {
    const low = paramsForSensitivity('low');
    const medium = paramsForSensitivity('medium');
    const high = paramsForSensitivity('high');
    // Shorter idle gate = more eager.
    expect(low.idleGateMs).toBeGreaterThan(medium.idleGateMs);
    expect(medium.idleGateMs).toBeGreaterThan(high.idleGateMs);
    // Higher threshold = more candidates flagged (flag when sim < threshold).
    expect(low.similarityThreshold).toBeLessThan(medium.similarityThreshold);
    expect(medium.similarityThreshold).toBeLessThan(high.similarityThreshold);
  });
});
