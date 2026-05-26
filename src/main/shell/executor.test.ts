import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exec, spawn } from './executor';
import { getPlatformAdapter } from '../platform';

const adapter = getPlatformAdapter();

describe('exec', () => {
  it('returns stdout for a successful command', async () => {
    const res = await exec({ command: "echo hello", cwd: tmpdir(), timeoutMs: 5_000 }, adapter);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('hello');
    expect(res.stderr).toBe('');
    expect(res.timedOut).toBe(false);
    expect(typeof res.durationMs).toBe('number');
  });

  it('captures stderr', async () => {
    const res = await exec({ command: 'echo err 1>&2', cwd: tmpdir(), timeoutMs: 5_000 }, adapter);
    expect(res.exitCode).toBe(0);
    expect(res.stderr.trim()).toBe('err');
  });

  it('reports non-zero exit for failing commands', async () => {
    const res = await exec({ command: 'false', cwd: tmpdir(), timeoutMs: 5_000 }, adapter);
    expect(res.exitCode).not.toBe(0);
  });

  it('honors cwd', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'otto-exec-cwd-'));
    try {
      const res = await exec({ command: 'pwd', cwd: dir, timeoutMs: 5_000 }, adapter);
      expect([dir, realpathSync(dir)]).toContain(res.stdout.trim());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('times out and reports timedOut: true', async () => {
    const res = await exec({ command: 'sleep 10', cwd: tmpdir(), timeoutMs: 100 }, adapter);
    expect(res.timedOut).toBe(true);
  }, 10_000);

  it('truncates stdout past 1 MB', async () => {
    const res = await exec(
      { command: "head -c 1572864 /dev/zero | base64", cwd: tmpdir(), timeoutMs: 10_000 },
      adapter
    );
    expect(res.stdout.length).toBeLessThanOrEqual(1024 * 1024 + 64);
    expect(res.stdout).toContain('[output truncated]');
  });
});

describe('spawn', () => {
  it('returns a ShellChild whose exited resolves on natural exit', async () => {
    const child = spawn('echo hi', tmpdir(), adapter);
    expect(typeof child.pid).toBe('number');
    const result = await child.exited;
    expect(result.exitCode).toBe(0);
  });

  it('emits stdout data events', async () => {
    const child = spawn('echo streamed', tmpdir(), adapter);
    const chunks: string[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d.toString('utf8')));
    await child.exited;
    expect(chunks.join('').trim()).toBe('streamed');
  });
});
