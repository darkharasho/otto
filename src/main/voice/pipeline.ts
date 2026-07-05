// Bridges the main-process session-event fan-out to the TTS queue. Only
// `text-delta` events for the enabled session are spoken; reasoning and
// tool traffic stay silent by design (spec: never speak code/tool output).
import type { SessionEvent } from '@shared/ipc-contract';
import { SpeechTextStream } from '@shared/voice-text';
import type { TtsService } from './tts';

export class SpeechPipeline {
  private enabled = false;
  private sessionId: string | null = null;
  private stream = new SpeechTextStream();

  constructor(private readonly tts: Pick<TtsService, 'speak' | 'cancel'>) {}

  setEnabled(enabled: boolean, sessionId: string | null): void {
    const wasActive = this.enabled;
    this.enabled = enabled && sessionId !== null;
    this.sessionId = enabled ? sessionId : null;
    this.stream.reset();
    if (wasActive) this.tts.cancel();
  }

  handleSessionEvent(e: SessionEvent): void {
    if (!this.enabled) return;
    if (!('sessionId' in e) || e.sessionId !== this.sessionId) return;
    switch (e.type) {
      case 'text-delta':
        for (const sentence of this.stream.push(e.text)) this.tts.speak(sentence);
        break;
      case 'message-end':
      case 'done':
        for (const sentence of this.stream.flush()) this.tts.speak(sentence);
        break;
      case 'message-cancelled':
      case 'error':
        this.stream.reset();
        this.tts.cancel();
        break;
      default:
        break;
    }
  }
}
