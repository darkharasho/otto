// Bridges the main-process session-event fan-out to the TTS queue. Only
// `text-delta` events for the enabled session are spoken; reasoning and
// tool traffic stay silent by design (spec: never speak code/tool output).
import type { SessionEvent } from '@shared/ipc-contract';
import { SpeechTextStream } from '@shared/voice-text';
import type { TtsService } from './tts';

const COALESCE_TARGET = 140;

export class SpeechPipeline {
  private enabled = false;
  private sessionId: string | null = null;
  private stream = new SpeechTextStream({ eagerFirstClause: true });
  /**
   * Ramp counter for emission ordering within a single message:
   *   0 = nothing spoken yet
   *   1 = first clause spoken (eager), next sentence goes out immediately
   *   2+ = coalesce toward COALESCE_TARGET as usual
   */
  private emitCount = 0;
  /** Accumulated text for coalescing (emission 3+). */
  private coalesceBuf = '';

  constructor(private readonly tts: Pick<TtsService, 'speak' | 'cancel'>) {}

  setEnabled(enabled: boolean, sessionId: string | null): void {
    const wasActive = this.enabled;
    this.enabled = enabled && sessionId !== null;
    this.sessionId = enabled ? sessionId : null;
    this.stream.reset();
    this.emitCount = 0;
    this.coalesceBuf = '';
    if (wasActive) this.tts.cancel();
  }

  handleSessionEvent(e: SessionEvent): void {
    if (!this.enabled) return;
    if (!('sessionId' in e) || e.sessionId !== this.sessionId) return;
    switch (e.type) {
      case 'text-delta': {
        const sentences = this.stream.push(e.text);
        this.speakSentences(sentences, false);
        break;
      }
      case 'message-end':
      case 'done': {
        const sentences = this.stream.flush();
        this.speakSentences(sentences, true);
        this.emitCount = 0;
        break;
      }
      case 'message-cancelled':
      case 'error':
        this.stream.reset();
        this.coalesceBuf = '';
        this.emitCount = 0;
        this.tts.cancel();
        break;
      default:
        break;
    }
  }

  /**
   * Route sentences to TTS with a three-phase ramp:
   * - Emission 1 (emitCount 0→1): eager first clause, spoken immediately for low latency.
   * - Emission 2 (emitCount 1→2): next complete sentence, also sent immediately (no buffering).
   *   This eliminates the pause while the coalesce buffer fills after the short first clause.
   * - Emission 3+ (emitCount ≥2): coalesce toward COALESCE_TARGET chars before emitting.
   */
  private speakSentences(sentences: string[], flush: boolean): void {
    for (const s of sentences) {
      if (this.emitCount === 0) {
        // Emission 1: eager first clause — defensive flush (shouldn't have a buffer yet).
        if (this.coalesceBuf) {
          this.tts.speak(this.coalesceBuf);
          this.coalesceBuf = '';
        }
        this.tts.speak(s);
        this.emitCount = 1;
      } else if (this.emitCount === 1) {
        // Emission 2: second sentence goes out immediately without coalescing.
        this.tts.speak(s);
        this.emitCount = 2;
      } else {
        // Emission 3+: accumulate toward COALESCE_TARGET.
        this.coalesceBuf = this.coalesceBuf ? `${this.coalesceBuf} ${s}` : s;
        if (this.coalesceBuf.length >= COALESCE_TARGET) {
          this.tts.speak(this.coalesceBuf);
          this.coalesceBuf = '';
          this.emitCount++;
        }
      }
    }
    if (flush && this.coalesceBuf) {
      this.tts.speak(this.coalesceBuf);
      this.coalesceBuf = '';
    }
  }
}
