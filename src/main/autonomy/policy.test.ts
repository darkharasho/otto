import { describe, it, expect } from 'vitest';
import { clamp, evaluate, type Decision } from './policy';
import type { ActionClass, AutonomyMode } from '@shared/messages';

describe('evaluate', () => {
  const cases: Array<[AutonomyMode, ActionClass, Decision]> = [
    ['strict', 'read', 'allow'],
    ['strict', 'reversible', 'confirm'],
    ['strict', 'destructive', 'confirm'],
    ['strict', 'irreversible', 'deny'],
    ['balanced', 'read', 'allow'],
    ['balanced', 'reversible', 'allow'],
    ['balanced', 'destructive', 'confirm'],
    ['balanced', 'irreversible', 'deny'],
    ['full-allow', 'read', 'allow'],
    ['full-allow', 'reversible', 'allow'],
    ['full-allow', 'destructive', 'allow'],
    ['full-allow', 'irreversible', 'confirm'],
  ];

  for (const [mode, cls, expected] of cases) {
    it(`${mode} + ${cls} -> ${expected}`, () => {
      expect(evaluate(mode, cls)).toBe(expected);
    });
  }
});

describe('clamp', () => {
  it('returns the more-restrictive mode', () => {
    expect(clamp('full-allow', 'strict')).toBe('strict');
    expect(clamp('balanced', 'full-allow')).toBe('balanced');
    expect(clamp('balanced', 'match')).toBe('balanced');
    expect(clamp('strict', 'match')).toBe('strict');
  });
});
