import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exec } from './executor';
import type { CursorPosition, PlatformAdapter, PlatformInput } from '../platform';

function makeFakeInput(overrides: Partial<PlatformInput> = {}): PlatformInput {
  return {
    cursorPosition: vi.fn(async (): Promise<CursorPosition> => ({ x: 100, y: 200 })),
    move: vi.fn(async () => {}),
    scroll: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    doubleClick: vi.fn(async () => {}),
    drag: vi.fn(async () => {}),
    type: vi.fn(async () => {}),
    key: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeAdapter(input: PlatformInput): PlatformAdapter {
  return {
    name: 'linux',
    detectDisplayServer: () => 'x11',
    defaultHotkey: () => 'Super+Space',
    shell: { spawnShell: () => ({} as never), composeEnv: () => ({}) },
    screenshot: { capture: vi.fn() as never },
    input,
  } as unknown as PlatformAdapter;
}

describe('exec', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cursorPosition returns adapter result, no delay applied', async () => {
    const input = makeFakeInput();
    const p = exec({ kind: 'cursorPosition' }, makeAdapter(input), 100);
    await vi.runAllTimersAsync();
    const r = await p;
    expect(input.cursorPosition).toHaveBeenCalled();
    expect(r).toEqual({ x: 100, y: 200 });
  });

  it('move dispatches with x/y and waits ≥ delayMs', async () => {
    const input = makeFakeInput();
    const adapter = makeAdapter(input);
    const p = exec({ kind: 'move', x: 50, y: 60 }, adapter, 100);
    await Promise.resolve();
    expect(input.move).toHaveBeenCalledWith(50, 60);
    await vi.advanceTimersByTimeAsync(99);
    let done = false;
    p.then(() => { done = true; });
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await p;
  });

  it('click dispatches with all args', async () => {
    const input = makeFakeInput();
    const p = exec({ kind: 'click', x: 10, y: 20, button: 'right' }, makeAdapter(input), 100);
    await vi.runAllTimersAsync();
    await p;
    expect(input.click).toHaveBeenCalledWith(10, 20, 'right');
  });

  it('doubleClick dispatches with all args', async () => {
    const input = makeFakeInput();
    const p = exec({ kind: 'doubleClick', x: 1, y: 2, button: 'left' }, makeAdapter(input), 100);
    await vi.runAllTimersAsync();
    await p;
    expect(input.doubleClick).toHaveBeenCalledWith(1, 2, 'left');
  });

  it('drag dispatches with all args', async () => {
    const input = makeFakeInput();
    const p = exec(
      { kind: 'drag', x1: 1, y1: 2, x2: 3, y2: 4, button: 'middle' },
      makeAdapter(input),
      100
    );
    await vi.runAllTimersAsync();
    await p;
    expect(input.drag).toHaveBeenCalledWith(1, 2, 3, 4, 'middle');
  });

  it('scroll dispatches with optional x/y', async () => {
    const input = makeFakeInput();
    const p = exec({ kind: 'scroll', dx: 0, dy: 5 }, makeAdapter(input), 100);
    await vi.runAllTimersAsync();
    await p;
    expect(input.scroll).toHaveBeenCalledWith(0, 5, undefined, undefined);
  });

  it('type dispatches with text', async () => {
    const input = makeFakeInput();
    const p = exec({ kind: 'type', text: 'hello' }, makeAdapter(input), 100);
    await vi.runAllTimersAsync();
    await p;
    expect(input.type).toHaveBeenCalledWith('hello');
  });

  it('key dispatches with combo', async () => {
    const input = makeFakeInput();
    const p = exec({ kind: 'key', combo: 'Control+S' }, makeAdapter(input), 100);
    await vi.runAllTimersAsync();
    await p;
    expect(input.key).toHaveBeenCalledWith('Control+S');
  });

  it('adapter errors propagate', async () => {
    const input = makeFakeInput({
      click: vi.fn(async () => { throw new Error('boom'); }),
    });
    const p = exec({ kind: 'click', x: 1, y: 2, button: 'left' }, makeAdapter(input), 100);
    // Attach a catch handler *before* draining timers so vi.runAllTimersAsync
    // doesn't surface the rejection as unhandled while it pumps microtasks.
    const rejection = expect(p).rejects.toThrow('boom');
    await vi.runAllTimersAsync();
    await rejection;
  });
});
