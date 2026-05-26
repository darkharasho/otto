// Memory probe (not a real test — always passes). Drives the Zustand store
// with realistic event sequences and prints process memory at each phase
// to verify the 2026-05-26 leak hypotheses (see memory/project_ram_usage.md).
//
// Run with:
//   node --expose-gc node_modules/vitest/vitest.mjs run \
//     src/renderer/state/store.memory-probe.test.ts --reporter=verbose

import { describe, it, beforeEach, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { useOttoStore } from './store';

function fakeBase64(bytes: number): string {
  // Real random data so V8 cannot use compact/repeated string optimizations.
  return randomBytes(Math.ceil((bytes * 3) / 4)).toString('base64').slice(0, bytes);
}

function snap(label: string) {
  if ((global as { gc?: () => void }).gc) (global as { gc?: () => void }).gc!();
  const m = process.memoryUsage();
  const fmt = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  // eslint-disable-next-line no-console
  console.log(
    `[${label.padEnd(42)}] rss=${fmt(m.rss).padStart(10)}  heap=${fmt(m.heapUsed).padStart(10)}  external=${fmt(m.external).padStart(10)}  arrayBuffers=${fmt(m.arrayBuffers).padStart(10)}`
  );
  return m;
}

beforeEach(() => {
  useOttoStore.getState().reset();
  if ((global as { gc?: () => void }).gc) (global as { gc?: () => void }).gc!();
});

describe('memory probe', () => {
  it('A: text-delta streaming (20KB message in 5-char chunks)', () => {
    snap('A: baseline');
    const s = useOttoStore.getState();
    s.beginSession('sA');
    s.applyEvent({ type: 'message-start', sessionId: 'sA', messageId: 'mA' });
    const peak = { rss: 0, heap: 0 };
    const total = 4000;
    for (let i = 0; i < total; i++) {
      s.applyEvent({ type: 'text-delta', sessionId: 'sA', messageId: 'mA', text: 'hello' });
      if (i % 500 === 0) {
        const m = process.memoryUsage();
        peak.rss = Math.max(peak.rss, m.rss);
        peak.heap = Math.max(peak.heap, m.heapUsed);
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `  peak during stream:  rss=${(peak.rss / 1024 / 1024).toFixed(1)} MB  heap=${(peak.heap / 1024 / 1024).toFixed(1)} MB`
    );
    snap('A: after stream (post-GC)');
  });

  it('B: 50 image-ref screenshot tool-results (no bytes in store)', () => {
    const before = process.memoryUsage();
    const s = useOttoStore.getState();
    s.beginSession('sB');
    s.applyEvent({ type: 'message-start', sessionId: 'sB', messageId: 'mB' });
    for (let i = 0; i < 50; i++) {
      s.applyEvent({
        type: 'tool-call-result',
        sessionId: 'sB',
        messageId: 'mB',
        callId: `c${i}`,
        result: {
          content: [
            { type: 'image-ref', id: `img${i}`, sessionId: 'sB', path: `/tmp/img${i}.png`, width: 1920, height: 1080, mimeType: 'image/png' },
          ],
        },
        isError: false,
      });
    }
    if ((global as { gc?: () => void }).gc) (global as { gc?: () => void }).gc!();
    const after = process.memoryUsage();
    const externalGrowth = after.external - before.external;
    // With refs only, external memory must not balloon. 1 MB is generous slack.
    expect(externalGrowth).toBeLessThan(1 * 1024 * 1024);
  });

  it('D: worst-case session — 30 turns × (10 stdout chunks + 1 screenshot)', () => {
    snap('D: baseline');
    const s = useOttoStore.getState();
    s.beginSession('sD');
    for (let turn = 0; turn < 30; turn++) {
      const mid = `m${turn}`;
      s.applyEvent({ type: 'message-start', sessionId: 'sD', messageId: mid });
      // Some streamed text per turn (~5 KB in 1000 deltas).
      for (let i = 0; i < 1000; i++) {
        s.applyEvent({ type: 'text-delta', sessionId: 'sD', messageId: mid, text: 'word ' });
      }
      // A process tool with 10 stdout chunks.
      s.applyEvent({
        type: 'process-spawned',
        sessionId: 'sD',
        messageId: mid,
        handle: `h${turn}`,
        pid: turn + 1,
        command: 'foo',
        cwd: '/tmp',
      });
      for (let i = 0; i < 10; i++) {
        s.applyEvent({
          type: 'process-stdout',
          sessionId: 'sD',
          messageId: mid,
          handle: `h${turn}`,
          data: 'a line of output\n'.repeat(20),
        });
      }
      // A screenshot tool result (~4 MB base64, unique per turn).
      const data = fakeBase64(4 * 1024 * 1024);
      s.applyEvent({
        type: 'tool-call-result',
        sessionId: 'sD',
        messageId: mid,
        callId: `cs${turn}`,
        result: { type: 'image', data, mediaType: 'image/png' },
        isError: false,
      });
    }
    snap('D: after 30 turns (post-GC)');
  });

  it('C: process-stdout 5000 chunks (array spread per chunk)', () => {
    snap('C: baseline');
    const s = useOttoStore.getState();
    s.beginSession('sC');
    s.applyEvent({ type: 'message-start', sessionId: 'sC', messageId: 'mC' });
    s.applyEvent({
      type: 'process-spawned',
      sessionId: 'sC',
      messageId: 'mC',
      handle: 'h1',
      pid: 1,
      command: 'tail -f log',
      cwd: '/tmp',
    });
    const peak = { rss: 0, heap: 0 };
    const chunk = 'log line with some content\n'.repeat(4);
    for (let i = 0; i < 5000; i++) {
      s.applyEvent({
        type: 'process-stdout',
        sessionId: 'sC',
        messageId: 'mC',
        handle: 'h1',
        data: chunk,
      });
      if (i % 500 === 0) {
        const m = process.memoryUsage();
        peak.rss = Math.max(peak.rss, m.rss);
        peak.heap = Math.max(peak.heap, m.heapUsed);
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `  peak during stream:  rss=${(peak.rss / 1024 / 1024).toFixed(1)} MB  heap=${(peak.heap / 1024 / 1024).toFixed(1)} MB`
    );
    snap('C: after stream (post-GC)');
  });
});
