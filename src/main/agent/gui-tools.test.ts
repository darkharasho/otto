import { describe, it, expect, vi } from 'vitest';

// gui-tools pulls in capture/encoding modules that need Electron; runSteps
// itself only touches the adapter, so stub the rest.
vi.mock('../screenshot/verify-crop', () => ({ captureVerifyCrop: vi.fn() }));
vi.mock('../screenshot/self-mask', () => ({ withSelfHidden: vi.fn() }));
vi.mock('../screenshot/processor', () => ({ tileIfNeeded: vi.fn() }));
vi.mock('../screenshot/store', () => ({ save: vi.fn() }));
vi.mock('../screenshot/executor', () => ({ capture: vi.fn() }));
vi.mock('../platform', () => ({ getPlatformAdapter: vi.fn() }));
vi.mock('../a11y', () => ({ uiAct: vi.fn(), uiTree: vi.fn() }));

import { runSteps, stepToInputAction } from './gui-tools';
import type { PlatformAdapter, PlatformInput } from '../platform';

function makeAdapter(overrides: Partial<PlatformInput> = {}, activate?: (n: string) => Promise<void>) {
  const log: string[] = [];
  const input: PlatformInput = {
    cursorPosition: vi.fn(async () => ({ x: 0, y: 0 })),
    move: vi.fn(async (x, y) => { log.push(`move ${x},${y}`); }),
    scroll: vi.fn(async () => { log.push('scroll'); }),
    click: vi.fn(async (x, y) => { log.push(`click ${x},${y}`); }),
    doubleClick: vi.fn(async () => { log.push('dbl'); }),
    drag: vi.fn(async () => { log.push('drag'); }),
    type: vi.fn(async (t) => { log.push(`type ${t}`); }),
    key: vi.fn(async (c) => { log.push(`key ${c}`); }),
    ...overrides,
  };
  const adapter = {
    name: 'linux',
    input,
    activateWindow: activate ?? (async (n: string) => { log.push(`focus ${n}`); }),
  } as unknown as PlatformAdapter;
  return { adapter, log };
}

describe('runSteps', () => {
  it('runs steps in order after raising the focus window', async () => {
    const { adapter, log } = makeAdapter();
    const r = await runSteps(
      {
        focus: 'Editor',
        step_delay_ms: 0,
        steps: [
          { action: 'click', x: 10, y: 20, button: 'left' },
          { action: 'type', text: 'hello' },
          { action: 'key', combo: 'Return' },
        ],
      },
      { adapter, isCancelled: () => false }
    );
    expect(log).toEqual(['focus Editor', 'click 10,20', 'type hello', 'key Return']);
    expect(r).toEqual({ completed: 3, lastPointer: { x: 10, y: 20 }, notes: [] });
  });

  it('stops at the first failing step and reports which', async () => {
    const { adapter, log } = makeAdapter({ type: vi.fn(async () => { throw new Error('portal gone'); }) });
    const r = await runSteps(
      {
        step_delay_ms: 0,
        steps: [
          { action: 'click', x: 1, y: 2, button: 'left' },
          { action: 'type', text: 'x' },
          { action: 'key', combo: 'Return' },
        ],
      },
      { adapter, isCancelled: () => false }
    );
    expect(r.completed).toBe(1);
    expect(r.error).toBe('step 2 (type) failed: portal gone');
    expect(log).toEqual(['click 1,2']);
  });

  it('honors cancellation between steps', async () => {
    const { adapter, log } = makeAdapter();
    let n = 0;
    const r = await runSteps(
      { step_delay_ms: 0, steps: [{ action: 'move', x: 1, y: 1 }, { action: 'move', x: 2, y: 2 }] },
      { adapter, isCancelled: () => n++ >= 1 }
    );
    expect(log).toEqual(['move 1,1']);
    expect(r.error).toMatch(/stopped by user before step 2/);
  });

  it('reports a focus failure without running any step', async () => {
    const { adapter, log } = makeAdapter({}, async () => { throw new Error('no window matches name "Nope"'); });
    const r = await runSteps(
      { focus: 'Nope', steps: [{ action: 'click', x: 1, y: 1, button: 'left' }] },
      { adapter, isCancelled: () => false }
    );
    expect(log).toEqual([]);
    expect(r.error).toMatch(/focus "Nope" failed/);
  });

  it('runs element steps through the ui op and tracks their pointer', async () => {
    const { adapter } = makeAdapter();
    const uiOp = vi.fn(async () => ({ method: 'pointer-click', pointer: { x: 5, y: 6 } }));
    const r = await runSteps(
      { step_delay_ms: 0, steps: [{ action: 'ui', id: 'e3', op: 'press' }, { action: 'wait', ms: 1 }] },
      { adapter, isCancelled: () => false, uiOp }
    );
    expect(uiOp).toHaveBeenCalledWith('e3', 'press', undefined, adapter);
    expect(r.lastPointer).toEqual({ x: 5, y: 6 });
    expect(r.notes).toEqual(['step 1 (e3 press): pointer-click']);
    expect(r.completed).toBe(2);
  });
});

describe('stepToInputAction', () => {
  it('maps drag and double_click to executor actions', () => {
    expect(stepToInputAction({ action: 'drag', x1: 1, y1: 2, x2: 3, y2: 4, button: 'left' }))
      .toEqual({ kind: 'drag', x1: 1, y1: 2, x2: 3, y2: 4, button: 'left' });
    expect(stepToInputAction({ action: 'double_click', x: 1, y: 2, button: 'right' }))
      .toEqual({ kind: 'doubleClick', x: 1, y: 2, button: 'right' });
    expect(stepToInputAction({ action: 'wait', ms: 5 })).toBeNull();
  });
});
