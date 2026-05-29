import { describe, it, expect, vi, beforeEach } from 'vitest';
import { vi as v2 } from 'vitest';
import { WindowManager } from './window';

function makeFakeWin() {
  const state: { bounds: Electron.Rectangle; minSize: [number, number] | null } = {
    bounds: { x: 0, y: 0, width: 640, height: 72 },
    minSize: null,
  };
  return {
    state,
    setBounds: vi.fn((b) => { state.bounds = { ...state.bounds, ...b }; }),
    getBounds: vi.fn(() => state.bounds),
    setMinimumSize: vi.fn((w: number, h: number) => { state.minSize = [w, h]; }),
    isVisible: vi.fn(() => true),
    isFocused: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
    show: vi.fn(),
    hide: vi.fn(),
    focus: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    removeMenu: vi.fn(),
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    on: vi.fn(),
    webContents: { setWindowOpenHandler: vi.fn(), on: vi.fn() },
  };
}

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  screen: {
    getAllDisplays: () => [
      { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    ],
    getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getDisplayNearestPoint: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
  app: { isPackaged: true, getAppPath: () => '/app' },
  shell: { openExternal: vi.fn() },
}));

describe('WindowManager chat mode', () => {
  let mgr: WindowManager;
  let fake: ReturnType<typeof makeFakeWin>;

  beforeEach(() => {
    mgr = new WindowManager();
    fake = makeFakeWin();
    (mgr as unknown as { window: typeof fake }).window = fake;
  });

  it('applies remembered bounds when entering chat mode', () => {
    mgr.setChatBounds({ x: 100, y: 200, width: 1000, height: 700 });
    mgr.setMode('chat');
    expect(fake.setBounds).toHaveBeenCalledWith({ x: 100, y: 200, width: 1000, height: 700 });
  });

  it('applies default centered bounds when no remembered bounds', () => {
    mgr.setChatBounds(null);
    mgr.setMode('chat');
    const call = fake.setBounds.mock.calls.at(-1)![0];
    expect(call.width).toBe(960);
    expect(call.height).toBe(620);
    expect(call.x).toBe(Math.round((1920 - 960) / 2));
    expect(call.y).toBe(Math.round((1080 - 620) / 2));
  });

  it('sets minimum size when entering chat mode', () => {
    mgr.setMode('chat');
    expect(fake.setMinimumSize).toHaveBeenCalledWith(560, 400);
  });

  it('falls back to default when remembered bounds are off all displays', () => {
    mgr.setChatBounds({ x: 5000, y: 5000, width: 800, height: 600 });
    mgr.setMode('chat');
    const call = fake.setBounds.mock.calls.at(-1)![0];
    expect(call.width).toBe(960);
    expect(call.x).toBe(Math.round((1920 - 960) / 2));
  });
});

describe('WindowManager chat-mode behavior overrides', () => {
  it('does not hide on blur when in chat mode even with hideOnBlur=true', () => {
    const mgr = new WindowManager();
    const fake = makeFakeWin();
    (mgr as unknown as { window: typeof fake }).window = fake;
    mgr.setHideOnBlur(true);
    mgr.setMode('chat');
    const blur = fake.on.mock.calls.find(([evt]) => evt === 'blur')?.[1] as (() => void) | undefined;
    blur?.();
    expect(fake.hide).not.toHaveBeenCalled();
  });

  it('tracks lastVisibleMode after show', () => {
    const mgr = new WindowManager();
    const fake = makeFakeWin();
    (mgr as unknown as { window: typeof fake }).window = fake;
    fake.isVisible.mockReturnValue(false);
    mgr.show('chat');
    expect(mgr.getLastVisibleMode()).toBe('chat');
  });

  it('show() with no mode resumes lastVisibleMode', () => {
    const mgr = new WindowManager();
    const fake = makeFakeWin();
    (mgr as unknown as { window: typeof fake }).window = fake;
    mgr.setLastVisibleMode('chat');
    fake.isVisible.mockReturnValue(false);
    mgr.show();
    expect(mgr.getMode()).toBe('chat');
  });
});

describe('WindowManager bounds persistence', () => {
  it('emits chatBoundsChanged after a debounced move when in chat mode', async () => {
    v2.useFakeTimers();
    const mgr = new WindowManager();
    const fake = makeFakeWin();
    (mgr as unknown as { window: typeof fake }).window = fake;

    const seen: Array<{ x: number; y: number; width: number; height: number }> = [];
    mgr.onChatBoundsChanged((b) => seen.push(b));
    mgr.setMode('chat');

    const moveHandler = fake.on.mock.calls.find(([evt]) => evt === 'move')?.[1] as (() => void) | undefined;
    expect(moveHandler).toBeDefined();
    fake.state.bounds = { x: 50, y: 60, width: 1000, height: 700 };
    moveHandler!();

    v2.advanceTimersByTime(300);
    expect(seen.at(-1)).toEqual({ x: 50, y: 60, width: 1000, height: 700 });
    v2.useRealTimers();
  });
});
