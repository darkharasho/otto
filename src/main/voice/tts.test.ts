// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { TtsService, trimSilence, type SynthFn } from './tts';
import type { VoiceEvent } from '@shared/voice';

describe('trimSilence', () => {
  const SR = 24000;

  it('trims leading and trailing silence, preserving padMs of padding', () => {
    // 480 silent samples (20ms) + 480 tone samples (20ms) + 480 silent samples (20ms)
    const buf = new Float32Array(1440);
    for (let i = 480; i < 960; i++) buf[i] = 0.5; // tone region
    const trimmed = trimSilence(buf, SR, 0.01, 0); // padMs=0 for precise length check
    expect(trimmed.length).toBe(480); // exactly the tone region
  });

  it('pads the result by padMs on each side', () => {
    // 2400 silent + 2400 tone + 2400 silent = 7200 samples at 24000Hz
    const buf = new Float32Array(7200);
    for (let i = 2400; i < 4800; i++) buf[i] = 0.5;
    const padMs = 60; // 60ms = 1440 samples at 24000Hz
    const trimmed = trimSilence(buf, SR, 0.01, padMs);
    // Tone region 2400 samples + 1440 pad before + 1440 pad after = 5280
    expect(trimmed.length).toBe(2400 + 1440 + 1440);
  });

  it('returns empty array for an all-silence buffer', () => {
    const buf = new Float32Array(1000); // all zeros
    const trimmed = trimSilence(buf, SR);
    expect(trimmed.length).toBe(0);
  });
});

function deferredSynth() {
  const resolvers: Array<(v: { pcm: Float32Array; sampleRate: number }) => void> = [];
  const synth: SynthFn = () =>
    new Promise((resolve) => {
      resolvers.push(resolve);
    });
  return { synth, resolvers };
}

const chunk = (n: number) => ({ pcm: new Float32Array(n), sampleRate: 24000 });

describe('TtsService', () => {
  it('synthesizes sentences in order and emits start/chunk/end', async () => {
    const events: VoiceEvent[] = [];
    const calls: string[] = [];
    const synth: SynthFn = async (t) => {
      calls.push(t);
      return chunk(8);
    };
    const tts = new TtsService(synth, (e) => events.push(e));
    tts.speak('One.');
    tts.speak('Two.');
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'tts-end')).toHaveLength(1));
    expect(calls).toEqual(['One.', 'Two.']);
    expect(events.map((e) => e.type)).toEqual(['tts-start', 'tts-chunk', 'tts-chunk', 'tts-end']);
  });

  it('serializes synthesis (one at a time)', async () => {
    const { synth, resolvers } = deferredSynth();
    const tts = new TtsService(synth, () => {});
    tts.speak('A.');
    tts.speak('B.');
    await vi.waitFor(() => expect(resolvers).toHaveLength(1)); // B not started yet
    resolvers[0]!(chunk(4));
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
  });

  it('cancel drops queued sentences and the in-flight result', async () => {
    const events: VoiceEvent[] = [];
    const { synth, resolvers } = deferredSynth();
    const tts = new TtsService(synth, (e) => events.push(e));
    tts.speak('A.');
    tts.speak('B.');
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    tts.cancel();
    resolvers[0]!(chunk(4)); // resolves after cancel — must be dropped
    await vi.waitFor(() => expect(events.some((e) => e.type === 'tts-end')).toBe(true));
    expect(events.some((e) => e.type === 'tts-chunk')).toBe(false);
    expect(tts.pending).toBe(0);
  });

  it('a synthesis error skips the sentence and continues the queue', async () => {
    const events: VoiceEvent[] = [];
    let first = true;
    const synth: SynthFn = async (_t) => {
      if (first) {
        first = false;
        throw new Error('boom');
      }
      return chunk(4);
    };
    const tts = new TtsService(synth, (e) => events.push(e));
    tts.speak('Bad.');
    tts.speak('Good.');
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'tts-end')).toHaveLength(1));
    expect(events.filter((e) => e.type === 'tts-chunk')).toHaveLength(1);
  });

  it('cancel-then-speak before drain exits still synthesizes the new sentence', async () => {
    const events: VoiceEvent[] = [];
    const { synth, resolvers } = deferredSynth();
    const tts = new TtsService(synth, (e) => events.push(e));

    // Speak A, wait until synth call 1 is in flight
    tts.speak('A.');
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));

    // Barge-in: cancel, then immediately enqueue B
    tts.cancel();
    tts.speak('B.');

    // Resolve synth call 1 — its result must be dropped (gen mismatch)
    resolvers[0]!(chunk(4));

    // B must now be synthesized
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]!(chunk(8));

    // Wait for quiescence
    await vi.waitFor(() => expect(events.some((e) => e.type === 'tts-end')).toBe(true));

    // Exactly one chunk (B's), no chunk for A
    const chunks = events.filter((e) => e.type === 'tts-chunk');
    expect(chunks).toHaveLength(1);
    expect((chunks[0] as { pcm: ArrayBuffer }).pcm.byteLength).toBe(8 * 4); // B's 8 floats

    // Service is quiescent
    expect(tts.pending).toBe(0);
  });

  it('emits tts-start again for a new batch after draining', async () => {
    const events: VoiceEvent[] = [];
    const tts = new TtsService(async () => chunk(4), (e) => events.push(e));
    tts.speak('One.');
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'tts-end')).toHaveLength(1));
    tts.speak('Two.');
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'tts-end')).toHaveLength(2));
    expect(events.filter((e) => e.type === 'tts-start')).toHaveLength(2);
  });
});
