import { describe, it, expect } from 'vitest';
import { sanitizeFtsQuery } from './fts-utils';

describe('sanitizeFtsQuery', () => {
  it('quotes each token as a prefix phrase', () => {
    expect(sanitizeFtsQuery('game stutter')).toBe('"game"* "stutter"*');
  });

  it('preserves hyphenated terms as phrases instead of splitting them', () => {
    expect(sanitizeFtsQuery('multi-monitor setup')).toBe('"multi-monitor"* "setup"*');
  });

  it('neutralizes FTS operators by quoting', () => {
    expect(sanitizeFtsQuery('a AND (b OR c)')).toBe('"a"* "AND"* "(b"* "OR"* "c)"*');
  });

  it('strips embedded double quotes so user text cannot escape the phrase', () => {
    expect(sanitizeFtsQuery('say "hello" world')).toBe('"say"* "hello"* "world"*');
  });

  it('drops tokens with no letters or digits', () => {
    expect(sanitizeFtsQuery('-- () ^ browser')).toBe('"browser"*');
  });

  it('returns empty string for empty or junk-only input', () => {
    expect(sanitizeFtsQuery('')).toBe('');
    expect(sanitizeFtsQuery('   ')).toBe('');
    expect(sanitizeFtsQuery('()*:^-')).toBe('');
  });

  it('keeps unicode terms', () => {
    expect(sanitizeFtsQuery('café preferences')).toBe('"café"* "preferences"*');
  });
});
