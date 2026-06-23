import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import {
  commandRequiresSudo,
  createRealAskpass,
  parseSudoError,
  SudoSession,
  type AskpassController,
  type SudoRunner,
} from './sudo-session';

function fakeAskpass(): AskpassController & { installed: string[]; uninstalls: number } {
  const installed: string[] = [];
  let uninstalls = 0;
  return {
    installed,
    get uninstalls() {
      return uninstalls;
    },
    install(password: string) {
      installed.push(password);
    },
    uninstall() {
      uninstalls += 1;
    },
  };
}

describe('commandRequiresSudo', () => {
  it('detects a leading sudo', () => {
    expect(commandRequiresSudo('sudo apt update')).toBe(true);
    expect(commandRequiresSudo('  sudo dnf install x')).toBe(true);
  });

  it('detects sudo inside a pipeline or sequence', () => {
    expect(commandRequiresSudo('echo hi | sudo tee /etc/foo')).toBe(true);
    expect(commandRequiresSudo('cd /tmp && sudo systemctl restart x')).toBe(true);
    expect(commandRequiresSudo('foo; sudo bar')).toBe(true);
    expect(commandRequiresSudo('(sudo whoami)')).toBe(true);
  });

  it('ignores non-interactive sudo', () => {
    expect(commandRequiresSudo('sudo -n true')).toBe(false);
    expect(commandRequiresSudo('sudo --non-interactive systemctl status x')).toBe(false);
  });

  it('does not match plain commands or sudo as a substring', () => {
    expect(commandRequiresSudo('apt update')).toBe(false);
    expect(commandRequiresSudo('echo pseudosudo')).toBe(false);
    expect(commandRequiresSudo('cat sudoku.txt')).toBe(false);
  });
});

describe('parseSudoError', () => {
  it('recognizes a wrong password', () => {
    expect(parseSudoError('Sorry, try again.')).toBe('Incorrect password');
    expect(parseSudoError('sudo: 1 incorrect password attempt')).toBe('Incorrect password');
  });
  it('recognizes a non-sudoer', () => {
    expect(parseSudoError('user is not in the sudoers file.')).toMatch(/not permitted/);
  });
  it('falls back to the first stderr line', () => {
    expect(parseSudoError('\n  some other failure\nmore\n')).toBe('some other failure');
  });
});

function fakeRunner(results: Array<{ ok: boolean; stderr: string }>): SudoRunner & { calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    async validate(password: string) {
      calls.push(password);
      return results[Math.min(i++, results.length - 1)]!;
    },
  };
}

describe('SudoSession', () => {
  it('starts locked', () => {
    const s = new SudoSession({ runner: fakeRunner([{ ok: true, stderr: '' }]) });
    expect(s.isUnlocked('sess')).toBe(false);
  });

  it('unlocks on a valid password and reports unlocked for that session only', async () => {
    const runner = fakeRunner([{ ok: true, stderr: '' }]);
    const s = new SudoSession({ runner, setIntervalFn: (() => 0) as never });
    const res = await s.unlock('sess', 'hunter2');
    expect(res.ok).toBe(true);
    expect(runner.calls).toEqual(['hunter2']);
    expect(s.isUnlocked('sess')).toBe(true);
    expect(s.isUnlocked('other')).toBe(false);
  });

  it('rejects a wrong password and stays locked', async () => {
    const runner = fakeRunner([{ ok: false, stderr: 'Sorry, try again.' }]);
    const s = new SudoSession({ runner });
    const res = await s.unlock('sess', 'bad');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Incorrect password');
    expect(s.isUnlocked('sess')).toBe(false);
  });

  it('clear() wipes the credential and stops the keep-alive', async () => {
    const runner = fakeRunner([{ ok: true, stderr: '' }]);
    const clearIntervalFn = vi.fn();
    const s = new SudoSession({
      runner,
      setIntervalFn: (() => 123) as never,
      clearIntervalFn,
    });
    await s.unlock('sess', 'pw');
    s.clear();
    expect(s.isUnlocked('sess')).toBe(false);
    expect(clearIntervalFn).toHaveBeenCalledWith(123);
  });

  it('notifySession clears when the session rolls over', async () => {
    const s = new SudoSession({ runner: fakeRunner([{ ok: true, stderr: '' }]), setIntervalFn: (() => 0) as never });
    await s.unlock('sess-1', 'pw');
    s.notifySession('sess-1');
    expect(s.isUnlocked('sess-1')).toBe(true);
    s.notifySession('sess-2');
    expect(s.isUnlocked('sess-1')).toBe(false);
  });

  it('installs the askpass helper on unlock and uninstalls on clear', async () => {
    const askpass = fakeAskpass();
    const s = new SudoSession({
      runner: fakeRunner([{ ok: true, stderr: '' }]),
      setIntervalFn: (() => 0) as never,
      askpass,
    });
    await s.unlock('sess', 'hunter2');
    expect(askpass.installed).toEqual(['hunter2']);
    s.clear();
    // unlock() clears any prior creds first, then clear() runs again.
    expect(askpass.uninstalls).toBeGreaterThanOrEqual(1);
  });

  it('does not install the askpass helper when the password is wrong', async () => {
    const askpass = fakeAskpass();
    const s = new SudoSession({
      runner: fakeRunner([{ ok: false, stderr: 'Sorry, try again.' }]),
      askpass,
    });
    await s.unlock('sess', 'bad');
    expect(askpass.installed).toEqual([]);
  });

  it('keep-alive re-validates the credential and clears on failure', async () => {
    let tick: (() => void) | null = null;
    const runner = fakeRunner([
      { ok: true, stderr: '' }, // initial unlock
      { ok: false, stderr: 'Sorry, try again.' }, // keep-alive sees revoked creds
    ]);
    const s = new SudoSession({
      runner,
      setIntervalFn: ((fn: () => void) => {
        tick = fn;
        return 1;
      }) as never,
      clearIntervalFn: () => {},
    });
    await s.unlock('sess', 'pw');
    expect(s.isUnlocked('sess')).toBe(true);
    tick!();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.isUnlocked('sess')).toBe(false);
    expect(runner.calls).toEqual(['pw', 'pw']);
  });
});

describe('createRealAskpass', () => {
  it('exposes a SUDO_ASKPASS helper that prints the password, then tears it down', () => {
    const prior = process.env.SUDO_ASKPASS;
    const askpass = createRealAskpass({ warn: () => {} });
    try {
      askpass.install('s3cr3t-pw');
      const helper = process.env.SUDO_ASKPASS;
      expect(helper).toBeTruthy();
      expect(existsSync(helper!)).toBe(true);
      // sudo (no tty) runs this helper to obtain the password on stdout.
      const out = execFileSync(helper!, { encoding: 'utf8' });
      expect(out.replace(/\n$/, '')).toBe('s3cr3t-pw');

      askpass.uninstall();
      expect(process.env.SUDO_ASKPASS).toBe(prior);
      expect(existsSync(helper!)).toBe(false);
    } finally {
      askpass.uninstall();
      if (prior === undefined) delete process.env.SUDO_ASKPASS;
      else process.env.SUDO_ASKPASS = prior;
    }
  });
});
