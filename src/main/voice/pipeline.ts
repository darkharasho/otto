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
  private stream = new SpeechTextStream();
  /** Whether the first sentence of the current message has already been spoken. */
  private firstSpoken = false;
  /** Accumulated text for coalescing (subsequent sentences only). */
  private coalesceBuf = '';

  constructor(private readonly tts: Pick<TtsService, 'speak' | 'cancel'>) {}

  setEnabled(enabled: boolean, sessionId: string | null): void {
    const wasActive = this.enabled;
    this.enabled = enabled && sessionId !== null;
    this.sessionId = enabled ? sessionId : null;
    this.stream.reset();
    this.firstSpoken = false;
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
        this.firstSpoken = false;
        break;
      }
      case 'message-cancelled':
      case 'error':
        this.stream.reset();
        this.coalesceBuf = '';
        this.firstSpoken = false;
        this.tts.cancel();
        break;
      default:
        break;
    }
  }

  /**
   * Route sentences to TTS with coalescing:
   * - The very first sentence of a message is always spoken immediately (low latency).
   * - Subsequent sentences are accumulated in coalesceBuf and only spoken when
   *   the buffer reaches COALESCE_TARGET chars or a flush is forced.
   */
  private speakSentences(sentences: string[], flush: boolean): void {
    for (const s of sentences) {
      if (!this.firstSpoken) {
        // Flush any leftover coalesce buffer before speaking the first sentence
        // (defensive: shouldn't accumulate before first, but guard anyway).
        if (this.coalesceBuf) {
          this.tts.speak(this.coalesceBuf);
          this.coalesceBuf = '';
        }
        this.tts.speak(s);
        this.firstSpoken = true;
      } else {
        // Accumulate subsequent sentences; join with a space.
        this.coalesceBuf = this.coalesceBuf ? `${this.coalesceBuf} ${s}` : s;
        if (this.coalesceBuf.length >= COALESCE_TARGET) {
          this.tts.speak(this.coalesceBuf);
          this.coalesceBuf = '';
        }
      }
    }
    if (flush && this.coalesceBuf) {
      this.tts.speak(this.coalesceBuf);
      this.coalesceBuf = '';
    }
  }
}
