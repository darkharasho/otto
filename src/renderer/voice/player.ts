// Gapless PCM chunk playback: each chunk becomes an AudioBufferSourceNode
// scheduled at the tail of the previous one. stop() is the barge-in path —
// it must silence output immediately.

type Ctx = Pick<AudioContext, 'createBuffer' | 'createBufferSource' | 'destination' | 'currentTime'>;

export class PcmPlayer {
  private nextStartTime = 0;
  private live = new Set<AudioBufferSourceNode>();
  private isPlaying = false;
  onPlayingChange?: (playing: boolean) => void;

  constructor(private readonly ctx: Ctx) {}

  get playing(): boolean {
    return this.isPlaying;
  }

  enqueue(pcm: Float32Array, sampleRate: number): void {
    const buffer = this.ctx.createBuffer(1, pcm.length, sampleRate);
    buffer.copyToChannel(pcm, 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const startAt = Math.max(this.ctx.currentTime, this.nextStartTime);
    source.onended = () => {
      this.live.delete(source);
      if (this.live.size === 0) this.setPlaying(false);
    };
    this.live.add(source);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
    this.setPlaying(true);
  }

  stop(): void {
    for (const s of this.live) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        // already ended
      }
    }
    this.live.clear();
    this.nextStartTime = 0;
    this.setPlaying(false);
  }

  private setPlaying(v: boolean): void {
    if (this.isPlaying === v) return;
    this.isPlaying = v;
    this.onPlayingChange?.(v);
  }
}
