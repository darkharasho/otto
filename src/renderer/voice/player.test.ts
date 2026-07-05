import { describe, it, expect } from 'vitest';
import { PcmPlayer } from './player';

type Handler = () => void;

class FakeSource {
  buffer: FakeBuffer | null = null;
  started: number[] = [];
  stopped = false;
  onended: Handler | null = null;
  connect() {}
  start(when: number) {
    this.started.push(when);
  }
  stop() {
    this.stopped = true;
    this.onended?.();
  }
  end() {
    this.onended?.();
  }
}

class FakeBuffer {
  data: Float32Array;
  constructor(
    public numberOfChannels: number,
    public length: number,
    public sampleRate: number
  ) {
    this.data = new Float32Array(length);
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  copyToChannel(src: Float32Array) {
    this.data.set(src);
  }
}

function fakeCtx() {
  const sources: FakeSource[] = [];
  const ctx = {
    currentTime: 0,
    destination: {} as AudioDestinationNode,
    createBuffer: (ch: number, len: number, rate: number) => new FakeBuffer(ch, len, rate) as unknown as AudioBuffer,
    createBufferSource: () => {
      const s = new FakeSource();
      sources.push(s);
      return s as unknown as AudioBufferSourceNode;
    },
  };
  return { ctx, sources };
}

describe('PcmPlayer', () => {
  it('plays the first chunk immediately and reports playing', () => {
    const { ctx, sources } = fakeCtx();
    const p = new PcmPlayer(ctx);
    p.enqueue(new Float32Array(24000), 24000); // 1s
    expect(sources).toHaveLength(1);
    expect(p.playing).toBe(true);
  });

  it('schedules subsequent chunks back-to-back (gapless)', () => {
    const { ctx, sources } = fakeCtx();
    const p = new PcmPlayer(ctx);
    p.enqueue(new Float32Array(24000), 24000); // 1s -> starts at ~0
    p.enqueue(new Float32Array(12000), 24000); // 0.5s -> starts at ~1.0
    expect(sources[1]!.started[0]!).toBeCloseTo(1.0, 5);
  });

  it('becomes not-playing after all sources end', () => {
    const { ctx, sources } = fakeCtx();
    const p = new PcmPlayer(ctx);
    const states: boolean[] = [];
    p.onPlayingChange = (v) => states.push(v);
    p.enqueue(new Float32Array(2400), 24000);
    sources[0]!.end();
    expect(p.playing).toBe(false);
    expect(states).toEqual([true, false]);
  });

  it('stop() silences all scheduled sources and clears state', () => {
    const { ctx, sources } = fakeCtx();
    const p = new PcmPlayer(ctx);
    p.enqueue(new Float32Array(24000), 24000);
    p.enqueue(new Float32Array(24000), 24000);
    p.stop();
    expect(sources.every((s) => s.stopped)).toBe(true);
    expect(p.playing).toBe(false);
    // Next enqueue starts fresh at currentTime.
    p.enqueue(new Float32Array(2400), 24000);
    expect(sources[2]!.started[0]!).toBeCloseTo(0, 5);
  });
});
