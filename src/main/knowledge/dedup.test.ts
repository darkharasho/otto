import { describe, it, expect } from 'vitest';
import { normalizeFactLine } from './dedup';

describe('normalizeFactLine', () => {
  it('strips the leading "- (YYYY-MM-DD) " marker and lowercases', () => {
    expect(normalizeFactLine('- (2026-05-23) Browser   of choice is  Zen')).toBe(
      'browser of choice is zen'
    );
  });

  it('collapses whitespace and lowercases bare text', () => {
    expect(normalizeFactLine('  Hello\tWorld\n')).toBe('hello world');
  });
});
