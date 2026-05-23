import { describe, it, expect } from 'vitest';
import { translateKeyCombo } from './keymap';

describe('translateKeyCombo', () => {
  it('translates Return as press + release', () => {
    expect(translateKeyCombo('Return')).toEqual([
      { code: 28, state: 1 },
      { code: 28, state: 0 },
    ]);
  });

  it('accepts Enter as alias of Return', () => {
    expect(translateKeyCombo('Enter')).toEqual(translateKeyCombo('Return'));
  });

  it('translates Control+S as ctrl down → s down → s up → ctrl up', () => {
    expect(translateKeyCombo('Control+S')).toEqual([
      { code: 29, state: 1 },
      { code: 31, state: 1 },
      { code: 31, state: 0 },
      { code: 29, state: 0 },
    ]);
  });

  it('translates Control+Alt+T with all four modifier transitions wrapping the key', () => {
    expect(translateKeyCombo('Control+Alt+T')).toEqual([
      { code: 29, state: 1 },
      { code: 56, state: 1 },
      { code: 20, state: 1 },
      { code: 20, state: 0 },
      { code: 56, state: 0 },
      { code: 29, state: 0 },
    ]);
  });

  it('accepts Meta as alias of Super', () => {
    expect(translateKeyCombo('Meta+L')).toEqual(translateKeyCombo('Super+L'));
  });

  it('translates F5', () => {
    expect(translateKeyCombo('F5')).toEqual([
      { code: 63, state: 1 },
      { code: 63, state: 0 },
    ]);
  });

  it('translates F12', () => {
    expect(translateKeyCombo('F12')).toEqual([
      { code: 88, state: 1 },
      { code: 88, state: 0 },
    ]);
  });

  it('translates arrow keys', () => {
    expect(translateKeyCombo('Up')).toEqual([{ code: 103, state: 1 }, { code: 103, state: 0 }]);
    expect(translateKeyCombo('Down')).toEqual([{ code: 108, state: 1 }, { code: 108, state: 0 }]);
    expect(translateKeyCombo('Left')).toEqual([{ code: 105, state: 1 }, { code: 105, state: 0 }]);
    expect(translateKeyCombo('Right')).toEqual([{ code: 106, state: 1 }, { code: 106, state: 0 }]);
  });

  it('translates Tab, Escape, Space, Backspace, Delete', () => {
    expect(translateKeyCombo('Tab')).toEqual([{ code: 15, state: 1 }, { code: 15, state: 0 }]);
    expect(translateKeyCombo('Escape')).toEqual([{ code: 1, state: 1 }, { code: 1, state: 0 }]);
    expect(translateKeyCombo('Space')).toEqual([{ code: 57, state: 1 }, { code: 57, state: 0 }]);
    expect(translateKeyCombo('Backspace')).toEqual([{ code: 14, state: 1 }, { code: 14, state: 0 }]);
    expect(translateKeyCombo('Delete')).toEqual([{ code: 111, state: 1 }, { code: 111, state: 0 }]);
  });

  it('translates a single lowercase letter (a, z)', () => {
    expect(translateKeyCombo('a')).toEqual([{ code: 30, state: 1 }, { code: 30, state: 0 }]);
    expect(translateKeyCombo('z')).toEqual([{ code: 44, state: 1 }, { code: 44, state: 0 }]);
  });

  it('translates a single digit (0, 9)', () => {
    expect(translateKeyCombo('0')).toEqual([{ code: 11, state: 1 }, { code: 11, state: 0 }]);
    expect(translateKeyCombo('9')).toEqual([{ code: 10, state: 1 }, { code: 10, state: 0 }]);
  });

  it('throws on unknown key', () => {
    expect(() => translateKeyCombo('NotAKey')).toThrow(/unknown key: NotAKey/);
  });

  it('throws on unknown modifier', () => {
    expect(() => translateKeyCombo('Hyper+A')).toThrow(/unknown key: Hyper/);
  });
});
