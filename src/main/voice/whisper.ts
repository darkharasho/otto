// src/main/voice/whisper.ts
// Long-lived whisper.cpp `whisper-server` sidecar. The model loads once at
// start() and stays resident so per-utterance latency is just inference.
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { pcmToWav } from '@shared/pcm-wav';

export interface WhisperServiceOpts {
  command: string;
  args(port: number): string[];
  startupTimeoutMs?: number;
  onExit?(code: number | null): void;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export class WhisperService {
  private child: ChildProcess | null = null;
  private port = 0;
  private stopping = false;

  constructor(private readonly opts: WhisperServiceOpts) {}

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.stopping;
  }

  async start(): Promise<void> {
    if (this.isRunning()) return;
    this.stopping = false;
    this.port = await freePort();
    const child = spawn(this.opts.command, this.opts.args(this.port), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.child = child;
    child.on('exit', (code) => {
      const wasStopping = this.stopping;
      this.child = null;
      if (!wasStopping) this.opts.onExit?.(code);
    });

    const deadline = Date.now() + (this.opts.startupTimeoutMs ?? 30_000);
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return;
      } catch {
        // not up yet — check if process exited before we got a response
        if (child.exitCode !== null) throw new Error(`whisper-server exited during startup (code ${child.exitCode})`);
      }
      if (Date.now() > deadline) {
        await this.stop();
        throw new Error('whisper-server startup timed out');
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timer);
    this.child = null;
    this.stopping = false;
  }

  async transcribe(pcm: Float32Array, sampleRate: number): Promise<string> {
    if (!this.isRunning()) throw new Error('whisper-server is not running');
    const wav = pcmToWav(pcm, sampleRate);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    const res = await fetch(`http://127.0.0.1:${this.port}/inference`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`whisper-server inference failed: HTTP ${res.status}`);
    const json = (await res.json()) as { text?: string };
    return (json.text ?? '').trim();
  }
}
