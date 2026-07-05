import { useEffect, useRef, useState } from 'react';
import { VOICE_CATALOG } from '@shared/voice-catalog';
import type { VoiceCatalogEntry } from '@shared/voice-catalog';
import { SubsectionPage } from './SubsectionPage';
import { ipc } from '../../ipc';
import { PcmPlayer } from '../../voice/player';
import type { VoiceEvent } from '@shared/voice';

const SPEED_OPTIONS: { value: number; label: string }[] = [
  { value: 0.80, label: '0.80×' },
  { value: 0.85, label: '0.85×' },
  { value: 0.90, label: '0.90×' },
  { value: 0.95, label: '0.95×' },
  { value: 1.00, label: '1.00×' },
  { value: 1.05, label: '1.05×' },
  { value: 1.10, label: '1.10×' },
  { value: 1.15, label: '1.15×' },
  { value: 1.20, label: '1.20×' },
  { value: 1.25, label: '1.25×' },
  { value: 1.30, label: '1.30×' },
];

const ENDPOINT_MS_OPTIONS: { value: number; label: string; hint: string }[] = [
  { value: 450, label: 'Snappy', hint: '450 ms' },
  { value: 650, label: 'Balanced', hint: '650 ms' },
  { value: 900, label: 'Relaxed', hint: '900 ms' },
];

export function VoiceSection({
  ttsVoice,
  speed,
  whisperModel,
  endpointMs,
  voiceAvailable = true,
  onVoiceChange,
  onSpeedChange,
  onWhisperModelChange,
  onEndpointMsChange,
}: {
  ttsVoice: string;
  speed: number;
  whisperModel: 'base.en' | 'small.en';
  endpointMs: number;
  voiceAvailable?: boolean;
  onVoiceChange: (voiceId: string) => void;
  onSpeedChange: (speed: number) => void;
  onWhisperModelChange: (model: 'base.en' | 'small.en') => void;
  onEndpointMsChange: (ms: number) => void;
}) {
  const [previewing, setPreviewing] = useState<string | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);

  // Set up AudioContext + PcmPlayer once on mount.
  useEffect(() => {
    const ctx = new AudioContext();
    ctxRef.current = ctx;
    const player = new PcmPlayer(ctx);
    playerRef.current = player;
    player.onPlayingChange = (playing) => {
      if (!playing) setPreviewing(null);
    };
    return () => {
      player.stop();
      void ctx.close();
    };
  }, []);

  // Subscribe to voice events only while a preview is pending.
  useEffect(() => {
    if (previewing === null) return;
    const off = ipc.onVoiceEvent((e: VoiceEvent) => {
      if (e.type === 'tts-chunk') {
        const pcm = new Float32Array(e.pcm);
        playerRef.current?.enqueue(pcm, e.sampleRate);
      }
    });
    return () => off();
  }, [previewing]);

  function handlePreview(entry: VoiceCatalogEntry) {
    playerRef.current?.stop();
    setPreviewing(entry.id);
    ipc.invoke('voice.preview', { voiceId: entry.id }).catch(() => {
      setPreviewing(null);
    });
  }

  function handleVoiceSelect(entry: VoiceCatalogEntry) {
    onVoiceChange(entry.id);
    void ipc.invoke('settings.setVoicePrefs', { ttsVoice: entry.id });
  }

  function handleSpeedChange(newSpeed: number) {
    onSpeedChange(newSpeed);
    void ipc.invoke('settings.setVoicePrefs', { speed: newSpeed });
  }

  function handleWhisperModelChange(model: 'base.en' | 'small.en') {
    onWhisperModelChange(model);
    void ipc.invoke('settings.setVoicePrefs', { whisperModel: model });
  }

  function handleEndpointMsChange(ms: number) {
    onEndpointMsChange(ms);
    void ipc.invoke('settings.setVoicePrefs', { endpointMs: ms });
  }

  if (!voiceAvailable) {
    return (
      <SubsectionPage
        title="Voice"
        description="Otto speaks during voice conversation mode. Choose a voice and preview how it sounds."
      >
        <div className="text-sm text-muted">
          Voice isn&apos;t available in this build. Voice requires the whisper-server binary, which is included in Linux releases only.
        </div>
      </SubsectionPage>
    );
  }

  return (
    <SubsectionPage
      title="Voice"
      description="Otto speaks during voice conversation mode. Choose a voice and preview how it sounds."
    >
      <div className="space-y-6">
        {/* Transcription model */}
        <div>
          <div className="text-xs font-semibold text-text mb-2">Transcription</div>
          <div className="flex gap-2">
            {([
              { value: 'base.en' as const, label: 'Fast', hint: 'base.en' },
              { value: 'small.en' as const, label: 'Accurate', hint: 'small.en' },
            ] satisfies { value: 'base.en' | 'small.en'; label: string; hint: string }[]).map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleWhisperModelChange(opt.value)}
                className={[
                  'flex flex-col items-start px-3 py-2 rounded-lg border text-sm transition-colors',
                  whisperModel === opt.value
                    ? 'border-accent/70 bg-accent/[0.10] text-text'
                    : 'border-border bg-bg/40 text-muted hover:text-text hover:bg-bg/60',
                ].join(' ')}
              >
                <span className="font-medium">{opt.label}</span>
                <span className="text-[11px] mt-0.5 opacity-70">{opt.hint}</span>
              </button>
            ))}
          </div>
          <div className="text-[11px] text-muted mt-1.5">Takes effect the next time voice mode is turned on.</div>
        </div>

        {/* Response pause */}
        <div>
          <div className="text-xs font-semibold text-text mb-2">Response pause</div>
          <div className="flex gap-2">
            {ENDPOINT_MS_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleEndpointMsChange(opt.value)}
                className={[
                  'flex flex-col items-start px-3 py-2 rounded-lg border text-sm transition-colors',
                  endpointMs === opt.value
                    ? 'border-accent/70 bg-accent/[0.10] text-text'
                    : 'border-border bg-bg/40 text-muted hover:text-text hover:bg-bg/60',
                ].join(' ')}
              >
                <span className="font-medium">{opt.label}</span>
                <span className="text-[11px] mt-0.5 opacity-70">{opt.hint}</span>
              </button>
            ))}
          </div>
          <div className="text-[11px] text-muted mt-1.5">How long Otto waits after you stop talking. Takes effect next time voice mode starts.</div>
        </div>

        {/* Speed control */}
        <div>
          <div className="text-xs font-semibold text-text mb-2">Speaking speed</div>
          <div className="flex items-center gap-3">
            <select
              value={speed}
              onChange={(e) => handleSpeedChange(parseFloat(e.target.value))}
              className="px-2 py-1.5 text-sm rounded-md bg-bg/60 border border-border text-text outline-none focus:border-accent/70"
            >
              {SPEED_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted">Default is 1.05×</span>
          </div>
        </div>

        {/* Voice list */}
        <div>
          <div className="text-xs font-semibold text-text mb-2">Voice</div>
          <div className="space-y-1">
            {VOICE_CATALOG.map((entry) => {
              const selected = entry.id === ttsVoice;
              const isPreviewPending = previewing === entry.id;
              return (
                <div
                  key={entry.id}
                  className={[
                    'relative flex items-center gap-3 pl-3 pr-2.5 py-2.5 rounded-lg transition-colors cursor-pointer',
                    selected
                      ? 'bg-gradient-to-r from-accent/[0.14] to-accent/[0.04] text-text shadow-[inset_0_0_14px_rgba(124,125,255,0.08)]'
                      : 'text-text hover:bg-bg/60',
                  ].join(' ')}
                  onClick={() => handleVoiceSelect(entry)}
                >
                  {selected && (
                    <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-accent" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{entry.label}</div>
                    <div className="text-[11px] text-muted mt-0.5">{entry.descriptor}</div>
                  </div>
                  <button
                    type="button"
                    aria-label={`Preview ${entry.label}`}
                    onClick={(evt) => {
                      evt.stopPropagation();
                      handlePreview(entry);
                    }}
                    disabled={isPreviewPending}
                    className={[
                      'flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-md transition-colors',
                      isPreviewPending
                        ? 'text-accent cursor-default'
                        : 'text-muted hover:text-text hover:bg-bg/60',
                    ].join(' ')}
                  >
                    {isPreviewPending ? (
                      <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                    ) : (
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7L8 5z" />
                      </svg>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </SubsectionPage>
  );
}
