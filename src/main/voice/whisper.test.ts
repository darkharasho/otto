// src/main/voice/whisper.test.ts
// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { WhisperService } from './whisper';

const FIXTURE = path.resolve(__dirname, '__fixtures__/fake-whisper-server.mjs');

function stub(extra: string[] = [], opts: Partial<import('./whisper').WhisperServiceOpts> = {}) {
  return new WhisperService({
    command: process.execPath,
    args: (port) => [FIXTURE, '--port', String(port), ...extra],
    startupTimeoutMs: 10_000,
    ...opts,
  });
}

let svc: WhisperService | null = null;
afterEach(async () => {
  await svc?.stop();
  svc = null;
});

describe('WhisperService', () => {
  it('starts, reports running, transcribes, and stops', async () => {
    svc = stub();
    await svc.start();
    expect(svc.isRunning()).toBe(true);
    const text = await svc.transcribe(new Float32Array(1600), 16000);
    // fake server echoes byte count; whisper text is whitespace-padded — we trim.
    expect(text).toMatch(/^transcribed \d+ bytes$/);
    await svc.stop();
    expect(svc.isRunning()).toBe(false);
  });

  it('waits for a slow-booting server', async () => {
    svc = stub(['--delay-ms', '1500']);
    await svc.start();
    expect(svc.isRunning()).toBe(true);
  });

  it('rejects start() when the server never comes up', async () => {
    svc = stub([], { startupTimeoutMs: 1000 });
    // Point at a script arg combo that never listens: huge delay.
    svc = new WhisperService({
      command: process.execPath,
      args: (port) => [FIXTURE, '--port', String(port), '--delay-ms', '60000'],
      startupTimeoutMs: 1000,
    });
    await expect(svc.start()).rejects.toThrow(/timed out/i);
  });

  it('invokes onExit when the process dies unexpectedly', async () => {
    let exitCode: number | null | undefined;
    svc = stub(['--crash-after-start'], { onExit: (code) => (exitCode = code) });
    await svc.start();
    await new Promise((r) => setTimeout(r, 700));
    expect(exitCode).toBe(7);
    expect(svc.isRunning()).toBe(false);
  });

  it('transcribe rejects when not running', async () => {
    svc = stub();
    await expect(svc.transcribe(new Float32Array(16), 16000)).rejects.toThrow(/not running/i);
  });

  it('concurrent start() calls spawn exactly one child process', async () => {
    let argsCalls = 0;
    svc = new WhisperService({
      command: process.execPath,
      args: (port) => {
        argsCalls++;
        return [FIXTURE, '--port', String(port)];
      },
      startupTimeoutMs: 10_000,
    });
    await Promise.all([svc.start(), svc.start()]);
    expect(svc.isRunning()).toBe(true);
    expect(argsCalls).toBe(1);
  });
});
