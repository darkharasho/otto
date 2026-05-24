import { describe, it, expect } from 'vitest';
import { filterNovelFacts, normalizeFactLine } from './dedup';

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

describe('filterNovelFacts', () => {
  it('drops facts whose normalized form already appears in existing knowledge', () => {
    const existing = '# Otto knowledge file\n\n- (2026-05-22) Browser of choice is Zen\n';
    const novel = filterNovelFacts(['browser  of  choice is zen', 'machine is on Wayland'], existing);
    expect(novel).toEqual(['machine is on Wayland']);
  });

  it('drops empty / whitespace-only candidates', () => {
    const novel = filterNovelFacts(['', '   ', 'real fact'], '');
    expect(novel).toEqual(['real fact']);
  });

  it('dedups duplicates within the incoming list', () => {
    const novel = filterNovelFacts(['fact A', 'fact a', 'fact b'], '');
    expect(novel).toEqual(['fact A', 'fact b']);
  });
});
