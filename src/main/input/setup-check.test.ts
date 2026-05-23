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
  process.env.OTTO_SKIP_USER_UNIT_INSTALL = '1';
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

  it('returns success when ydotoold (user) is active', async () => {
    setExec(async (cmd) => {
      if (cmd.startsWith('which ydotool')) return { stdout: '/usr/bin/ydotool\n', stderr: '' };
      if (cmd.includes('--user is-active ydotoold')) return { stdout: 'active\n', stderr: '' };
      return { stdout: 'inactive\n', stderr: '' };
    });
    const r = await checkYdotoolReady();
    expect(r.ok).toBe(true);
  });

  it('returns success when ydotool (system) is active (Fedora convention)', async () => {
    setExec(async (cmd) => {
      if (cmd.startsWith('which ydotool')) return { stdout: '/usr/bin/ydotool\n', stderr: '' };
      if (cmd.includes('--user is-active ydotoold')) return { stdout: 'inactive\n', stderr: '' };
      if (cmd.includes('is-active ydotool') && !cmd.includes('--user')) {
        return { stdout: 'active\n', stderr: '' };
      }
      return { stdout: 'inactive\n', stderr: '' };
    });
    const r = await checkYdotoolReady();
    expect(r.ok).toBe(true);
  });

  it('auto-runs enable+start for ydotoold (user) when inactive, then succeeds', async () => {
    vi.useFakeTimers();
    let activeNow = false;
    setExec(async (cmd) => {
      if (cmd.startsWith('which ydotool')) return { stdout: '/usr/bin/ydotool\n', stderr: '' };
      if (cmd.includes('--user is-active ydotoold')) {
        return { stdout: activeNow ? 'active\n' : 'inactive\n', stderr: '' };
      }
      if (cmd.includes('--user enable --now ydotoold')) {
        activeNow = true;
        return { stdout: '', stderr: '' };
      }
      return { stdout: 'inactive\n', stderr: '' };
    });
    const p = checkYdotoolReady();
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.ok).toBe(true);
  });

  it('returns failure with multi-distro hints when no daemon variant is active', async () => {
    vi.useFakeTimers();
    setExec(async (cmd) => {
      if (cmd.startsWith('which ydotool')) return { stdout: '/usr/bin/ydotool\n', stderr: '' };
      // Every is-active call returns inactive; auto-enable succeeds but the unit stays inactive.
      return { stdout: 'inactive\n', stderr: '' };
    });
    const p = checkYdotoolReady();
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not running/i);
    expect(r.hint).toMatch(/sudo systemctl enable --now ydotool/);
    expect(r.hint).toMatch(/systemctl --user enable --now ydotoold/);
    expect(r.hint).toMatch(/usermod -aG input/);
  });

  it('caches success across calls (no re-probe)', async () => {
    setExec(async (cmd) => {
      if (cmd.startsWith('which ydotool')) return { stdout: '/usr/bin/ydotool\n', stderr: '' };
      if (cmd.includes('--user is-active ydotoold')) return { stdout: 'active\n', stderr: '' };
      return { stdout: 'inactive\n', stderr: '' };
    });
    await checkYdotoolReady();
    const callsAfterFirst = execMock.mock.calls.length;
    await checkYdotoolReady();
    expect(execMock.mock.calls.length).toBe(callsAfterFirst);
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
