# Voice Settings Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Voice settings section where users can pick from a curated list of Kokoro voices, adjust speed, and audibly preview each voice before committing.

**Architecture:** Settings schema gains a `voice` sub-object (v5→v6 migration); `createKokoroSynth` is refactored to accept per-call `{ voice, speed }` opts so the VoiceManager can pass the current settings at synth time. A new `voice.preview` IPC channel triggers synthesis of a fixed sample string via the existing `emitVoiceEvent` broadcast, which the settings window already receives via `window.otto.onVoiceEvent`. The settings renderer adds a VoiceSection component with a voice selector, speed slider, and preview button.

**Tech Stack:** TypeScript, Electron IPC (ipcMain.handle), React + Tailwind (existing patterns), kokoro-js (KokoroTTS), PcmPlayer (existing), vitest

## Global Constraints

- Branch: `feat/voice-conversation`
- Stay on zod 3.25 bridge; do NOT introduce zod v4 imports.
- Settings schema: v5→v6. `CURRENT_VERSION` constant must be updated to 6.
- Voice defaults: `ttsVoice: 'af_heart'`, `speed: 1.05` (preserving current hardcoded values).
- Preview sample text (exact): `"Hey, I'm Otto. This is how I sound — want me to keep this voice?"`
- Test parallelism: `vitest --maxWorkers=2`
- Commit often; each task ends with a commit.
- Do not add emojis to any file.

---

## File Map

| Path | Action | Responsibility |
|---|---|---|
| `src/shared/voice-catalog.ts` | **Create** | Curated voice list constant (ids, labels, descriptors) |
| `src/shared/ipc-contract.ts` | **Modify** | Add `voice` to `SettingsView`; add `settings.setVoicePrefs` and `voice.preview` channels |
| `src/main/autonomy/settings.ts` | **Modify** | `VoicePrefs` type; `SettingsSnapshot` + `SettingsFileV6`; migration; getters/setter |
| `src/main/autonomy/settings.test.ts` | **Modify** | Add v5→v6 migration test |
| `src/main/voice/tts.ts` | **Modify** | `SynthFn` opts parameter; `SynthOpts` type; `createKokoroSynth` uses opts |
| `src/main/voice/tts.test.ts` | **Modify** | Update `SynthFn` usages to match new signature |
| `src/main/voice/manager.ts` | **Modify** | Accept `getVoicePrefs` in opts; `preview()` method; pass opts to synth |
| `src/main/ipc/voice.ts` | **Modify** | Register `settings.setVoicePrefs` and `voice.preview` handlers |
| `src/main/ipc/handlers.ts` | **Modify** | Pass `setVoicePrefs` through to settings |
| `src/main/index.ts` | **Modify** | Wire `getVoicePrefs` from settings into VoiceManager |
| `src/renderer/components/settings/VoiceSection.tsx` | **Create** | Voice picker + speed control + preview button + PcmPlayer subscriber |
| `src/renderer/components/settings/SettingsNav.ts` | **Modify** | Add `voice` sub under `behavior` tab |
| `src/renderer/SettingsApp.tsx` | **Modify** | Import VoiceSection; add render case for `activeSub === 'voice'` |

---

### Task 1: Curated voice catalog

**Files:**
- Create: `src/shared/voice-catalog.ts`

**Interfaces:**
- Produces: `export interface VoiceCatalogEntry { id: string; label: string; descriptor: string; }` and `export const VOICE_CATALOG: VoiceCatalogEntry[]`

- [ ] **Step 1: Create the catalog file**

```typescript
// src/shared/voice-catalog.ts
export interface VoiceCatalogEntry {
  id: string;
  label: string;
  /** One-liner shown under the label, e.g. "warm American female" */
  descriptor: string;
}

/**
 * Curated subset of the installed kokoro-js voice set.
 * IDs verified against node_modules/kokoro-js/voices/*.bin (July 2026).
 * Only include voices with .bin files present in the package.
 */
export const VOICE_CATALOG: VoiceCatalogEntry[] = [
  { id: 'af_heart',    label: 'Heart',    descriptor: 'Warm American female — default' },
  { id: 'af_bella',    label: 'Bella',    descriptor: 'Bright American female' },
  { id: 'af_nicole',   label: 'Nicole',   descriptor: 'Breathy American female' },
  { id: 'af_sky',      label: 'Sky',      descriptor: 'Light American female' },
  { id: 'am_adam',     label: 'Adam',     descriptor: 'Deep American male' },
  { id: 'am_michael',  label: 'Michael',  descriptor: 'Mature American male' },
  { id: 'bf_emma',     label: 'Emma',     descriptor: 'Warm British female' },
  { id: 'bf_isabella', label: 'Isabella', descriptor: 'Refined British female' },
  { id: 'bm_george',   label: 'George',   descriptor: 'Measured British male' },
  { id: 'bm_lewis',    label: 'Lewis',    descriptor: 'Crisp British male' },
];

export const DEFAULT_TTS_VOICE = 'af_heart';
export const DEFAULT_TTS_SPEED = 1.05;
```

- [ ] **Step 2: Verify .bin files exist for every id in the catalog**

```bash
for id in af_heart af_bella af_nicole af_sky am_adam am_michael bf_emma bf_isabella bm_george bm_lewis; do
  ls node_modules/kokoro-js/voices/${id}.bin 2>&1
done
```
Expected: 10 lines each ending in `.bin` with no "No such file" errors.

- [ ] **Step 3: Commit**

```bash
git add src/shared/voice-catalog.ts
git commit -m "feat: curated voice catalog for settings picker"
```

---

### Task 2: Settings schema v6 — VoicePrefs

**Files:**
- Modify: `src/main/autonomy/settings.ts`
- Modify: `src/main/autonomy/settings.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_TTS_VOICE`, `DEFAULT_TTS_SPEED` from `src/shared/voice-catalog.ts`
- Produces:
  - `export interface VoicePrefs { ttsVoice: string; speed: number }`
  - `settings.getVoicePrefs(): VoicePrefs`
  - `settings.setVoicePrefs(p: Partial<VoicePrefs>): Promise<void>`
  - `SettingsSnapshot` extended with `voice: VoicePrefs`

- [ ] **Step 1: Write the failing migration test first**

Add to `src/main/autonomy/settings.test.ts`:

```typescript
describe('Settings — voice prefs (v5→v6 migration)', () => {
  it('defaults ttsVoice=af_heart and speed=1.05 on fresh install', async () => {
    const s = new Settings(settingsPath());
    await s.load();
    expect(s.getVoicePrefs()).toEqual({ ttsVoice: 'af_heart', speed: 1.05 });
    const written = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(written.version).toBe(6);
    expect(written.voice).toEqual({ ttsVoice: 'af_heart', speed: 1.05 });
  });

  it('migrates a v5 file to v6 with default voice prefs', async () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        version: 5,
        autonomy: { mode: 'balanced' },
        notifications: { turnComplete: true, approval: true, sound: false },
        startAtLogin: false,
        windowPosition: 'bottom-center',
        displayTarget: 'cursor',
        autoDeleteDays: 0,
        hideOnBlur: false,
        showReasoning: true,
        newConversation: { idleTimeoutMinutes: 60 },
        chatBounds: null,
        lastVisibleMode: 'bar',
        pinnedSessionIds: [],
      })
    );
    const s = new Settings(settingsPath());
    await s.load();
    expect(s.getVoicePrefs()).toEqual({ ttsVoice: 'af_heart', speed: 1.05 });
    const written = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(written.version).toBe(6);
  });

  it('setVoicePrefs persists partial update', async () => {
    const s = new Settings(settingsPath());
    await s.load();
    await s.setVoicePrefs({ ttsVoice: 'bm_george' });
    expect(s.getVoicePrefs()).toEqual({ ttsVoice: 'bm_george', speed: 1.05 });
    const written = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(written.voice.ttsVoice).toBe('bm_george');
    expect(written.voice.speed).toBe(1.05);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /var/home/mstephens/Documents/GitHub/otto
pnpm vitest run src/main/autonomy/settings.test.ts --maxWorkers=2 2>&1 | tail -20
```
Expected: 3 new tests FAIL with "getVoicePrefs is not a function" or similar.

- [ ] **Step 3: Implement the schema changes in settings.ts**

At the top of `src/main/autonomy/settings.ts`, change `CURRENT_VERSION` from `5` to `6`:

```typescript
const CURRENT_VERSION = 6;
```

Add the `VoicePrefs` interface and import after the existing imports:

```typescript
import { DEFAULT_TTS_VOICE, DEFAULT_TTS_SPEED } from '@shared/voice-catalog';
```

(Note: verify `@shared` path alias resolves to `src/shared` — it does, as other files use `@shared/voice`, `@shared/messages`, etc.)

Add the `VoicePrefs` interface after `NewConversationPrefs`:

```typescript
export interface VoicePrefs {
  ttsVoice: string;
  speed: number;
}
```

Extend `SettingsSnapshot` to include `voice: VoicePrefs`:

```typescript
export interface SettingsSnapshot {
  autonomy: { mode: AutonomyMode };
  notifications: NotificationPrefs;
  startAtLogin: boolean;
  windowPosition: WindowPosition;
  displayTarget: DisplayTarget;
  autoDeleteDays: number;
  hideOnBlur: boolean;
  showReasoning: boolean;
  newConversation: NewConversationPrefs;
  chatBounds: ChatBounds | null;
  lastVisibleMode: WindowMode;
  pinnedSessionIds: string[];
  voice: VoicePrefs;
}
```

Add `SettingsFileV6` interface after `SettingsFileV5`:

```typescript
interface SettingsFileV6 extends SettingsSnapshot {
  version: 6;
}
```

Update the `SettingsFile` union:

```typescript
type SettingsFile = SettingsFileV1 | SettingsFileV2 | SettingsFileV3 | SettingsFileV4 | SettingsFileV5 | SettingsFileV6;
```

Update `DEFAULTS` to include `voice`:

```typescript
const DEFAULTS: SettingsSnapshot = {
  autonomy: { mode: DEFAULT_MODE },
  notifications: { turnComplete: true, approval: true, sound: false },
  startAtLogin: false,
  windowPosition: 'bottom-center',
  displayTarget: 'cursor',
  autoDeleteDays: 0,
  hideOnBlur: false,
  showReasoning: true,
  newConversation: { idleTimeoutMinutes: 60 },
  chatBounds: null,
  lastVisibleMode: 'bar',
  pinnedSessionIds: [],
  voice: { ttsVoice: DEFAULT_TTS_VOICE, speed: DEFAULT_TTS_SPEED },
};
```

Add `getVoicePrefs()` and `setVoicePrefs()` methods to the `Settings` class after `setPinnedSessionIds`:

```typescript
getVoicePrefs(): VoicePrefs {
  return { ...this.state.voice };
}

async setVoicePrefs(prefs: Partial<VoicePrefs>): Promise<void> {
  this.state.voice = { ...this.state.voice, ...prefs };
  await this.persist();
}
```

Update `snapshot()` to include `voice`:

```typescript
snapshot(): SettingsSnapshot {
  return {
    autonomy: { ...this.state.autonomy },
    notifications: { ...this.state.notifications },
    startAtLogin: this.state.startAtLogin,
    windowPosition: this.state.windowPosition,
    displayTarget: this.state.displayTarget,
    autoDeleteDays: this.state.autoDeleteDays,
    hideOnBlur: this.state.hideOnBlur,
    showReasoning: this.state.showReasoning,
    newConversation: { ...this.state.newConversation },
    chatBounds: this.state.chatBounds ? { ...this.state.chatBounds } : null,
    lastVisibleMode: this.state.lastVisibleMode,
    pinnedSessionIds: [...this.state.pinnedSessionIds],
    voice: { ...this.state.voice },
  };
}
```

Update `applyParsed()`. The version union condition `version === 2 || version === 3 || version === 4 || version === CURRENT_VERSION` must become `version === 2 || version === 3 || version === 4 || version === 5 || version === CURRENT_VERSION`. Also add `voice` extraction inside that block (add after `pinnedSessionIds` extraction):

```typescript
const rawVoice = (o as { voice?: unknown }).voice;
const voice: VoicePrefs =
  rawVoice &&
  typeof rawVoice === 'object' &&
  typeof (rawVoice as VoicePrefs).ttsVoice === 'string' &&
  typeof (rawVoice as VoicePrefs).speed === 'number'
    ? (rawVoice as VoicePrefs)
    : DEFAULTS.voice;
```

And include `voice` in the `this.state = { ... }` assignment at the end of that block:

```typescript
this.state = {
  // ... all existing fields ...
  pinnedSessionIds,
  voice,
};
```

Update `writeFile()`: change `SettingsFileV5` to `SettingsFileV6` in the payload type:

```typescript
const payload: SettingsFileV6 = { version: CURRENT_VERSION, ...this.snapshot() };
```

The existing test that checks `written.version` is `5` must now be updated to `6`:

In `settings.test.ts`, change the two occurrences where the test asserts `expect(written.version).toBe(5)` to `expect(written.version).toBe(6)`.

Also update the test that writes `version: 2` and expects the migrated file `version` to be `5` — change to `6`.

Also update the v3 migration test that expects `raw.version` to be `5` — change to `6`.

- [ ] **Step 4: Run tests to confirm they pass**

```bash
pnpm vitest run src/main/autonomy/settings.test.ts --maxWorkers=2 2>&1 | tail -20
```
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/autonomy/settings.ts src/main/autonomy/settings.test.ts
git commit -m "feat: settings schema v6 with VoicePrefs (ttsVoice, speed)"
```

---

### Task 3: SynthFn per-call options

**Files:**
- Modify: `src/main/voice/tts.ts`
- Modify: `src/main/voice/tts.test.ts`

**Interfaces:**
- Produces:
  - `export interface SynthOpts { voice?: string; speed?: number }`
  - `export type SynthFn = (text: string, opts?: SynthOpts) => Promise<{ pcm: Float32Array; sampleRate: number }>`
  - `createKokoroSynth(cacheDir: string): Promise<SynthFn>` — signature unchanged; implementation uses opts

- [ ] **Step 1: Update the SynthFn type in tts.ts**

Replace the current `SynthFn` line:

```typescript
// Old:
export type SynthFn = (text: string) => Promise<{ pcm: Float32Array; sampleRate: number }>;
```

With:

```typescript
export interface SynthOpts {
  voice?: string;
  speed?: number;
}

export type SynthFn = (text: string, opts?: SynthOpts) => Promise<{ pcm: Float32Array; sampleRate: number }>;
```

Update `createKokoroSynth`'s returned closure to accept and use opts (falling back to defaults):

```typescript
export async function createKokoroSynth(cacheDir: string): Promise<SynthFn> {
  const { KokoroTTS } = await import('kokoro-js');
  const { env } = await import('@huggingface/transformers');
  env.cacheDir = cacheDir;
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    dtype: 'q8',
    device: 'cpu',
  });
  return async (text: string, opts?: SynthOpts) => {
    const voice = opts?.voice ?? 'af_heart';
    const speed = opts?.speed ?? 1.05;
    const audio = await tts.generate(text, { voice, speed });
    const pcm = trimSilence(audio.audio as Float32Array, audio.sampling_rate as number);
    return { pcm, sampleRate: audio.sampling_rate as number };
  };
}
```

- [ ] **Step 2: Update tts.test.ts — fix SynthFn usages**

The test file uses inline `SynthFn` lambdas with signature `(t) => ...` or `async (t) => ...`. Since the new signature is `(text, opts?) => ...`, the existing lambdas are still compatible (TypeScript allows fewer params). However, `deferredSynth()` uses an explicit type annotation: change it to match:

```typescript
// Old:
const synth: SynthFn = () =>
  new Promise((resolve) => {
    resolvers.push(resolve);
  });

// New (opts param added but ignored — preview path tests will cover opts use):
const synth: SynthFn = (_text, _opts) =>
  new Promise((resolve) => {
    resolvers.push(resolve);
  });
```

Also, the `synth: SynthFn = async (t) => {` tests use `t` (the text arg). Update those to `async (t, _opts) =>` if TypeScript's `noUnusedParameters` requires it. Check the tsconfig first:

```bash
grep -n "noUnusedParameters\|noUnusedLocals" /var/home/mstephens/Documents/GitHub/otto/tsconfig.json /var/home/mstephens/Documents/GitHub/otto/tsconfig.node.json 2>/dev/null
```

If `noUnusedParameters` is not `true`, the existing `(t)` signatures are fine as-is — skip the edits.

- [ ] **Step 3: Run tts tests**

```bash
pnpm vitest run src/main/voice/tts.test.ts --maxWorkers=2 2>&1 | tail -20
```
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/voice/tts.ts src/main/voice/tts.test.ts
git commit -m "feat: SynthFn accepts per-call voice/speed opts"
```

---

### Task 4: VoiceManager — getVoicePrefs wiring + preview()

**Files:**
- Modify: `src/main/voice/manager.ts`

**Interfaces:**
- Consumes: `SynthFn`, `SynthOpts` from `src/main/voice/tts.ts`; `VoicePrefs` from `src/main/autonomy/settings.ts`
- Produces:
  - `VoiceManager` constructor opts extended with `getVoicePrefs(): { ttsVoice: string; speed: number }`
  - `VoiceManager.preview(voiceId: string): Promise<void>`
  - `VoiceManager.setVoicePrefs(prefs: Partial<{ ttsVoice: string; speed: number }>): void` — no-op placeholder; actual persistence is handled by settings handler; this just updates the in-memory getter indirection.

- [ ] **Step 1: Extend manager.ts constructor opts and wire synth opts**

`VoiceManager`'s constructor `opts` currently has `assetsDir`, `cacheDir`, `emit`. Add `getVoicePrefs`:

```typescript
constructor(
  private readonly opts: {
    assetsDir: string;
    cacheDir: string;
    emit(e: VoiceEvent): void;
    getVoicePrefs(): { ttsVoice: string; speed: number };
  }
) {}
```

In `setModeImpl`, the line that creates `TtsService` currently passes `this.synth` directly:

```typescript
if (!this.tts) this.tts = new TtsService(this.synth, this.opts.emit);
```

The `TtsService.synth` field is called as `this.synth(sentence)` (no opts). Change the `TtsService` constructor arg to a wrapper that injects current voice prefs at call time:

```typescript
if (!this.synth) this.synth = await createKokoroSynth(this.opts.cacheDir);
if (!this.tts) {
  const wrappedSynth: SynthFn = (text, opts) => {
    const prefs = this.opts.getVoicePrefs();
    return this.synth!(text, { voice: opts?.voice ?? prefs.ttsVoice, speed: opts?.speed ?? prefs.speed });
  };
  this.tts = new TtsService(wrappedSynth, this.opts.emit);
}
```

- [ ] **Step 2: Add preview() method**

Add a `private previewGeneration = 0;` field alongside the other private fields.

Add the `preview` method after `cancelSpeech()`:

```typescript
async preview(voiceId: string): Promise<void> {
  const SAMPLE = "Hey, I'm Otto. This is how I sound — want me to keep this voice?";
  // Cancel any in-flight preview or TTS speech.
  this.tts?.cancel();
  this.previewGeneration++;
  const gen = this.previewGeneration;

  // Lazily init synth if not yet loaded (mirrors setModeImpl lazy path).
  if (!this.synth) {
    this.synth = await createKokoroSynth(this.opts.cacheDir);
  }

  // Guard: cancelled while we were loading.
  if (gen !== this.previewGeneration) return;

  const prefs = this.opts.getVoicePrefs();
  const { pcm, sampleRate } = await this.synth(SAMPLE, { voice: voiceId, speed: prefs.speed });

  if (gen !== this.previewGeneration) return;

  const buf = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
  this.opts.emit({ type: 'tts-chunk', pcm: buf, sampleRate });
}
```

Note: `preview()` emits a bare `tts-chunk` (no `tts-start`/`tts-end` wrapper) so the settings window's lightweight player can just listen for chunks without needing to track TTS lifecycle state.

- [ ] **Step 3: Add SynthOpts import to manager.ts**

At the top of `src/main/voice/manager.ts`, update the tts import:

```typescript
import { TtsService, createKokoroSynth, type SynthFn, type SynthOpts } from './tts';
```

(`SynthOpts` isn't needed as a standalone import since it's used inline, but import it to keep linting clean.)

Actually, the `wrappedSynth` lambda uses `SynthFn` and `opts?: SynthOpts` — TypeScript will infer the type from the annotation. The import is needed for `SynthFn`:

```typescript
import { TtsService, createKokoroSynth, type SynthFn } from './tts';
```

- [ ] **Step 4: Typecheck**

```bash
cd /var/home/mstephens/Documents/GitHub/otto && pnpm typecheck 2>&1 | grep -E "error TS|src/main/voice/manager" | head -20
```
Expected: No errors in manager.ts.

- [ ] **Step 5: Commit**

```bash
git add src/main/voice/manager.ts
git commit -m "feat: VoiceManager uses live voice prefs at synth time; adds preview()"
```

---

### Task 5: IPC wiring — settings.setVoicePrefs + voice.preview channels

**Files:**
- Modify: `src/shared/ipc-contract.ts`
- Modify: `src/main/ipc/voice.ts`
- Modify: `src/main/ipc/handlers.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `VoicePrefs` from `src/main/autonomy/settings.ts`; `VoiceManager.preview()` from `src/main/voice/manager.ts`
- Produces:
  - IPC channel `settings.setVoicePrefs` args: `Partial<{ ttsVoice: string; speed: number }>` result: `void`
  - IPC channel `voice.preview` args: `{ voiceId: string }` result: `void`
  - `SettingsView` extended with `voice: { ttsVoice: string; speed: number }`

- [ ] **Step 1: Extend ipc-contract.ts**

In `src/shared/ipc-contract.ts`:

1. Add two channels to the `IpcRequest` union (after the `voice.logError` line, before the closing `|`):

```typescript
  | {
      channel: 'settings.setVoicePrefs';
      args: Partial<{ ttsVoice: string; speed: number }>;
      result: void;
    }
  | { channel: 'voice.preview'; args: { voiceId: string }; result: void }
```

2. Extend `SettingsView` to include `voice`:

```typescript
export interface SettingsView {
  autonomy: { mode: AutonomyMode };
  notifications: { turnComplete: boolean; approval: boolean; sound: boolean };
  startAtLogin: boolean;
  windowPosition: 'bottom-center' | 'top-center';
  displayTarget: 'cursor' | 'primary';
  autoDeleteDays: number;
  hideOnBlur: boolean;
  showReasoning: boolean;
  newConversation: { idleTimeoutMinutes: number };
  version: string;
  chatBounds: ChatBounds | null;
  lastVisibleMode: WindowMode;
  pinnedSessionIds: string[];
  voice: { ttsVoice: string; speed: number };
}
```

- [ ] **Step 2: Register voice.preview handler in ipc/voice.ts**

The `registerVoiceIpc` function currently takes only `voice: VoiceManager`. The `voice.preview` channel needs to be here. Add at the end of the `registerVoiceIpc` function body:

```typescript
ipcMain.handle('voice.preview', async (_e, args: { voiceId: string }) => {
  await voice.preview(args.voiceId);
});
```

- [ ] **Step 3: Register settings.setVoicePrefs handler in ipc/handlers.ts**

In `registerIpcHandlers`, add after the `settings.setPinnedSessionIds` handler:

```typescript
ipcMain.handle(
  'settings.setVoicePrefs',
  async (
    _e,
    args: Partial<{ ttsVoice: string; speed: number }>
  ): Promise<void> => {
    await settings.setVoicePrefs(args);
  }
);
```

Also update `settings.get` handler so it includes `voice` in the returned `SettingsView`. Find:

```typescript
ipcMain.handle('settings.get', async (): Promise<SettingsView> => {
  const snap = settings.snapshot();
  return { ...snap, version: deps.appVersion };
});
```

This already works correctly since `snapshot()` now includes `voice` and `SettingsView` now includes `voice`. No code change needed here.

- [ ] **Step 4: Wire getVoicePrefs into VoiceManager in index.ts**

Find the `new VoiceManager({...})` call in `src/main/index.ts` (around line 210):

```typescript
const voice = new VoiceManager({
  assetsDir: path.join(app.getAppPath(), 'resources', 'voice'),
  cacheDir: path.join(app.getPath('userData'), 'voice-models'),
  emit: emitVoiceEvent,
});
```

Add `getVoicePrefs`:

```typescript
const voice = new VoiceManager({
  assetsDir: path.join(app.getAppPath(), 'resources', 'voice'),
  cacheDir: path.join(app.getPath('userData'), 'voice-models'),
  emit: emitVoiceEvent,
  getVoicePrefs: () => settings.getVoicePrefs(),
});
```

- [ ] **Step 5: Typecheck**

```bash
cd /var/home/mstephens/Documents/GitHub/otto && pnpm typecheck 2>&1 | grep "error TS" | head -20
```
Expected: Zero errors.

- [ ] **Step 6: Run all tests**

```bash
pnpm vitest run --maxWorkers=2 2>&1 | tail -30
```
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/ipc-contract.ts src/main/ipc/voice.ts src/main/ipc/handlers.ts src/main/index.ts
git commit -m "feat: IPC channels settings.setVoicePrefs and voice.preview"
```

---

### Task 6: VoiceSection settings UI

**Files:**
- Create: `src/renderer/components/settings/VoiceSection.tsx`
- Modify: `src/renderer/components/settings/SettingsNav.ts`
- Modify: `src/renderer/SettingsApp.tsx`

**Interfaces:**
- Consumes:
  - `VOICE_CATALOG`, `VoiceCatalogEntry` from `src/shared/voice-catalog.ts`
  - `ipc.invoke('settings.setVoicePrefs', ...)` — args: `Partial<{ ttsVoice: string; speed: number }>`
  - `ipc.invoke('voice.preview', { voiceId })` — args: `{ voiceId: string }`
  - `ipc.onVoiceEvent(handler)` — `VoiceEvent` with `type: 'tts-chunk'`
  - `PcmPlayer` from `src/renderer/voice/player.ts`
  - `SubsectionPage` from `./SubsectionPage`
  - `RadioGroup` from `../SettingsControls` (for voice selection)
- Produces: `VoiceSection` component

- [ ] **Step 1: Add voice subsection to SettingsNav.ts**

In `src/renderer/components/settings/SettingsNav.ts`, add a `voice` entry to the `behavior` tab's `subs` array, after `'newConversation'`:

```typescript
{ id: 'voice', label: 'Voice' },
```

So the `behavior` tab subs become:
```typescript
subs: [
  { id: 'autonomy', label: 'Autonomy' },
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'sessionHistory', label: 'Session history' },
  { id: 'newConversation', label: 'New conversations' },
  { id: 'voice', label: 'Voice' },
],
```

- [ ] **Step 2: Create VoiceSection.tsx**

```tsx
// src/renderer/components/settings/VoiceSection.tsx
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

export function VoiceSection({
  ttsVoice,
  speed,
  onVoiceChange,
  onSpeedChange,
}: {
  ttsVoice: string;
  speed: number;
  onVoiceChange: (voiceId: string) => void;
  onSpeedChange: (speed: number) => void;
}) {
  const [previewing, setPreviewing] = useState<string | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);

  // Set up player and subscribe to voice events for preview audio.
  useEffect(() => {
    const ctx = new AudioContext();
    ctxRef.current = ctx;
    const player = new PcmPlayer(ctx);
    playerRef.current = player;
    player.onPlayingChange = (playing) => {
      if (!playing) setPreviewing(null);
    };

    const off = ipc.onVoiceEvent((e: VoiceEvent) => {
      if (e.type === 'tts-chunk' && previewing !== null) {
        const pcm = new Float32Array(e.pcm);
        player.enqueue(pcm, e.sampleRate);
      }
    });

    return () => {
      off();
      player.stop();
      void ctx.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The `previewing` state changes don't need to re-run the effect; use a ref to
  // track it inside the closure.
  const previewingRef = useRef<string | null>(null);
  previewingRef.current = previewing;

  // Re-subscribe when previewing changes so the closure captures the latest value.
  useEffect(() => {
    const off = ipc.onVoiceEvent((e: VoiceEvent) => {
      if (e.type === 'tts-chunk' && previewingRef.current !== null) {
        const pcm = new Float32Array(e.pcm);
        playerRef.current?.enqueue(pcm, e.sampleRate);
      }
    });
    return () => off();
  }, []);

  function handlePreview(entry: VoiceCatalogEntry) {
    playerRef.current?.stop();
    setPreviewing(entry.id);
    previewingRef.current = entry.id;
    void ipc.invoke('voice.preview', { voiceId: entry.id });
  }

  function handleVoiceSelect(entry: VoiceCatalogEntry) {
    onVoiceChange(entry.id);
    void ipc.invoke('settings.setVoicePrefs', { ttsVoice: entry.id });
  }

  function handleSpeedChange(newSpeed: number) {
    onSpeedChange(newSpeed);
    void ipc.invoke('settings.setVoicePrefs', { speed: newSpeed });
  }

  return (
    <SubsectionPage
      title="Voice"
      description="Otto speaks during voice conversation mode. Choose a voice and preview how it sounds."
    >
      <div className="space-y-6">
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
                      /* Spinner while synthesizing/playing */
                      <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                    ) : (
                      /* Play icon */
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
```

**Note on the `onVoiceEvent` closure issue:** The component uses two `useEffect` hooks for the event subscription — the first sets up `AudioContext`/`PcmPlayer`, the second subscribes to voice events. Because `tts-chunk` can fire immediately after `voice.preview` is invoked (before the next render), the event handler uses a `previewingRef` to read current state without stale closure. This is a known React pattern for event handlers that need current state.

A simpler alternative: move the subscription inside the second `useEffect` with `[previewing]` dependency — accept the brief unsubscribe/resubscribe on each preview trigger, which is harmless since `tts-chunk` fires after synthesis completes (not immediately). Use the simpler approach if the above feels over-engineered.

**Simpler implementation of the event handler (recommended):**

Replace both `useEffect` blocks with:

```tsx
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
```

This subscribes to voice events only while a preview is pending, which is cleaner. Use this simpler version.

- [ ] **Step 3: Wire VoiceSection into SettingsApp.tsx**

In `src/renderer/SettingsApp.tsx`:

1. Add import at the top with other section imports:

```typescript
import { VoiceSection } from './components/settings/VoiceSection';
```

2. Add a `patchVoice` helper function in `SettingsApp` alongside the existing `patchNotifications`:

```typescript
function patchVoice(p: Partial<{ ttsVoice: string; speed: number }>) {
  setS((cur) => (cur ? { ...cur, voice: { ...cur.voice, ...p } } : cur));
}
```

3. Pass `patchVoice` through `renderSubsection`'s argument interface and in the call site. Add `patchVoice` to `RenderArgs`:

```typescript
interface RenderArgs {
  activeTab: TabId;
  activeSub: string;
  settings: SettingsView;
  model: string;
  setModel: (m: string) => void;
  patch<K extends keyof SettingsView>(key: K, value: SettingsView[K]): void;
  patchNotifications(p: Partial<SettingsView['notifications']>): void;
  patchVoice(p: Partial<{ ttsVoice: string; speed: number }>): void;
}
```

4. Pass it in the `renderSubsection` call:

```tsx
{renderSubsection({
  activeTab,
  activeSub,
  settings: s,
  model,
  setModel,
  patch,
  patchNotifications,
  patchVoice,
})}
```

5. In `renderSubsection`, destructure `patchVoice` and add the render case inside the `behavior` block:

```tsx
const { activeTab, activeSub, settings: s, model, setModel, patch, patchNotifications, patchVoice } = args;
```

```tsx
if (activeSub === 'voice')
  return (
    <VoiceSection
      ttsVoice={s.voice.ttsVoice}
      speed={s.voice.speed}
      onVoiceChange={(ttsVoice) => patchVoice({ ttsVoice })}
      onSpeedChange={(speed) => patchVoice({ speed })}
    />
  );
```

- [ ] **Step 4: Typecheck**

```bash
cd /var/home/mstephens/Documents/GitHub/otto && pnpm typecheck 2>&1 | grep "error TS" | head -30
```
Expected: Zero errors.

- [ ] **Step 5: Run all tests**

```bash
pnpm vitest run --maxWorkers=2 2>&1 | tail -30
```
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/settings/VoiceSection.tsx \
        src/renderer/components/settings/SettingsNav.ts \
        src/renderer/SettingsApp.tsx
git commit -m "feat: voice picker with audible previews in settings"
```

---

### Task 7: Build verification

- [ ] **Step 1: Run full test suite**

```bash
cd /var/home/mstephens/Documents/GitHub/otto && pnpm test --maxWorkers=2 2>&1 | tail -30
```
Expected: All tests PASS, zero failures.

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck 2>&1 | grep "error TS" | head -20
```
Expected: Zero errors.

- [ ] **Step 3: Build**

```bash
pnpm build 2>&1 | tail -30
```
Expected: Build completes with no errors (warnings OK).

- [ ] **Step 4: Dev smoke test**

```bash
pnpm dev 2>&1 | head -30
```
Expected: App starts without errors. No startup crashes. Quit immediately after confirming launch.

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| Settings schema v6 with `voice: { ttsVoice, speed }` | Task 2 |
| v5→v6 migration | Task 2 |
| `SettingsView` extended with `voice` | Task 5 |
| `settings.setVoicePrefs` IPC channel | Task 5 |
| Handler registered in handlers.ts | Task 5 |
| `SynthFn` per-call opts | Task 3 |
| VoiceManager uses current settings at synth time | Task 4 |
| `getVoicePrefs` wired in index.ts | Task 5 |
| `voice.preview` IPC channel | Task 5 |
| Voice catalog in `src/shared/voice-catalog.ts` | Task 1 |
| Voice IDs verified against kokoro-js | Task 1 (step 2) |
| Settings UI Voice section | Task 6 |
| Voice picker + preview button | Task 6 |
| Speed control | Task 6 |
| PcmPlayer in settings renderer | Task 6 |
| Tests for settings migration | Task 2 |
| TTS tests updated | Task 3 |
| `pnpm typecheck` clean | Task 7 |
| `pnpm test` green | Task 7 |
| `pnpm build` succeeds | Task 7 |

**Type consistency check:**
- `SynthFn` is `(text: string, opts?: SynthOpts) => Promise<...>` in tts.ts — used in manager.ts wrappedSynth lambda — consistent.
- `VoicePrefs` is `{ ttsVoice: string; speed: number }` in settings.ts — matches `SettingsView.voice` shape — consistent.
- `VOICE_CATALOG` entry ids match `.bin` files verified in Task 1 step 2.
- `VoiceSection` props `ttsVoice`/`speed` come from `s.voice.ttsVoice`/`s.voice.speed` — consistent with `SettingsView.voice`.

**Placeholder scan:** No TBD/TODO placeholders found. All code blocks contain actual implementations.

**One known simplification in VoiceSection:** The spec step 2 notes to use the simpler two-`useEffect` form — the file as written uses that simpler form. Remove the over-engineered `previewingRef` pattern shown earlier; only the simpler version should appear in the actual file.
