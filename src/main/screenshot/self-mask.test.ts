import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type FakeWindow = ReturnType<typeof fakeWindow>;
const windows: FakeWindow[] = [];

function fakeWindow(opts: { visible?: boolean; opacity?: number } = {}) {
  const state = {
    destroyed: false,
    visible: opts.visible ?? true,
    opacity: opts.opacity ?? 1,
  };
  return {
    get destroyed() { return state.destroyed; },
    set destroyed(v: boolean) { state.destroyed = v; },
    get opacity() { return state.opacity; },
    get visible() { return state.visible; },
    setOpacity: vi.fn((o: number) => { state.opacity = o; }),
    getOpacity: vi.fn(() => state.opacity),
    hide: vi.fn(() => { state.visible = false; }),
    show: vi.fn(() => { state.visible = true; }),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    isDestroyed: () => state.destroyed,
    isVisible: () => state.visible,
  };
}

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => windows,
  },
}));

const originalPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
  windows.length = 0;
  vi.resetModules();
});

afterEach(() => {
  setPlatform(originalPlatform);
});

describe('withSelfHidden (linux)', () => {
  it('hides visible windows, re-asserts layering on restore, and calls show()', async () => {
    setPlatform('linux');
    const w = fakeWindow();
    windows.push(w);

    const { withSelfHidden } = await import('./self-mask');
    await withSelfHidden(async () => {
      expect(w.visible).toBe(false);
    });

    expect(w.hide).toHaveBeenCalledOnce();
    expect(w.setAlwaysOnTop).toHaveBeenCalledWith(true, 'floating');
    expect(w.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: true });
    expect(w.show).toHaveBeenCalledOnce();
    expect(w.setOpacity).not.toHaveBeenCalled();
  });

  it('restores even when fn throws', async () => {
    setPlatform('linux');
    const w = fakeWindow();
    windows.push(w);

    const { withSelfHidden } = await import('./self-mask');
    await expect(withSelfHidden(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(w.show).toHaveBeenCalledOnce();
  });
});

describe('withSelfHidden (darwin/win32)', () => {
  it('uses opacity and restores prior value', async () => {
    setPlatform('darwin');
    const a = fakeWindow({ opacity: 1 });
    const b = fakeWindow({ opacity: 0.9 });
    windows.push(a, b);

    const { withSelfHidden } = await import('./self-mask');
    await withSelfHidden(async () => {
      expect(a.opacity).toBe(0);
      expect(b.opacity).toBe(0);
    });

    expect(a.opacity).toBe(1);
    expect(b.opacity).toBe(0.9);
    expect(a.hide).not.toHaveBeenCalled();
  });
});

describe('withSelfHidden (common)', () => {
  it('does not touch windows that were already hidden', async () => {
    setPlatform('linux');
    const hidden = fakeWindow({ visible: false });
    windows.push(hidden);

    const { withSelfHidden } = await import('./self-mask');
    await withSelfHidden(async () => 'x');

    expect(hidden.hide).not.toHaveBeenCalled();
    expect(hidden.show).not.toHaveBeenCalled();
    expect(hidden.setOpacity).not.toHaveBeenCalled();
  });

  it('skips destroyed windows on restore', async () => {
    setPlatform('linux');
    const w = fakeWindow();
    windows.push(w);

    const { withSelfHidden } = await import('./self-mask');
    await withSelfHidden(async () => { w.destroyed = true; });

    expect(w.show).not.toHaveBeenCalled();
  });
});
