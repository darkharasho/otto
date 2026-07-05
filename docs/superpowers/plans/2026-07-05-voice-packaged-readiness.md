# Voice Packaged-Readiness Plan (Linux)

**Goal:** A packaged Linux build of Otto where voice mode works end-to-end: binary resolves outside asar, whisper models download to userData on first enable with visible progress, native ONNX deps unpack correctly, VAD assets load under file://.

**Context:** Phase 1 voice mode works in dev only. Known packaged breakers (from review): whisper-server path resolves into app.asar; whisper models exist only via the dev script; onnxruntime-node natives need asarUnpack; VAD/file:// and CSP unverified. Spec: docs/superpowers/specs/2026-07-04-voice-conversation-design.md (Model & binary management section).

## Global Constraints

- pnpm; vitest capped at 2 workers (never raise); `pnpm typecheck` (both tsconfigs) must stay clean; full `pnpm test` from repo root before every commit.
- Follow the existing SDK-binary pattern (`getSdkSpawnOverrides`, `src/main/agent/sdk-client.ts`) and electron-builder.yml conventions (asarUnpack list, extraResources).
- Whisper model URLs: pinned HF `ggerganov/whisper.cpp` `resolve/main/ggml-{base,small}.en.bin`. Download to `<userData>/voice-models/whisper/` with `.part` + rename; sha256 verify if upstream publishes checksums, else size sanity check (>100MB).
- `model-download-progress` VoiceEvent: `{ type: 'model-download-progress'; artifact: string; pct: number }` — add to the shared union (spec already names it).

## Task 1: Packaged-aware voice asset resolution

- `src/main/voice/paths.ts` (new): `resolveWhisperBinary(): string` — `app.isPackaged ? path.join(process.resourcesPath, 'voice', 'whisper-server') : path.join(app.getAppPath(), 'resources', 'voice', 'whisper-server')`; `whisperModelPath(model: 'base.en'|'small.en'): string` — userData/voice-models/whisper first, dev `resources/voice/models/` fallback when not packaged. Unit-testable pure parts separated from `app` access (inject flags/paths).
- `manager.ts` consumes these instead of the constructor `assetsDir` for the binary/model (keep cacheDir for Kokoro).
- Tests for the pure resolution logic.

## Task 2: Whisper model download on first enable + progress events

- `src/main/voice/model-download.ts` (new): `ensureWhisperModel(model, destDir, onProgress): Promise<string>` — idempotent, `.part` + atomic rename, resumable not required, progress callbacks throttled to whole-percent steps. Unit tests with a local http server fixture.
- `manager.ts` setModeImpl: before whisper start, if the model file is missing → download with `model-download-progress` events (artifact `whisper-small.en` etc.); failure → existing voice-error path.
- Renderer: while `starting`, show download progress — reuse the mic button title + the existing starting spinner; add a compact inline percent readout following existing CommandBar conventions. No new windows.

## Task 3: Packaging config

- `electron-builder.yml`: `extraResources` entry copying `resources/voice/whisper-server` → `voice/whisper-server` (binary only — models must NOT be packaged); asarUnpack for `**/node_modules/onnxruntime-node/**` (and verify @huggingface/transformers loads it from unpacked at runtime); confirm `out/renderer/vad/**` ships with the renderer files.
- Verify renderer CSP (index.html meta) permits WASM under packaged file:// — add `wasm-unsafe-eval` if a CSP is enforced and lacks it.

## Task 4: Packaged smoke test (Linux)

- Build a real package (`npx electron-builder --dir` or the repo's dist script — check package.json), launch the packaged binary, verify: app boots; voice enable path reaches "whisper-server ready" using the unpacked binary and a userData-downloaded model (move dev models aside to force the download path); `[voice:init]` shows native onnx backend. Mic interaction remains a human check.
- Fix whatever this surfaces; document residuals.
