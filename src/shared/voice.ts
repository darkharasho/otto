export const VOICE_EVENT_CHANNEL = 'voice.event';

export type VoiceEvent =
  | { type: 'tts-start' }
  | { type: 'tts-chunk'; pcm: ArrayBuffer; sampleRate: number }
  | { type: 'tts-end' }
  | { type: 'voice-ready' }
  | { type: 'voice-error'; message: string };
// Note: UI 'speaking' state derives from renderer playback (PcmPlayer.onPlayingChange), not tts-start/tts-end.

export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'speaking';
