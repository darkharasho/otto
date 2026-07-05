// Sentence-by-sentence TTS queue. Synthesis is serialized (Kokoro is
// CPU-bound); cancellation uses a generation counter so an in-flight
// result that resolves after cancel() is silently dropped.
import type { VoiceEvent } from '@shared/voice';

export type SynthFn = (text: string) => Promise<{ pcm: Float32Array; sampleRate: number }>;

export class TtsService {
  private queue: string[] = [];
  private running = false;
  private generation = 0;

  constructor(
    private readonly synth: SynthFn,
    private readonly emit: (e: VoiceEvent) => void
  ) {}

  get pending(): number {
    return this.queue.length;
  }

  speak(sentence: string): void {
    this.queue.push(sentence);
    if (!this.running) void this.drain();
  }

  cancel(): void {
    this.generation++;
    this.queue = [];
  }

  private async drain(): Promise<void> {
    this.running = true;
    this.emit({ type: 'tts-start' });
    while (this.queue.length > 0) {
      const gen = this.generation;
      const sentence = this.queue.shift()!;
      try {
        const { pcm, sampleRate } = await this.synth(sentence);
        if (gen !== this.generation) break; // cancelled mid-synthesis
        // Copy into a plain ArrayBuffer for structured-clone over IPC.
        const buf = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
        this.emit({ type: 'tts-chunk', pcm: buf, sampleRate });
      } catch {
        if (gen !== this.generation) break;
        // Skip the failed sentence, keep going.
      }
    }
    this.running = false;
    this.emit({ type: 'tts-end' });
  }
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
  return async (text: string) => {
    const audio = await tts.generate(text, { voice: 'af_heart' });
    return { pcm: audio.audio as Float32Array, sampleRate: audio.sampling_rate as number };
  };
}
