import os from 'node:os';
import type { SessionEvent } from '@shared/ipc-contract';
import type { VoiceEvent } from '@shared/voice';
import { WhisperService } from './whisper';
import { TtsService, createKokoroSynth, type SynthFn } from './tts';
import { SpeechPipeline } from './pipeline';
import { resolveWhisperBinary, whisperModelPath } from './paths';
import { logger } from '../logger';

const MAX_RESPAWNS = 3;

export class VoiceManager {
  private whisper: WhisperService | null = null;
  /** The model path that the running whisper sidecar was started with. */
  private whisperModelPath: string | null = null;
  private tts: TtsService | null = null;
  private synth: SynthFn | null = null;
  private pipeline: SpeechPipeline | null = null;
  private enabled = false;
  private respawns = 0;
  private modeChain: Promise<void> = Promise.resolve();
  private previewGeneration = 0;

  constructor(
    private readonly opts: {
      cacheDir: string; // <userData>/voice-models (Kokoro)
      emit(e: VoiceEvent): void;
      getVoicePrefs(): { ttsVoice: string; speed: number; whisperModel: 'base.en' | 'small.en' };
    }
  ) {}

  handleSessionEvent(e: SessionEvent): void {
    this.pipeline?.handleSessionEvent(e);
  }

  setMode(enabled: boolean, sessionId: string | null): Promise<void> {
    const next = this.modeChain.then(() => this.setModeImpl(enabled, sessionId));
    this.modeChain = next.catch(() => {}); // keep the chain usable after a rejection
    return next; // caller still sees the rejection
  }

  private async setModeImpl(enabled: boolean, sessionId: string | null): Promise<void> {
    if (!enabled) {
      logger.info('[voice] disabling voice mode');
      this.enabled = false;
      this.pipeline?.setEnabled(false, null);
      this.tts?.cancel();
      await this.whisper?.stop();
      return;
    }

    logger.info('[voice] enabling voice mode — loading Kokoro TTS…');
    this.enabled = true;
    this.respawns = 0;
    // Kokoro: load once, reuse across mode toggles (model load is seconds).
    if (!this.synth) this.synth = await createKokoroSynth(this.opts.cacheDir);
    logger.info('[voice] Kokoro ready — starting whisper-server…');
    if (!this.tts) {
      const wrappedSynth: SynthFn = (text, opts) => {
        const prefs = this.opts.getVoicePrefs();
        return this.synth!(text, { voice: opts?.voice ?? prefs.ttsVoice, speed: opts?.speed ?? prefs.speed });
      };
      this.tts = new TtsService(wrappedSynth, this.opts.emit);
    }
    if (!this.pipeline) this.pipeline = new SpeechPipeline(this.tts);

    // Resolve model path from prefs using packaged-aware helpers.
    const prefs = this.opts.getVoicePrefs();
    const preferredResolution = whisperModelPath(prefs.whisperModel);
    let resolvedModel = preferredResolution.resolvedPath;
    if (!resolvedModel) {
      // Preferred model absent — try the other model as a fallback.
      const fallbackModel = prefs.whisperModel === 'base.en' ? 'small.en' as const : 'base.en' as const;
      const fallbackResolution = whisperModelPath(fallbackModel);
      if (fallbackResolution.resolvedPath) {
        logger.warn(`[voice] preferred model ggml-${prefs.whisperModel}.bin not found — falling back to ggml-${fallbackModel}.bin`);
        resolvedModel = fallbackResolution.resolvedPath;
      } else {
        throw new Error(
          `No whisper model found for ggml-${prefs.whisperModel}.bin or ggml-${fallbackModel}.bin. ` +
          `Download a model to ${preferredResolution.preferredPath} or run scripts/setup-voice-dev.sh in dev.`
        );
      }
    }

    // If whisper is running with a different model, stop it so we restart below.
    if (this.whisper && this.whisperModelPath !== resolvedModel && this.whisper.isRunning()) {
      logger.info(`[voice] whisper model changed (${this.whisperModelPath} → ${resolvedModel}), restarting sidecar`);
      await this.whisper.stop();
      this.whisper = null;
      this.whisperModelPath = null;
    }

    if (!this.whisper) {
      const binary = resolveWhisperBinary();
      const model = resolvedModel;
      this.whisper = new WhisperService({
        command: binary,
        args: (port) => ['-m', model, '--host', '127.0.0.1', '--port', String(port), '--threads', String(Math.max(4, Math.floor(os.cpus().length / 2)))],
        onExit: (code) => void this.handleWhisperExit(code),
      });
    }
    if (!this.whisper.isRunning()) {
      await this.whisper.start();
      this.whisperModelPath = resolvedModel;
    }
    logger.info('[voice] whisper-server ready — voice mode active');

    this.pipeline.setEnabled(true, sessionId);
    this.opts.emit({ type: 'voice-ready' });
  }

  private async handleWhisperExit(code: number | null): Promise<void> {
    if (!this.enabled) return;
    this.respawns++;
    logger.warn(`whisper-server exited (code ${code}), respawn ${this.respawns}/${MAX_RESPAWNS}`);
    if (this.respawns >= MAX_RESPAWNS) {
      await this.setMode(false, null);
      this.opts.emit({ type: 'voice-error', message: 'Speech recognition crashed repeatedly; voice mode disabled.' });
      return;
    }
    await new Promise((r) => setTimeout(r, 500 * this.respawns));
    if (!this.enabled) return;
    try {
      await this.whisper?.start();
    } catch (err) {
      logger.error(`whisper-server respawn failed: ${String(err)}`);
      void this.handleWhisperExit(null);
    }
  }

  async transcribe(pcm: Float32Array, sampleRate: number): Promise<string> {
    if (!this.whisper?.isRunning()) throw new Error('voice mode is not active');
    const t0 = Date.now();
    const text = await this.whisper.transcribe(pcm, sampleRate);
    logger.info(`[voice:perf] transcribe wall=${Date.now() - t0}ms samples=${pcm.length} text="${text.slice(0, 60)}"`);
    return text;
  }

  cancelSpeech(): void {
    this.tts?.cancel();
  }

  async preview(voiceId: string): Promise<void> {
    const SAMPLE = "Hey, I'm Otto. This is how I sound — want me to keep this voice?";
    // Cancel any in-flight preview or TTS speech.
    this.tts?.cancel();
    this.previewGeneration++;
    const gen = this.previewGeneration;

    // Lazily init synth if not yet loaded (mirrors setModeImpl lazy path).
    if (!this.synth) {
      this.synth = await createKokoroSynth(this.opts.cacheDir);
    }

    // Guard: cancelled while we were loading.
    if (gen !== this.previewGeneration) return;

    const prefs = this.opts.getVoicePrefs();
    const { pcm, sampleRate } = await this.synth(SAMPLE, { voice: voiceId, speed: prefs.speed });

    if (gen !== this.previewGeneration) return;

    const buf = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
    this.opts.emit({ type: 'tts-chunk', pcm: buf, sampleRate });
  }

  async dispose(): Promise<void> {
    this.enabled = false;
    this.pipeline?.setEnabled(false, null);
    this.tts?.cancel();
    await this.whisper?.stop();
  }
}
