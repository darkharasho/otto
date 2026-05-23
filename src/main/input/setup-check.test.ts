import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execMock = vi.fn();

vi.mock('node:child_process', () => {
  const exec = (cmd: string, cb: (err: unknown, stdout: string, stderr: string) => void) => {
    execMock(cmd).then(
      (r: { stdout: string; stderr: string }) => cb(null, r.stdout, r.stderr),
      (err: NodeJS.ErrnoException) => cb(err, '', err.message)
    );
  };
  return { exec, default: { exec } };
});

import { checkYdotoolReady, _resetCacheForTesting } from './setup-check';

beforeEach(() => {
  execMock.mockReset();
  _resetCacheForTesting();
});

afterEach(() => {
  vi.useRealTimers();
});

function setExec(handler: (cmd: string) => Promise<{ stdout: string; stderr: string }>) {
  execMock.mockImplementation((cmd: string) => handler(cmd));
}

describe('checkYdotoolReady', () => {
  it('returns failure with install hint when ydotool is missing', async () => {
    setExec(async (cmd) => {
      if (cmd.startsWith('which ydotool')) {
        const err = new Error('not found') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      throw new Error(`unexpected: ${cmd}`);
    });
    const r = await checkYdotoolReady();
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not installed/i);
    expect(r.hint).toMatch(/dnf install ydotool/);
  });

  it('returns success when ydotool installed and ydotoold active', async () => {
    setExec(async (cmd) => {
      if (cmd.startsWith('which ydotool')) return { stdout: '/usr/bin/ydotool\n', stderr: '' };
      if (cmd.includes('is-active ydotoold')) return { stdout: 'active\n', stderr: '' };
      throw new Error(`unexpected: ${cmd}`);
    });
    const r = await checkYdotoolReady();
    expect(r.ok).toBe(true);
    expect(r.reason).toBeNull();
    expect(r.hint).toBeNull();
  });

  it('auto-runs enable+start when ydotoold is inactive, then succeeds if it becomes active', async () => {
    vi.useFakeTimers();
    let activeNow = false;
    setExec(async (cmd) => {
      if (cmd.startsWith('which ydotool')) return { stdout: '/usr/bin/ydotool\n', stderr: '' };
      if (cmd.includes('is-active ydotoold')) {
        return { stdout: activeNow ? 'active\n' : 'inactive\n', stderr: '' };
      }
      if (cmd.includes('enable --now ydotoold')) {
        activeNow = true;
        return { stdout: '', stderr: '' };
      }
      throw new Error(`unexpected: ${cmd}`);
    });
    const p = checkYdotoolReady();
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.ok).toBe(true);
  });

  it('returns failure if auto-enable still leaves it inactive', async () => {
    vi.useFakeTimers();
    setExec(async (cmd) => {
      if (cmd.startsWith('which ydotool')) return { stdout: '/usr/bin/ydotool\n', stderr: '' };
      if (cmd.includes('is-active ydotoold')) return { stdout: 'inactive\n', stderr: '' };
      if (cmd.includes('enable --now ydotoold')) return { stdout: '', stderr: '' };
      throw new Error(`unexpected: ${cmd}`);
    });
    const p = checkYdotoolReady();
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/could not be started/i);
    expect(r.hint).toMatch(/systemctl --user enable --now ydotoold/);
  });

  it('caches success across calls (exec called only twice total)', async () => {
    setExec(async (cmd) => {
      if (cmd.startsWith('which ydotool')) return { stdout: '/usr/bin/ydotool\n', stderr: '' };
      if (cmd.includes('is-active ydotoold')) return { stdout: 'active\n', stderr: '' };
      throw new Error(`unexpected: ${cmd}`);
    });
    await checkYdotoolReady();
    await checkYdotoolReady();
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  it('does not cache failure (re-probes on next call)', async () => {
    setExec(async (cmd) => {
      if (cmd.startsWith('which ydotool')) {
        const err = new Error('not found') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      throw new Error(`unexpected: ${cmd}`);
    });
    await checkYdotoolReady();
    await checkYdotoolReady();
    expect(execMock).toHaveBeenCalledTimes(2);
  });
});
