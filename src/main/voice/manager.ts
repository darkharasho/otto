import path from 'node:path';
import type { SessionEvent } from '@shared/ipc-contract';
import type { VoiceEvent } from '@shared/voice';
import { WhisperService } from './whisper';
import { TtsService, createKokoroSynth, type SynthFn } from './tts';
import { SpeechPipeline } from './pipeline';
import { logger } from '../logger';

const MAX_RESPAWNS = 3;

export class VoiceManager {
  private whisper: WhisperService | null = null;
  private tts: TtsService | null = null;
  private synth: SynthFn | null = null;
  private pipeline: SpeechPipeline | null = null;
  private enabled = false;
  private respawns = 0;

  constructor(
    private readonly opts: {
      assetsDir: string; // resources/voice
      cacheDir: string; // <userData>/voice-models
      emit(e: VoiceEvent): void;
    }
  ) {}

  handleSessionEvent(e: SessionEvent): void {
    this.pipeline?.handleSessionEvent(e);
  }

  async setMode(enabled: boolean, sessionId: string | null): Promise<void> {
    if (!enabled) {
      this.enabled = false;
      this.pipeline?.setEnabled(false, null);
      this.tts?.cancel();
      await this.whisper?.stop();
      return;
    }

    this.enabled = true;
    this.respawns = 0;
    // Kokoro: load once, reuse across mode toggles (model load is seconds).
    if (!this.synth) this.synth = await createKokoroSynth(this.opts.cacheDir);
    if (!this.tts) this.tts = new TtsService(this.synth, this.opts.emit);
    if (!this.pipeline) this.pipeline = new SpeechPipeline(this.tts);

    if (!this.whisper) {
      const binary = path.join(this.opts.assetsDir, 'whisper-server');
      const model = path.join(this.opts.assetsDir, 'models', 'ggml-small.en.bin');
      this.whisper = new WhisperService({
        command: binary,
        args: (port) => ['-m', model, '--host', '127.0.0.1', '--port', String(port), '--threads', '4'],
        onExit: (code) => void this.handleWhisperExit(code),
      });
    }
    if (!this.whisper.isRunning()) await this.whisper.start();

    this.pipeline.setEnabled(true, sessionId);
    this.opts.emit({ type: 'voice-ready' });
  }

  private async handleWhisperExit(code: number | null): Promise<void> {
    if (!this.enabled) return;
    this.respawns++;
    logger.warn(`whisper-server exited (code ${code}), respawn ${this.respawns}/${MAX_RESPAWNS}`);
    if (this.respawns > MAX_RESPAWNS) {
      await this.setMode(false, null);
      this.opts.emit({ type: 'voice-error', message: 'Speech recognition crashed repeatedly; voice mode disabled.' });
      return;
    }
    await new Promise((r) => setTimeout(r, 500 * this.respawns));
    try {
      await this.whisper?.start();
    } catch (err) {
      logger.error(`whisper-server respawn failed: ${String(err)}`);
      void this.handleWhisperExit(null);
    }
  }

  async transcribe(pcm: Float32Array, sampleRate: number): Promise<string> {
    if (!this.whisper?.isRunning()) throw new Error('voice mode is not active');
    return this.whisper.transcribe(pcm, sampleRate);
  }

  cancelSpeech(): void {
    this.tts?.cancel();
  }

  async dispose(): Promise<void> {
    this.enabled = false;
    this.tts?.cancel();
    await this.whisper?.stop();
  }
}
