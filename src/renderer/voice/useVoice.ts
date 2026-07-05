// Owns the mic + VAD lifecycle and TTS playback for voice conversation mode.
// Utterance flow: VAD speech-end -> voice.transcribe (main) -> submitText().
// Barge-in: VAD speech-start while TTS is audible -> stop playback + flush
// the main-process synthesis queue. The agent turn is never interrupted.
import { useEffect, useRef } from 'react';
import type { MicVAD } from '@ricky0123/vad-web';
import { ipc } from '../ipc';
import { useOttoStore } from '../state/store';
import { PcmPlayer } from './player';

export function useVoice(opts: {
  /** Submit a transcript through the same path as typed messages. */
  submitText(text: string): Promise<void> | void;
  /** Resolve (possibly creating) the active session id. */
  ensureSession(): Promise<string>;
}): { toggle(): Promise<void> } {
  const vadRef = useRef<MicVAD | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const voiceMode = useOttoStore((s) => s.voiceMode);
  const setVoiceMode = useOttoStore((s) => s.setVoiceMode);
  const setVoiceState = useOttoStore((s) => s.setVoiceState);

  // TTS playback: subscribe to voice events while mounted.
  useEffect(() => {
    const player = new PcmPlayer(new AudioContext());
    player.onPlayingChange = (playing) => {
      const { voiceMode: on } = useOttoStore.getState();
      if (on) setVoiceState(playing ? 'speaking' : 'listening');
    };
    playerRef.current = player;
    const off = ipc.onVoiceEvent((e) => {
      if (e.type === 'tts-chunk') player.enqueue(new Float32Array(e.pcm), e.sampleRate);
      if (e.type === 'voice-error') {
        player.stop();
        setVoiceMode(false);
        void teardownVad(vadRef);
      }
    });
    return () => {
      off();
      player.stop();
    };
  }, [setVoiceMode, setVoiceState]);

  async function toggle(): Promise<void> {
    if (voiceMode) {
      setVoiceMode(false);
      playerRef.current?.stop();
      await teardownVad(vadRef);
      await ipc.invoke('voice.setMode', { enabled: false, sessionId: null });
      return;
    }

    const sessionId = await optsRef.current.ensureSession();
    await ipc.invoke('voice.setMode', { enabled: true, sessionId });

    const { MicVAD } = await import('@ricky0123/vad-web');
    const vad = await MicVAD.new({
      baseAssetPath: './vad/',
      onnxWASMBasePath: './vad/',
      onSpeechStart: () => {
        // Barge-in: user talking over Otto silences playback immediately.
        if (playerRef.current?.playing) {
          playerRef.current.stop();
          void ipc.invoke('voice.cancelSpeech', undefined);
        }
      },
      onSpeechEnd: (audio: Float32Array) => {
        void (async () => {
          setVoiceState('transcribing');
          try {
            const buf = audio.buffer.slice(
              audio.byteOffset,
              audio.byteOffset + audio.byteLength,
            ) as ArrayBuffer;
            const { text } = await ipc.invoke('voice.transcribe', {
              pcm: buf,
              sampleRate: 16000,
            });
            if (text) await optsRef.current.submitText(text);
          } catch (err) {
            console.error('transcription failed', err);
          } finally {
            if (useOttoStore.getState().voiceMode) setVoiceState('listening');
          }
        })();
      },
    });
    vad.start();
    vadRef.current = vad;
    setVoiceMode(true);
    setVoiceState('listening');
  }

  return { toggle };
}

async function teardownVad(
  ref: React.MutableRefObject<MicVAD | null>,
): Promise<void> {
  const vad = ref.current;
  ref.current = null;
  try {
    await vad?.destroy();
  } catch {
    // already destroyed
  }
}
