export const VOICE_EVENT_CHANNEL = 'voice.event';

export type VoiceEvent =
  | { type: 'tts-start' }
  | { type: 'tts-chunk'; pcm: ArrayBuffer; sampleRate: number }
  | { type: 'tts-end' }
  | { type: 'voice-ready' }
  | { type: 'voice-error'; message: string };

export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'speaking';
