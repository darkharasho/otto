import { describe, it, expect, vi } from 'vitest';
import {
  commandRequiresSudo,
  parseSudoError,
  SudoSession,
  type SudoRunner,
} from './sudo-session';

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

  it('keep-alive re-primes the timestamp and clears on failure', async () => {
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
