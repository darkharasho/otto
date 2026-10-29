import { describe, it, expect, beforeEach } from 'vitest';
import { __resetRefsForTest, renderTree, resolveRef, surfaceOffset } from './index';
import type { UiTree } from './types';

beforeEach(() => __resetRefsForTest());

describe('surfaceOffset', () => {
  it('is the window position when KWin and the app agree on size (no decorations)', () => {
    expect(surfaceOffset({ x: 3440, y: 0, w: 3440, h: 1396 }, { x: 0, y: 0, w: 3440, h: 1396 }))
      .toEqual({ dx: 3440, dy: 0 });
  });

  it('accounts for side borders and a title bar', () => {
    // 4px borders each side, 30px title bar.
    expect(surfaceOffset({ x: 100, y: 50, w: 808, h: 634 }, { x: 0, y: 0, w: 800, h: 600 }))
      .toEqual({ dx: 104, dy: 80 });
  });
});

describe('renderTree', () => {
  const tree: UiTree = {
    window: { handle: 'w', app: 'kcalc', title: 'KCalc', active: true },
    nodes: [
      { handle: 'a', depth: 0, role: 'frame', name: 'KCalc', states: [], actions: [] },
      { handle: 'b', depth: 1, role: 'push button', name: '7', states: ['disabled'], actions: ['press'], bounds: { x: 10, y: 20, w: 30, h: 40 } },
      { handle: 'c', depth: 1, role: 'entry', name: 'Display', value: '42', states: [], actions: [] },
    ],
    truncated: true,
    boundsReliable: true,
    notes: ['hello'],
  };

  it('renders one indented line per element with id, role, name, value, states and bounds', () => {
    const text = renderTree(tree, ['e1', 'e2', 'e3'], null);
    expect(text.split('\n')).toEqual([
      'window: "KCalc" (kcalc) [active]',
      'note: hello',
      'e1 frame "KCalc"',
      '  e2 push button "7" [disabled] @10,20 30x40',
      '  e3 entry "Display" ="42"',
      '… truncated: narrow with `query`, or raise `max_nodes`.',
    ]);
  });
});

describe('resolveRef', () => {
  it('rejects unknown ids with a hint to refresh', () => {
    expect(() => resolveRef('e99')).toThrow(/call it again/);
  });
});
