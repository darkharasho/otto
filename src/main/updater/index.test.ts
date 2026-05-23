import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUpdater, type UpdaterDeps, type UpdaterState } from './index';

function makeDeps(): { deps: UpdaterDeps; handlers: Map<string, (...args: unknown[]) => void>; states: UpdaterState[] } {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const states: UpdaterState[] = [];
  const deps: UpdaterDeps = {
    autoUpdater: {
      on: (event, handler) => { handlers.set(event, handler); },
      checkForUpdates: vi.fn().mockResolvedValue(undefined),
      downloadUpdate: vi.fn().mockResolvedValue(undefined),
      quitAndInstall: vi.fn(),
      autoDownload: true,
      autoInstallOnAppQuit: true,
    },
    setInterval: vi.fn(() => 0 as unknown as NodeJS.Timeout) as unknown as typeof setInterval,
    clearInterval: vi.fn() as unknown as typeof clearInterval,
    onStateChange: (s) => states.push(s),
  };
  return { deps, handlers, states };
}

describe('createUpdater', () => {
  let env: ReturnType<typeof makeDeps>;
  beforeEach(() => { env = makeDeps(); });

  it('starts in idle state and disables electron-updater auto-download', () => {
    const u = createUpdater(env.deps);
    expect(u.getState()).toEqual({ kind: 'idle' });
    expect(env.deps.autoUpdater.autoDownload).toBe(false);
    expect(env.deps.autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it('check() moves to checking, then up-to-date when no update', async () => {
    const u = createUpdater(env.deps);
    const p = u.check();
    expect(u.getState()).toEqual({ kind: 'checking' });
    env.handlers.get('update-not-available')!({});
    await p;
    expect(u.getState()).toEqual({ kind: 'up-to-date' });
  });

  it('transitions to available on update-available event', async () => {
    const u = createUpdater(env.deps);
    const p = u.check();
    env.handlers.get('update-available')!({ version: '0.2.0' });
    await p;
    expect(u.getState()).toEqual({ kind: 'available', version: '0.2.0' });
  });

  it('download() triggers downloadUpdate and reports progress', async () => {
    const u = createUpdater(env.deps);
    await u.check();
    env.handlers.get('update-available')!({ version: '0.2.0' });
    const dp = u.download();
    expect(env.deps.autoUpdater.downloadUpdate).toHaveBeenCalled();
    env.handlers.get('download-progress')!({ percent: 42.5 });
    expect(u.getState()).toEqual({ kind: 'downloading', version: '0.2.0', percent: 42.5 });
    env.handlers.get('update-downloaded')!({ version: '0.2.0' });
    await dp;
    expect(u.getState()).toEqual({ kind: 'downloaded', version: '0.2.0' });
  });

  it('install() calls quitAndInstall when downloaded', async () => {
    const u = createUpdater(env.deps);
    await u.check();
    env.handlers.get('update-available')!({ version: '0.2.0' });
    await u.download();
    env.handlers.get('update-downloaded')!({ version: '0.2.0' });
    u.install();
    expect(env.deps.autoUpdater.quitAndInstall).toHaveBeenCalled();
  });

  it('captures errors as error state', async () => {
    const u = createUpdater(env.deps);
    void u.check();
    env.handlers.get('error')!(new Error('network down'));
    expect(u.getState()).toMatchObject({ kind: 'error', message: 'network down' });
  });

  it('emits state changes to onStateChange callback', async () => {
    const u = createUpdater(env.deps);
    await u.check();
    env.handlers.get('update-available')!({ version: '0.2.0' });
    const kinds = env.states.map((s) => s.kind);
    expect(kinds).toContain('checking');
    expect(kinds).toContain('available');
  });
});
