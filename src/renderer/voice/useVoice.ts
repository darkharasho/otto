// Owns the mic + VAD lifecycle and TTS playback for voice conversation mode.
// Utterance flow: VAD speech-end -> voice.transcribe (main) -> submitText().
// Barge-in: VAD speech-start while TTS is audible -> stop playback + flush
// the main-process synthesis queue. The agent turn is never interrupted.
import { useEffect, useRef, type RefObject, type MutableRefObject } from 'react';
import type { MicVAD } from '@ricky0123/vad-web';
import { ipc } from '../ipc';
import { useOttoStore } from '../state/store';
import { PcmPlayer } from './player';

function logErrorToMain(message: string): void {
  // Fire-and-forget: relay voice errors to the main-process logger so they
  // appear in the terminal during development/support.
  ipc.invoke('voice.logError', { message }).catch(() => {});
}

function surfaceVoiceError(cause: unknown): void {
  const msg = cause instanceof Error ? cause.message : String(cause);
  const session = useOttoStore.getState().activeSession;
  if (session) {
    useOttoStore.setState({
      activeSession: {
        ...session,
        error: {
          kind: 'internal',
          message: `Voice mode failed to start: ${msg}`,
          retryable: true,
        },
      },
    });
  }
  logErrorToMain(`Voice mode failed to start: ${msg}`);
}

export function useVoice(opts: {
  /** Submit a transcript through the same path as typed messages. */
  submitText(text: string): Promise<void> | void;
  /** Resolve (possibly creating) the active session id. */
  ensureSession(): Promise<string>;
  /** Optional ref to the mic button element for per-frame level animation. */
  micButtonRef?: RefObject<HTMLButtonElement>;
}): { toggle(): Promise<void> } {
  const vadRef = useRef<MicVAD | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const togglingRef = useRef(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  // rAF handle for frame-level mic level animation throttle.
  const rafRef = useRef<number | null>(null);

  const setVoiceMode = useOttoStore((s) => s.setVoiceMode);
  const setVoiceState = useOttoStore((s) => s.setVoiceState);

  // TTS playback: subscribe to voice events while mounted.
  useEffect(() => {
    const ctx = new AudioContext();
    const player = new PcmPlayer(ctx);
    player.onPlayingChange = (playing) => {
      const { voiceMode: on } = useOttoStore.getState();
      if (on) setVoiceState(playing ? 'speaking' : 'listening');
    };
    playerRef.current = player;
    const off = ipc.onVoiceEvent((e) => {
      if (e.type === 'tts-chunk') player.enqueue(new Float32Array(e.pcm), e.sampleRate);
      if (e.type === 'voice-error') {
        logErrorToMain(e.message);
        player.stop();
        setVoiceMode(false);
        void teardownVad(vadRef);
      }
    });
    return () => {
      off();
      player.stop();
      void ctx.close().catch(() => {});
      // Unmount teardown: if voice was active, clean up VAD and notify main process.
      if (useOttoStore.getState().voiceMode) {
        void teardownVad(vadRef);
        ipc.invoke('voice.setMode', { enabled: false, sessionId: null }).catch(() => {});
      }
    };
  }, [setVoiceMode, setVoiceState]);

  async function toggle(): Promise<void> {
    // Re-entrancy guard: rapid double-taps no-op on the second call.
    if (togglingRef.current) return;
    togglingRef.current = true;
    try {
      // Read fresh state rather than the closure-captured value.
      const on = useOttoStore.getState().voiceMode;
      if (on) {
        setVoiceMode(false);
        playerRef.current?.stop();
        // Cancel any pending rAF level animation.
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        await teardownVad(vadRef);
        await ipc.invoke('voice.setMode', { enabled: false, sessionId: null });
        return;
      }

      // Immediately signal that we are starting so the button reacts.
      setVoiceMode(true);
      setVoiceState('starting');

      try {
        const sessionId = await optsRef.current.ensureSession();
        await ipc.invoke('voice.setMode', { enabled: true, sessionId });

        const { MicVAD } = await import('@ricky0123/vad-web');
        const assetBase = new URL('vad/', document.baseURI).href;
        const vad = await MicVAD.new({
          baseAssetPath: assetBase,
          onnxWASMBasePath: assetBase,
          onFrameProcessed: (probabilities, _frame) => {
            // Drive a CSS custom property on the mic button so the animation
            // reflects actual speech energy without pushing through Zustand.
            const el = optsRef.current.micButtonRef?.current;
            if (!el) return;
            // SpeechProbabilities has a `isSpeech` float probability (0–1).
            const level = probabilities.isSpeech ?? 0;
            // Throttle DOM writes to one per animation frame.
            if (rafRef.current !== null) return;
            rafRef.current = requestAnimationFrame(() => {
              rafRef.current = null;
              el.style.setProperty('--mic-level', String(level));
            });
          },
          onSpeechStart: () => {
            // Barge-in: always cancel speech synthesis when voice mode is active;
            // additionally stop local playback if audio is currently playing.
            if (useOttoStore.getState().voiceMode) {
              if (playerRef.current?.playing) {
                playerRef.current.stop();
              }
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
        // Stash the VAD before start() so a start failure still tears it down.
        vadRef.current = vad;
        // Set state BEFORE starting VAD so any instant VAD event sees voiceMode true.
        setVoiceState('listening');
        vad.start();
      } catch (err) {
        // Roll back: sidecar off, partial VAD destroyed, UI shows voice off.
        console.error('voice enable failed', err);
        surfaceVoiceError(err);
        await ipc.invoke('voice.setMode', { enabled: false, sessionId: null }).catch(() => {});
        await teardownVad(vadRef);
        setVoiceMode(false);
        setVoiceState('idle');
      }
    } finally {
      togglingRef.current = false;
    }
  }

  return { toggle };
}

async function teardownVad(
  ref: MutableRefObject<MicVAD | null>,
): Promise<void> {
  const vad = ref.current;
  ref.current = null;
  try {
    await vad?.destroy();
  } catch {
    // already destroyed
  }
}
