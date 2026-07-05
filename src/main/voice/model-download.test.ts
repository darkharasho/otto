// src/main/voice/model-download.test.ts
// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureWhisperModel, whisperModelUrl } from './model-download';

// ─── URL helper ───────────────────────────────────────────────────────────────

describe('whisperModelUrl', () => {
  it('returns the correct HF URL for small.en', () => {
    expect(whisperModelUrl('small.en')).toBe(
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
    );
  });

  it('returns the correct HF URL for base.en', () => {
    expect(whisperModelUrl('base.en')).toBe(
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
    );
  });
});

// ─── ensureWhisperModel ───────────────────────────────────────────────────────

/**
 * Starts a local HTTP server that serves `body` with the given status code.
 * Returns the server and its base URL.
 */
function startServer(
  body: Buffer,
  opts: { statusCode?: number; sendContentLength?: boolean; redirectTo?: string } = {},
): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (opts.redirectTo) {
        res.writeHead(302, { Location: opts.redirectTo });
        res.end();
        return;
      }
      const headers: Record<string, string> = {};
      if (opts.sendContentLength !== false) {
        headers['content-length'] = String(body.length);
      }
      res.writeHead(opts.statusCode ?? 200, headers);
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}/model.bin` });
    });
  });
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('ensureWhisperModel', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-dl-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('downloads a model file and fires progress callbacks', async () => {
    // Use a 200-byte "model" — we override minBytes=0 so the size check passes.
    const body = Buffer.alloc(200, 0xab);
    const { server, url } = await startServer(body);

    try {
      const destPath = path.join(tmpDir, 'ggml-small.en.bin');
      const pcts: number[] = [];

      await ensureWhisperModel(
        'small.en',
        destPath,
        (pct) => pcts.push(pct),
        /* minBytes */ 0,
        /* urlOverride */ url,
      );

      // File exists and has correct content.
      expect(fs.existsSync(destPath)).toBe(true);
      const written = fs.readFileSync(destPath);
      expect(written).toEqual(body);

      // At least one progress callback was fired; last must be 100.
      expect(pcts.length).toBeGreaterThan(0);
      expect(pcts[pcts.length - 1]).toBe(100);

      // No .part file left behind.
      expect(fs.existsSync(`${destPath}.part`)).toBe(false);
    } finally {
      await stopServer(server);
    }
  });

  it('is idempotent — skips download if file already exists', async () => {
    const destPath = path.join(tmpDir, 'ggml-base.en.bin');
    fs.writeFileSync(destPath, 'already-here');

    let called = false;
    await ensureWhisperModel('base.en', destPath, () => { called = true; }, 0);

    expect(called).toBe(false);
    // File unchanged.
    expect(fs.readFileSync(destPath, 'utf8')).toBe('already-here');
  });

  it('progress callbacks are integers 0–100', async () => {
    const body = Buffer.alloc(1000, 0);
    const { server, url } = await startServer(body);

    try {
      const destPath = path.join(tmpDir, 'ggml-small.en.bin');
      const pcts: number[] = [];
      await ensureWhisperModel('small.en', destPath, (p) => pcts.push(p), 0, url);

      for (const p of pcts) {
        expect(Number.isInteger(p)).toBe(true);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(100);
      }
    } finally {
      await stopServer(server);
    }
  });

  it('cleans up .part file and rejects on HTTP error', async () => {
    const body = Buffer.from('error body');
    const { server, url } = await startServer(body, { statusCode: 500 });

    try {
      const destPath = path.join(tmpDir, 'ggml-small.en.bin');
      await expect(
        ensureWhisperModel('small.en', destPath, () => {}, 0, url),
      ).rejects.toThrow('HTTP 500');
      expect(fs.existsSync(destPath)).toBe(false);
      expect(fs.existsSync(`${destPath}.part`)).toBe(false);
    } finally {
      await stopServer(server);
    }
  });

  it('rejects when downloaded file is too small', async () => {
    const body = Buffer.alloc(50, 0);
    const { server, url } = await startServer(body);

    try {
      const destPath = path.join(tmpDir, 'ggml-small.en.bin');
      // minBytes=100 but file is 50 bytes.
      await expect(
        ensureWhisperModel('small.en', destPath, () => {}, 100, url),
      ).rejects.toThrow('too small');
      expect(fs.existsSync(destPath)).toBe(false);
      expect(fs.existsSync(`${destPath}.part`)).toBe(false);
    } finally {
      await stopServer(server);
    }
  });

  it('works without content-length header', async () => {
    const body = Buffer.alloc(300, 0xcc);
    const { server, url } = await startServer(body, { sendContentLength: false });

    try {
      const destPath = path.join(tmpDir, 'ggml-base.en.bin');
      const pcts: number[] = [];
      await ensureWhisperModel('base.en', destPath, (p) => pcts.push(p), 0, url);

      expect(fs.existsSync(destPath)).toBe(true);
      const written = fs.readFileSync(destPath);
      expect(written).toEqual(body);
      // 100% still emitted at the end even without content-length.
      expect(pcts).toContain(100);
    } finally {
      await stopServer(server);
    }
  });
});
