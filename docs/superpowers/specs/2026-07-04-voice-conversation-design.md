# Voice Conversation Mode — Design

**Date:** 2026-07-04
**Status:** Approved pending review

## Summary

Add a voice conversation mode to Otto: a mic toggle puts the app into a hands-free
loop where the user speaks, Otto transcribes locally with whisper.cpp, routes the
text through the existing SDK session, and speaks its responses aloud with Kokoro
TTS. Everything runs on-device. Linux is the validation target; Windows and macOS
support is required before the feature is considered done.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Activation | Mic toggle + voice activity detection (VAD) decides utterance boundaries. No push-to-talk, no wake word. |
| STT | whisper.cpp, run as a long-lived `whisper-server` sidecar (model stays resident). Default model `small.en`, configurable. |
| TTS | Kokoro (~82M ONNX) via `kokoro-js` on `onnxruntime-node`, in the main process. Local, natural-sounding. |
| Barge-in | Speaking while Otto talks stops TTS playback immediately; the agent turn (including running tools) is **not** interrupted. The new utterance is transcribed and queued as the next message. |
| When Otto speaks | Voice mode is a session-level state: while on, all responses are spoken and the mic listens between turns; while off, Otto is a normal text chat. Code blocks and tool output are never spoken. |
| Platforms | Build and validate on Linux first. Cross-platform (win/mac) is a hard requirement for done, so all abstractions are platform-clean and the per-platform surface is minimized. |

## Architecture

```
Renderer                                Main
────────                                ────
mic (getUserMedia, 16 kHz mono)
  └─> VAD (@ricky0123/vad-web, Silero)
        └─ utterance PCM ──IPC──────>  WhisperService ──HTTP──> whisper-server (sidecar)
                                          └─ transcript ─IPC─> renderer
renderer submits transcript via
existing session.send path ─────────>  SessionManager (unchanged)
                                          │ text-delta events
                                       SpeechPipeline (filter + sentence chunker)
                                          └─> TtsService (kokoro-js)
Web Audio playback  <──IPC── PCM chunks ──┘
  └─ barge-in: VAD speech-start
     stops playback + cancels TTS queue
```

Only one artifact needs per-platform binaries: `whisper-server`. VAD is WASM,
Kokoro rides on `onnxruntime-node` npm prebuilds, everything else is JS.

## Components

### Renderer

**`VoiceController`** (new, `src/renderer/voice/`)
- Owns mic capture (`getUserMedia`, honoring an optional configured input device)
  and the VAD instance. `@ricky0123/vad-web` emits speech-start / speech-end with
  the utterance as 16 kHz mono Float32 PCM.
- On speech-end: sends the PCM buffer over IPC (`voice.transcribe`), receives the
  transcript, and submits it through the **existing** `session.send` path so the
  message appears in chat like any typed message.
- On speech-start while TTS is playing: stops local playback instantly and invokes
  `voice.cancelSpeech` so main flushes the synthesis queue (barge-in).
- Owns TTS playback: receives PCM chunks over the `voice.event` channel, queues
  them into Web Audio (`AudioContext` + buffer queue) for gapless sentence-by-
  sentence playback.

**Store additions** (`src/renderer/state/store.ts`)
- `voiceMode: boolean`
- `voiceState: 'idle' | 'listening' | 'transcribing' | 'speaking'`
- Mic toggle button in `CommandBar` with visual states (idle / listening pulse /
  speaking). Voice mode is per-window runtime state, not persisted.

### Main

**`WhisperService`** (new, `src/main/voice/whisper.ts`)
- Spawns `whisper-server` (localhost, random free port) when voice mode turns on;
  kills it when voice mode turns off or the app quits. Respawns with backoff on
  crash; after 3 consecutive failures, disables voice mode and surfaces an error.
- Binary path resolution follows the existing SDK-binary pattern
  (`getSdkSpawnOverrides` in `src/main/agent/sdk-client.ts`): asar-unpacked in
  packaged builds, repo-local `resources/` in dev.
- `transcribe(pcm: Float32Array): Promise<string>` — WAV-encodes and POSTs to the
  server, returns text. Empty/whitespace transcripts are dropped silently.

**`TtsService`** (new, `src/main/voice/tts.ts`)
- Wraps `kokoro-js`. Initializes lazily on first voice-mode enable (model load is
  a few seconds; renderer shows "warming up" state).
- Consumes a FIFO of sentences, synthesizes sequentially, emits PCM chunks to the
  renderer via `voice.event`. `cancel()` flushes the queue and aborts the current
  synthesis (barge-in).
- Voice id (`af_heart` default) and speaking speed come from settings.

**`SpeechPipeline`** (new, `src/main/voice/pipeline.ts`)
- Subscribes to the same session-event stream that feeds the renderer. Active only
  while voice mode is on, and only for the active session.
- Accumulates `text-delta` events, strips content that should never be spoken —
  fenced code blocks, inline code longer than a few words, tool-call cards, file
  paths/URLs get shortened ("a link") — and segments the remainder into sentences.
  Each complete sentence is handed to `TtsService`, so speech starts as soon as
  the first sentence of a response is complete rather than after the full turn.
- Pure functions (filter + chunker) are separated from the event plumbing for
  unit testing.

### IPC additions (`src/shared/ipc-contract.ts`)

Invoke channels:
- `voice.setMode(enabled: boolean)` — spawns/kills sidecar, inits/tears down TTS
- `voice.transcribe({ pcm: ArrayBuffer, sampleRate: number }) → { text: string }`
- `voice.cancelSpeech()` — barge-in flush
- `settings.setVoicePrefs(prefs)` — persistence

Event channel `voice.event` (broadcast, like `session.event`):
- `{ type: 'tts-chunk', pcm: ArrayBuffer, sampleRate }` — audio to play
- `{ type: 'tts-start' | 'tts-end' }` — drives `voiceState`
- `{ type: 'ready' | 'error', message? }` — sidecar/model lifecycle
- `{ type: 'model-download-progress', artifact, pct }` — first-run downloads

### Settings (`src/main/autonomy/settings.ts`, schema v6)

```ts
voice: {
  whisperModel: 'small.en',   // 'base.en' | 'small.en' | 'medium.en'
  ttsVoice: 'af_heart',
  speed: 1.0,
  inputDeviceId?: string,
}
```

Settings UI gets a Voice section (model picker, voice picker with a "preview"
button, input device dropdown).

## Model & binary management

Models are too large to bundle in the installer, so they download on first
voice-mode enable into `userData/voice-models/`, with progress reported over
`voice.event`:

| Artifact | Size | Source |
|---|---|---|
| whisper `small.en` (ggml) | ~466 MB | pinned Hugging Face URL, checksum-verified |
| Kokoro ONNX + voices | ~310 MB | pinned via kokoro-js cache dir pointed at `userData` |
| Silero VAD | ~2 MB | bundled with `@ricky0123/vad-web` (WASM assets served from app) |

The `whisper-server` **binary** ships with the app (it's small, ~1–2 MB plus
ggml libs): built per-platform in CI (linux-x64, darwin-arm64, darwin-x64 with
Metal, win-x64), fetched at package time by a script following
`scripts/fetch-embedding-model.mjs`, listed as asarUnpacked in
`electron-builder.yml`.

## Error handling

- **Mic permission denied** → toast with guidance, voice mode reverts to off.
- **whisper-server crash** → respawn with backoff; 3 strikes → voice mode off +
  error toast.
- **Transcription request fails/times out (5 s)** → drop the utterance, brief
  "didn't catch that" indicator, keep listening.
- **TTS synthesis error** → skip the sentence, continue the queue; repeated
  failures disable speaking (mode stays on for input) + toast.
- **Model download interrupted** → resumable/retryable; voice mode blocked until
  complete.
- **App quit** → sidecar killed via existing child-process cleanup on `before-quit`.

## Edge cases

- **User speaks while transcription of previous utterance is in flight**: both are
  transcribed and submitted in order — the session stream's existing message queue
  handles back-to-back sends.
- **Voice mode toggled off mid-speech**: playback stops, TTS queue flushes, sidecar
  gets a grace kill.
- **Responses that are entirely code/tool output**: pipeline produces nothing to
  speak — Otto stays silent, which is correct.
- **Echo (Otto hears itself)**: `getUserMedia` echo cancellation is enabled; VAD
  events during TTS playback are treated as barge-in only if they pass Silero's
  positive-speech threshold, which filters most speaker bleed. If real-world
  testing shows self-triggering, fall back to raising the VAD threshold while
  `voiceState === 'speaking'`.
- **Wayland/PipeWire mic capture**: Electron 33 uses PipeWire for `getUserMedia`
  on Wayland; flagged as a validation-phase risk to test early.

## Testing

- **Unit (vitest, maxWorkers=2):** speech filter (code-block stripping, URL
  shortening), sentence chunker (streaming deltas → sentence boundaries), TTS
  queue ordering + cancellation, WhisperService lifecycle with a stub binary.
- **Integration (manual, Linux):** full conversation loop — latency from
  speech-end to first spoken audio is the metric to watch (target: < 2 s with
  `small.en` on CPU).
- **Cross-platform phase:** repeat the manual loop on macOS and Windows;
  CI builds all whisper-server targets.

## Phasing

1. **Phase 1 — Linux end-to-end**: whisper-server (linux-x64 dev build), VAD mic
   capture, transcribe → session.send, speech pipeline + Kokoro playback,
   barge-in. Hardcoded defaults, models fetched by a dev script.
2. **Phase 2 — Product polish**: settings schema + UI, first-run model download
   UX with progress, error hardening, mic-toggle visual states.
3. **Phase 3 — Cross-platform (required for done)**: CI matrix for whisper-server
   binaries, packaging changes, macOS/Windows validation, per-platform mic
   permission flows (macOS `NSMicrophoneUsageDescription`, Windows privacy
   settings guidance).

## Out of scope (for now)

- Wake-word activation ("hey Otto")
- Full barge-in (interrupting the agent turn) — revisit after real usage
- Cloud TTS/STT options
- Non-English models (schema allows adding multilingual whisper models later)
