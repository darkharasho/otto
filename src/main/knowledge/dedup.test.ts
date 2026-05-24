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

  it('collapses any number of leading markdown bullet prefixes onto the bare text', () => {
    const bare = normalizeFactLine('Wayland typing: always click "Allow"');
    expect(normalizeFactLine('- Wayland typing: always click "Allow"')).toBe(bare);
    expect(normalizeFactLine('- - Wayland typing: always click "Allow"')).toBe(bare);
    expect(normalizeFactLine('  -  - - Wayland typing: always click "Allow"')).toBe(bare);
  });
});
