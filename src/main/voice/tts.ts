// Sentence-by-sentence TTS queue. Synthesis is serialized (Kokoro is
// CPU-bound); cancellation uses a generation counter so an in-flight
// result that resolves after cancel() is silently dropped.
import type { VoiceEvent } from '@shared/voice';
import { logger } from '../logger';

export interface SynthOpts {
  voice?: string;
  speed?: number;
}

export type SynthFn = (text: string, opts?: SynthOpts) => Promise<{ pcm: Float32Array; sampleRate: number }>;

export class TtsService {
  private queue: string[] = [];
  private running = false;
  private generation = 0;
  /** Timestamp of the first speak() call in the current batch (for first-chunk latency). */
  private batchT0: number | null = null;

  constructor(
    private readonly synth: SynthFn,
    private readonly emit: (e: VoiceEvent) => void
  ) {}

  get pending(): number {
    return this.queue.length;
  }

  speak(sentence: string): void {
    this.queue.push(sentence);
    if (!this.running) {
      this.batchT0 = Date.now();
      void this.drain();
    }
  }

  cancel(): void {
    this.generation++;
    this.queue = [];
    this.batchT0 = null;
  }

  private async drain(): Promise<void> {
    this.running = true;
    this.emit({ type: 'tts-start' });
    // Outer loop: re-check queue after each inner iteration so that sentences
    // enqueued during cancel() (barge-in flow) are not stranded.
    outer: while (this.queue.length > 0) {
      while (this.queue.length > 0) {
        const gen = this.generation;
        const sentence = this.queue.shift()!;
        try {
          const synthT0 = Date.now();
          const { pcm, sampleRate } = await this.synth(sentence);
          logger.info(`[voice:perf] synth wall=${Date.now() - synthT0}ms chars=${sentence.length}`);
          if (gen !== this.generation) break; // cancelled mid-synthesis; re-check outer
          // Copy into a plain ArrayBuffer for structured-clone over IPC.
          const buf = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
          if (this.batchT0 !== null) {
            logger.info(`[voice:perf] first-chunk latency=${Date.now() - this.batchT0}ms`);
            this.batchT0 = null;
          }
          this.emit({ type: 'tts-chunk', pcm: buf, sampleRate });
        } catch {
          if (gen !== this.generation) break;
          // Skip the failed sentence, keep going.
        }
      }
      // If cancel-then-speak added items between the break and here, keep draining.
      if (this.queue.length === 0) break outer;
    }
    this.running = false;
    this.emit({ type: 'tts-end' });
  }
}

/**
 * Trim leading and trailing silence from a PCM buffer.
 * Finds the first and last sample whose absolute value exceeds `threshold`,
 * then pads `padMs` ms on each side before returning a copy of the subarray.
 * Returns a short (near-empty) buffer safely if all samples are below threshold.
 */
export function trimSilence(
  pcm: Float32Array,
  sampleRate: number,
  threshold = 0.01,
  padMs = 60,
): Float32Array {
  const padSamples = Math.round((padMs / 1000) * sampleRate);
  let start = 0;
  let end = pcm.length - 1;
  while (start < pcm.length && Math.abs(pcm[start]!) <= threshold) start++;
  while (end > start && Math.abs(pcm[end]!) <= threshold) end--;
  // All silence — return a zero-length (or 1-sample) buffer safely.
  if (start > end) return new Float32Array(0);
  const s = Math.max(0, start - padSamples);
  const e = Math.min(pcm.length, end + 1 + padSamples);
  return pcm.slice(s, e);
}

/**
 * Real Kokoro adapter. Heavy: loads ~300MB of ONNX weights on first call.
 *
 * API notes (verified against kokoro-js@1.2.1 + @huggingface/transformers@3.8.1):
 * - KokoroTTS.from_pretrained(model_id, { dtype, device }) — options match reference.
 * - tts.generate(text, { voice }) returns Promise<RawAudio> where RawAudio has
 *   fields `audio: Float32Array` and `sampling_rate: number`.
 * - Cache dir: HF_HUB_CACHE env var is NOT read by @huggingface/transformers.
 *   The correct mechanism is setting `env.cacheDir` on the transformers env object
 *   before calling from_pretrained.
 */
export async function createKokoroSynth(cacheDir: string): Promise<SynthFn> {
  const { KokoroTTS } = await import('kokoro-js');
  // Set cache dir via the transformers env object (not HF_HUB_CACHE env var)
  const { env } = await import('@huggingface/transformers');
  env.cacheDir = cacheDir;
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    dtype: 'q8',
    device: 'cpu',
  });
  return async (text: string, opts?: SynthOpts) => {
    const voice = opts?.voice ?? 'af_heart';
    const speed = opts?.speed ?? 1.05;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const audio = await tts.generate(text, { voice: voice as any, speed });
    const pcm = trimSilence(audio.audio as Float32Array, audio.sampling_rate as number);
    return { pcm, sampleRate: audio.sampling_rate as number };
  };
}
