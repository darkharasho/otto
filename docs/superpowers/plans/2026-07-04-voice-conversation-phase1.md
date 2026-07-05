# Voice Conversation Mode — Phase 1 (Linux End-to-End) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working voice conversation loop on Linux: mic toggle → VAD-segmented speech → whisper.cpp transcription → existing SDK session → filtered/sentence-chunked responses spoken via Kokoro TTS, with barge-in (speech stops playback, never the agent turn).

**Architecture:** Renderer owns mic capture, Silero VAD, and Web Audio playback. Main owns a long-lived `whisper-server` sidecar (model stays resident), a Kokoro TTS queue, and a speech pipeline that taps the existing session-event fan-out (`baseEmit` in `src/main/index.ts`). Transcripts are submitted through the existing `session.send` path so voice messages are ordinary chat messages.

**Tech Stack:** Electron 33 / Node 22 / TypeScript strict, electron-vite, pnpm, vitest (forks pool, maxForks 2), zustand, `@ricky0123/vad-web` (Silero VAD, WASM), `kokoro-js` (Kokoro-82M ONNX on onnxruntime), whisper.cpp `whisper-server` (pinned build).

**Spec:** `docs/superpowers/specs/2026-07-04-voice-conversation-design.md`

## Global Constraints

- Package manager is **pnpm**; run tests with `pnpm test` (vitest is already capped: `pool: 'forks'`, `maxForks: 2` in `vitest.config.ts` — never raise it).
- TypeScript strict mode incl. `noUncheckedIndexedAccess`; typecheck with `pnpm typecheck` (if that script is missing, use `pnpm exec tsc --noEmit -p tsconfig.json` and check `package.json` for per-target typecheck scripts).
- Path alias `@shared` → `src/shared` (configured in both `electron.vite.config.ts` and `vitest.config.ts`).
- Renderer runs with `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` — all main-process access goes through the typed preload bridge (`window.otto`).
- Phase 1 is Linux-only with hardcoded defaults: whisper model `small.en`, Kokoro voice `af_heart`, speed 1.0. **No settings schema changes in this plan** (Phase 2).
- Keep files focused: new voice code lives in `src/main/voice/`, `src/renderer/voice/`, `src/shared/`.
- Commit after every task (see per-task commit steps). Commit style: conventional prefixes (`feat:`, `test:`, `chore:`), matching `git log`.

---

### Task 1: Dev asset script — whisper-server binary + models

**Files:**
- Create: `scripts/setup-voice-dev.sh`
- Modify: `.gitignore` (add `resources/voice/`)

**Interfaces:**
- Produces: `resources/voice/whisper-server` (executable) and `resources/voice/models/ggml-small.en.bin`, consumed by Task 5 (`WhisperService`) and Task 8 (`VoiceManager`).

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Dev-only setup for voice conversation mode (Phase 1, Linux).
# Builds whisper.cpp's whisper-server at a pinned tag and downloads the
# ggml small.en model into resources/voice/. Packaged builds get CI-built
# binaries in Phase 3.
set -euo pipefail

PIN="v1.7.5"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/resources/voice"
BUILD_DIR="${TMPDIR:-/tmp}/otto-whisper-build"

mkdir -p "$OUT/models"

if [ ! -x "$OUT/whisper-server" ]; then
  echo "==> Building whisper-server ($PIN)"
  rm -rf "$BUILD_DIR"
  git clone --depth 1 --branch "$PIN" https://github.com/ggml-org/whisper.cpp "$BUILD_DIR"
  cmake -S "$BUILD_DIR" -B "$BUILD_DIR/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF
  cmake --build "$BUILD_DIR/build" -j "$(nproc)" --target whisper-server
  cp "$BUILD_DIR/build/bin/whisper-server" "$OUT/whisper-server"
  echo "==> whisper-server installed at $OUT/whisper-server"
else
  echo "==> whisper-server already present, skipping build"
fi

MODEL="$OUT/models/ggml-small.en.bin"
if [ ! -f "$MODEL" ]; then
  echo "==> Downloading ggml-small.en.bin (~466 MB)"
  curl -L --fail --progress-bar -o "$MODEL.part" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin"
  mv "$MODEL.part" "$MODEL"
else
  echo "==> whisper model already present, skipping download"
fi

echo "==> Voice dev assets ready."
```

- [ ] **Step 2: Make it executable and add gitignore entry**

Run: `chmod +x scripts/setup-voice-dev.sh`

Append to `.gitignore`:

```
resources/voice/
```

(Check first that `resources/` itself isn't already fully ignored — `grep -n resources .gitignore`. The embedding model under `resources/embedding/` has an existing convention; mirror it.)

- [ ] **Step 3: Run it and verify**

Run: `bash scripts/setup-voice-dev.sh`
Expected: `resources/voice/whisper-server` exists and `resources/voice/whisper-server --help` prints usage; `resources/voice/models/ggml-small.en.bin` is ~466 MB.
Requires `cmake` and build essentials; if missing, install via the distro (`sudo dnf install cmake gcc-c++` on Fedora) — surface this to the user rather than working around it.

- [ ] **Step 4: Smoke-test the server manually**

Run:
```bash
resources/voice/whisper-server -m resources/voice/models/ggml-small.en.bin --host 127.0.0.1 --port 18080 &
sleep 8 && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:18080/ ; kill %1
```
Expected: `200`

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-voice-dev.sh .gitignore
git commit -m "chore: dev setup script for voice assets (whisper-server + model)"
```

---

### Task 2: Shared voice types, IPC contract, preload bridge

**Files:**
- Create: `src/shared/voice.ts`
- Modify: `src/shared/ipc-contract.ts` (extend `IpcRequest` union and `OttoBridge`)
- Modify: `src/preload/index.ts` (expose `onVoiceEvent`)

**Interfaces:**
- Produces (consumed by every later task):

```ts
// src/shared/voice.ts
export const VOICE_EVENT_CHANNEL = 'voice.event';

export type VoiceEvent =
  | { type: 'tts-start' }
  | { type: 'tts-chunk'; pcm: ArrayBuffer; sampleRate: number }
  | { type: 'tts-end' }
  | { type: 'voice-ready' }
  | { type: 'voice-error'; message: string };

export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'speaking';
```

- New invoke channels on `IpcRequest`:
  - `voice.setMode` — `args: { enabled: boolean; sessionId: string | null }`, `result: void`
  - `voice.transcribe` — `args: { pcm: ArrayBuffer; sampleRate: number }`, `result: { text: string }`
  - `voice.cancelSpeech` — `args: void`, `result: void`
- New bridge method: `onVoiceEvent(handler: (event: VoiceEvent) => void): () => void`

- [ ] **Step 1: Create `src/shared/voice.ts`** with the exact contents above.

- [ ] **Step 2: Extend the IPC contract**

In `src/shared/ipc-contract.ts`, add to the `IpcRequest` union (after the `uploads.discard` entry, `~line 171`):

```ts
  | { channel: 'voice.setMode'; args: { enabled: boolean; sessionId: string | null }; result: void }
  | { channel: 'voice.transcribe'; args: { pcm: ArrayBuffer; sampleRate: number }; result: { text: string } }
  | { channel: 'voice.cancelSpeech'; args: void; result: void };
```

Add to the `OttoBridge` interface (next to `onSessionEvent`):

```ts
  onVoiceEvent(handler: (event: import('./voice').VoiceEvent) => void): () => void;
```

(Use a top-of-file `import type { VoiceEvent } from './voice';` instead of the inline import — match the file's existing import style.)

- [ ] **Step 3: Expose in preload**

In `src/preload/index.ts`, import `VOICE_EVENT_CHANNEL` and `type VoiceEvent` from `@shared/voice`, and add to the `bridge` object (mirroring `onSessionEvent`, lines 26–30):

```ts
  onVoiceEvent(handler) {
    const listener = (_e: Electron.IpcRendererEvent, payload: VoiceEvent) => handler(payload);
    ipcRenderer.on(VOICE_EVENT_CHANNEL, listener);
    return () => ipcRenderer.removeListener(VOICE_EVENT_CHANNEL, listener);
  },
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck` (or `pnpm exec tsc --noEmit`)
Expected: clean. (No runtime handler exists yet — invoking these channels would reject, which is fine until Task 8.)

- [ ] **Step 5: Commit**

```bash
git add src/shared/voice.ts src/shared/ipc-contract.ts src/preload/index.ts
git commit -m "feat: voice IPC contract and preload bridge"
```

---

### Task 3: SpeechTextStream — filter + sentence chunker (TDD)

**Files:**
- Create: `src/shared/voice-text.ts`
- Test: `src/shared/voice-text.test.ts`

**Interfaces:**
- Produces (consumed by Task 7 `SpeechPipeline`):

```ts
export class SpeechTextStream {
  /** Feed a streamed text delta; returns any complete, speakable sentences. */
  push(delta: string): string[];
  /** Message ended: returns the sanitized tail (possibly empty array), resets state. */
  flush(): string[];
  /** Drop all buffered state (barge-in / cancel). */
  reset(): void;
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/shared/voice-text.test.ts
import { describe, it, expect } from 'vitest';
import { SpeechTextStream } from './voice-text';

describe('SpeechTextStream', () => {
  it('emits a sentence once its boundary arrives, keeps the tail buffered', () => {
    const s = new SpeechTextStream();
    expect(s.push('Checking your processes now. I found')).toEqual([
      'Checking your processes now.',
    ]);
    expect(s.push(' three of them.')).toEqual(['I found three of them.']);
  });

  it('handles boundaries split across deltas', () => {
    const s = new SpeechTextStream();
    expect(s.push('Done')).toEqual([]);
    expect(s.push('. Next step.')).toEqual(['Done.', 'Next step.']);
  });

  it('treats a blank line as a sentence boundary', () => {
    const s = new SpeechTextStream();
    expect(s.push('First point\n\nSecond point.')).toEqual(['First point', 'Second point.']);
  });

  it('drops fenced code blocks entirely, even across deltas', () => {
    const s = new SpeechTextStream();
    const out = [
      ...s.push('Here is the fix.\n```ts\nconst x'),
      ...s.push(' = 1;\n```\nApplied it.'),
      ...s.flush(),
    ];
    expect(out).toEqual(['Here is the fix.', 'Applied it.']);
  });

  it('keeps short inline code, drops long inline code', () => {
    const s = new SpeechTextStream();
    expect(s.push('Run `pnpm test` to check.')).toEqual(['Run pnpm test to check.']);
    const long = s.push('Use `const result = await client.messages.create(options)` here.');
    expect(long).toEqual(['Use here.']);
  });

  it('waits for an unclosed inline code span instead of emitting it raw', () => {
    const s = new SpeechTextStream();
    expect(s.push('Run `pnpm ')).toEqual([]);
    expect(s.push('test` now.')).toEqual(['Run pnpm test now.']);
  });

  it('replaces URLs with "link"', () => {
    const s = new SpeechTextStream();
    expect(s.push('See https://example.com/a/b?c=d for details.')).toEqual([
      'See link for details.',
    ]);
  });

  it('strips markdown headings, bullets, emphasis', () => {
    const s = new SpeechTextStream();
    const out = [...s.push('## Summary\n- **Bold** point one.\n- _Quiet_ point two.'), ...s.flush()];
    expect(out).toEqual(['Summary', 'Bold point one.', 'Quiet point two.']);
  });

  it('flush returns the sanitized tail and resets', () => {
    const s = new SpeechTextStream();
    s.push('All done');
    expect(s.flush()).toEqual(['All done']);
    expect(s.flush()).toEqual([]);
  });

  it('reset drops buffered content', () => {
    const s = new SpeechTextStream();
    s.push('Pending text');
    s.reset();
    expect(s.flush()).toEqual([]);
  });

  it('never emits empty or whitespace-only sentences', () => {
    const s = new SpeechTextStream();
    const out = [...s.push('```\ncode only\n```'), ...s.flush()];
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/shared/voice-text.test.ts`
Expected: FAIL — module `./voice-text` not found.

- [ ] **Step 3: Implement**

```ts
// src/shared/voice-text.ts
// Turns streamed assistant text deltas into speakable sentences: strips
// content that should never be spoken (code fences, long inline code, raw
// URLs, markdown syntax) and emits complete sentences as soon as their
// boundary arrives so TTS can start before the full message finishes.

const INLINE_CODE_MAX_WORDS = 3;

function sanitize(text: string): string {
  let t = text;
  // Inline code: keep short spans (reads naturally, e.g. command names),
  // drop long ones.
  t = t.replace(/`([^`]*)`/g, (_m, code: string) => {
    const words = code.trim().split(/\s+/).filter(Boolean);
    return words.length > 0 && words.length <= INLINE_CODE_MAX_WORDS ? code.trim() : '';
  });
  // URLs read terribly aloud.
  t = t.replace(/https?:\/\/\S+/g, 'link');
  // Markdown structure: headings, bullets, emphasis, bold.
  t = t.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/^\s*[-*+]\s+/gm, '');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/\*([^*]+)\*/g, '$1');
  t = t.replace(/(^|\s)_([^_]+)_(?=\s|$|[.,!?])/g, '$1$2');
  // Collapse whitespace runs left behind by removals.
  t = t.replace(/[ \t]{2,}/g, ' ');
  return t;
}

export class SpeechTextStream {
  private buf = '';
  private inFence = false;

  push(delta: string): string[] {
    this.buf += delta;
    return this.extract(false);
  }

  flush(): string[] {
    const out = this.extract(true);
    this.reset();
    return out;
  }

  reset(): void {
    this.buf = '';
    this.inFence = false;
  }

  private extract(final: boolean): string[] {
    const sentences: string[] = [];
    // Phase A: remove code fences from the buffer, tracking open state.
    let speakable = '';
    let rest = this.buf;
    for (;;) {
      if (this.inFence) {
        const close = rest.indexOf('```');
        if (close === -1) {
          // Whole remaining buffer is inside a fence.
          this.buf = final ? '' : rest;
          rest = '';
          break;
        }
        rest = rest.slice(close + 3);
        this.inFence = false;
      } else {
        const open = rest.indexOf('```');
        if (open === -1) {
          speakable += rest;
          this.buf = '';
          rest = '';
          break;
        }
        speakable += rest.slice(0, open);
        rest = rest.slice(open + 3);
        this.inFence = true;
      }
    }

    // Phase B: split speakable text into sentences; hold back the tail
    // (and anything with an unclosed inline-code span) unless final.
    let pending = speakable;
    for (;;) {
      const m = pending.match(/([.!?])(\s+)|(\n{2,})/);
      if (!m || m.index === undefined) break;
      const end = m.index + (m[1] ? 1 : 0);
      const candidate = pending.slice(0, end);
      const restStart = m.index + m[0].length;
      // Unclosed inline code span: wait for the closing backtick.
      if (!final && (candidate.match(/`/g)?.length ?? 0) % 2 === 1) break;
      const clean = sanitize(candidate).trim();
      if (clean) sentences.push(clean);
      pending = pending.slice(restStart);
    }

    if (final) {
      const clean = sanitize(pending).trim();
      if (clean) sentences.push(clean);
    } else if (!this.inFence) {
      // Re-buffer the unfinished tail ahead of any fence-stripped remainder.
      this.buf = pending + this.buf;
    } else if (pending.trim()) {
      // Tail before an open fence: keep it buffered until the fence closes
      // or the message ends. Note buf currently holds the fence interior.
      this.buf = pending + '```' + this.buf;
      this.inFence = false;
    }
    return sentences;
  }
}
```

- [ ] **Step 4: Run tests until they pass**

Run: `pnpm test src/shared/voice-text.test.ts`
Expected: all PASS. The fence/tail re-buffering interplay is fiddly — iterate on the implementation until the tests pass; the tests are the contract, don't weaken them. If a test reveals a genuinely ambiguous expectation, prefer the simpler behavior and adjust the implementation, not the test.

- [ ] **Step 5: Commit**

```bash
git add src/shared/voice-text.ts src/shared/voice-text.test.ts
git commit -m "feat: speech text filter and sentence chunker for TTS"
```

---

### Task 4: PCM → WAV encoder (TDD)

**Files:**
- Create: `src/shared/pcm-wav.ts`
- Test: `src/shared/pcm-wav.test.ts`

**Interfaces:**
- Produces (consumed by Task 5): `export function pcmToWav(pcm: Float32Array, sampleRate: number): Uint8Array` — 16-bit signed little-endian mono WAV.

- [ ] **Step 1: Write the failing tests**

```ts
// src/shared/pcm-wav.test.ts
import { describe, it, expect } from 'vitest';
import { pcmToWav } from './pcm-wav';

function readU32(b: Uint8Array, o: number): number {
  return new DataView(b.buffer, b.byteOffset).getUint32(o, true);
}
function readU16(b: Uint8Array, o: number): number {
  return new DataView(b.buffer, b.byteOffset).getUint16(o, true);
}
function readI16(b: Uint8Array, o: number): number {
  return new DataView(b.buffer, b.byteOffset).getInt16(o, true);
}

describe('pcmToWav', () => {
  it('writes a valid 44-byte RIFF/WAVE header for 16kHz mono 16-bit', () => {
    const wav = pcmToWav(new Float32Array([0, 0.5, -0.5]), 16000);
    expect(wav.length).toBe(44 + 3 * 2);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(readU32(wav, 4)).toBe(wav.length - 8);
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
    expect(readU16(wav, 22)).toBe(1); // channels
    expect(readU32(wav, 24)).toBe(16000); // sample rate
    expect(readU32(wav, 28)).toBe(16000 * 2); // byte rate
    expect(readU16(wav, 34)).toBe(16); // bits per sample
    expect(readU32(wav, 40)).toBe(3 * 2); // data chunk size
  });

  it('converts float samples to clamped int16', () => {
    const wav = pcmToWav(new Float32Array([0, 1, -1, 1.5, -1.5]), 16000);
    expect(readI16(wav, 44)).toBe(0);
    expect(readI16(wav, 46)).toBe(32767);
    expect(readI16(wav, 48)).toBe(-32768);
    expect(readI16(wav, 50)).toBe(32767); // clamped
    expect(readI16(wav, 52)).toBe(-32768); // clamped
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/shared/pcm-wav.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/shared/pcm-wav.ts
/** Encode mono Float32 PCM as a 16-bit little-endian WAV file. */
export function pcmToWav(pcm: Float32Array, sampleRate: number): Uint8Array {
  const dataSize = pcm.length * 2;
  const out = new Uint8Array(44 + dataSize);
  const v = new DataView(out.buffer);
  const ascii = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  v.setUint32(40, dataSize, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i] ?? 0));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/shared/pcm-wav.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/pcm-wav.ts src/shared/pcm-wav.test.ts
git commit -m "feat: PCM to WAV encoder for whisper transcription"
```

---

### Task 5: WhisperService — sidecar lifecycle + transcription (TDD with stub server)

**Files:**
- Create: `src/main/voice/whisper.ts`
- Create: `src/main/voice/__fixtures__/fake-whisper-server.mjs`
- Test: `src/main/voice/whisper.test.ts`

**Interfaces:**
- Consumes: `pcmToWav` from `@shared/pcm-wav` (Task 4).
- Produces (consumed by Task 8):

```ts
export interface WhisperServiceOpts {
  command: string;           // executable to spawn
  args(port: number): string[]; // args for a given port
  startupTimeoutMs?: number; // default 30_000 (model load takes seconds)
  onExit?(code: number | null): void; // fires on unexpected exit
}
export class WhisperService {
  constructor(opts: WhisperServiceOpts);
  start(): Promise<void>;    // spawn + poll GET / until 200
  stop(): Promise<void>;     // SIGTERM, then SIGKILL after 3s
  isRunning(): boolean;
  transcribe(pcm: Float32Array, sampleRate: number): Promise<string>;
}
```

Production callers construct it as:

```ts
new WhisperService({
  command: whisperBinaryPath,
  args: (port) => ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '--threads', '4'],
  onExit: (code) => { /* respawn policy lives in VoiceManager (Task 8) */ },
});
```

- [ ] **Step 1: Write the stub server fixture**

```js
// src/main/voice/__fixtures__/fake-whisper-server.mjs
// Mimics whisper-server's HTTP surface: GET / -> 200, POST /inference -> JSON.
// Usage: node fake-whisper-server.mjs --port N [--delay-ms N] [--crash-after-start]
import http from 'node:http';

const argv = process.argv.slice(2);
const get = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};
const port = Number(get('--port'));
const delayMs = Number(get('--delay-ms') ?? 0);
const crashAfterStart = argv.includes('--crash-after-start');

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/inference') {
    let size = 0;
    req.on('data', (c) => (size += c.length));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ text: ` transcribed ${size} bytes ` }));
    });
    return;
  }
  res.end('ok');
});

setTimeout(() => {
  server.listen(port, '127.0.0.1', () => {
    if (crashAfterStart) setTimeout(() => process.exit(7), 200);
  });
}, delayMs);
```

- [ ] **Step 2: Write the failing tests**

```ts
// src/main/voice/whisper.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { WhisperService } from './whisper';

const FIXTURE = path.resolve(__dirname, '__fixtures__/fake-whisper-server.mjs');

function stub(extra: string[] = [], opts: Partial<import('./whisper').WhisperServiceOpts> = {}) {
  return new WhisperService({
    command: process.execPath,
    args: (port) => [FIXTURE, '--port', String(port), ...extra],
    startupTimeoutMs: 10_000,
    ...opts,
  });
}

let svc: WhisperService | null = null;
afterEach(async () => {
  await svc?.stop();
  svc = null;
});

describe('WhisperService', () => {
  it('starts, reports running, transcribes, and stops', async () => {
    svc = stub();
    await svc.start();
    expect(svc.isRunning()).toBe(true);
    const text = await svc.transcribe(new Float32Array(1600), 16000);
    // fake server echoes byte count; whisper text is whitespace-padded — we trim.
    expect(text).toMatch(/^transcribed \d+ bytes$/);
    await svc.stop();
    expect(svc.isRunning()).toBe(false);
  });

  it('waits for a slow-booting server', async () => {
    svc = stub(['--delay-ms', '1500']);
    await svc.start();
    expect(svc.isRunning()).toBe(true);
  });

  it('rejects start() when the server never comes up', async () => {
    svc = stub([], { startupTimeoutMs: 1000 });
    // Point at a script arg combo that never listens: huge delay.
    svc = new WhisperService({
      command: process.execPath,
      args: (port) => [FIXTURE, '--port', String(port), '--delay-ms', '60000'],
      startupTimeoutMs: 1000,
    });
    await expect(svc.start()).rejects.toThrow(/timed out/i);
  });

  it('invokes onExit when the process dies unexpectedly', async () => {
    let exitCode: number | null | undefined;
    svc = stub(['--crash-after-start'], { onExit: (code) => (exitCode = code) });
    await svc.start();
    await new Promise((r) => setTimeout(r, 700));
    expect(exitCode).toBe(7);
    expect(svc.isRunning()).toBe(false);
  });

  it('transcribe rejects when not running', async () => {
    svc = stub();
    await expect(svc.transcribe(new Float32Array(16), 16000)).rejects.toThrow(/not running/i);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test src/main/voice/whisper.test.ts`
Expected: FAIL — module `./whisper` not found.

- [ ] **Step 4: Implement**

```ts
// src/main/voice/whisper.ts
// Long-lived whisper.cpp `whisper-server` sidecar. The model loads once at
// start() and stays resident so per-utterance latency is just inference.
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { pcmToWav } from '@shared/pcm-wav';

export interface WhisperServiceOpts {
  command: string;
  args(port: number): string[];
  startupTimeoutMs?: number;
  onExit?(code: number | null): void;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export class WhisperService {
  private child: ChildProcess | null = null;
  private port = 0;
  private stopping = false;

  constructor(private readonly opts: WhisperServiceOpts) {}

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.stopping;
  }

  async start(): Promise<void> {
    if (this.isRunning()) return;
    this.stopping = false;
    this.port = await freePort();
    const child = spawn(this.opts.command, this.opts.args(this.port), {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.child = child;
    child.on('exit', (code) => {
      const wasStopping = this.stopping;
      this.child = null;
      if (!wasStopping) this.opts.onExit?.(code);
    });

    const deadline = Date.now() + (this.opts.startupTimeoutMs ?? 30_000);
    for (;;) {
      if (child.exitCode !== null) throw new Error(`whisper-server exited during startup (code ${child.exitCode})`);
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) {
        await this.stop();
        throw new Error('whisper-server startup timed out');
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timer);
    this.child = null;
    this.stopping = false;
  }

  async transcribe(pcm: Float32Array, sampleRate: number): Promise<string> {
    if (!this.isRunning()) throw new Error('whisper-server is not running');
    const wav = pcmToWav(pcm, sampleRate);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
    form.append('response_format', 'json');
    form.append('temperature', '0');
    const res = await fetch(`http://127.0.0.1:${this.port}/inference`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`whisper-server inference failed: HTTP ${res.status}`);
    const json = (await res.json()) as { text?: string };
    return (json.text ?? '').trim();
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test src/main/voice/whisper.test.ts`
Expected: PASS. Note: these tests spawn real child processes — if the suite is flaky under the forks pool, add `// eslint-disable` nothing; instead increase fixture delays. Do not mark tests `.skip`.

- [ ] **Step 6: Commit**

```bash
git add src/main/voice/whisper.ts src/main/voice/whisper.test.ts src/main/voice/__fixtures__/fake-whisper-server.mjs
git commit -m "feat: whisper-server sidecar service with lifecycle and transcription"
```

---

### Task 6: TtsService — synthesis queue with cancellation (TDD)

**Files:**
- Create: `src/main/voice/tts.ts`
- Test: `src/main/voice/tts.test.ts`

**Interfaces:**
- Consumes: `VoiceEvent` from `@shared/voice` (Task 2).
- Produces (consumed by Tasks 7 & 8):

```ts
export type SynthFn = (text: string) => Promise<{ pcm: Float32Array; sampleRate: number }>;
export class TtsService {
  constructor(synth: SynthFn, emit: (e: VoiceEvent) => void);
  speak(sentence: string): void; // enqueue; drives tts-start/tts-chunk/tts-end
  cancel(): void;                // flush queue + drop in-flight result
  get pending(): number;
}
export async function createKokoroSynth(cacheDir: string): Promise<SynthFn>; // real adapter
```

- [ ] **Step 1: Add the kokoro-js dependency**

Run: `pnpm add kokoro-js`
Expected: installs cleanly (pulls `@huggingface/transformers` / onnxruntime).

- [ ] **Step 2: Write the failing tests**

```ts
// src/main/voice/tts.test.ts
import { describe, it, expect, vi } from 'vitest';
import { TtsService, type SynthFn } from './tts';
import type { VoiceEvent } from '@shared/voice';

function deferredSynth() {
  const resolvers: Array<(v: { pcm: Float32Array; sampleRate: number }) => void> = [];
  const synth: SynthFn = () =>
    new Promise((resolve) => {
      resolvers.push(resolve);
    });
  return { synth, resolvers };
}

const chunk = (n: number) => ({ pcm: new Float32Array(n), sampleRate: 24000 });

describe('TtsService', () => {
  it('synthesizes sentences in order and emits start/chunk/end', async () => {
    const events: VoiceEvent[] = [];
    const calls: string[] = [];
    const synth: SynthFn = async (t) => {
      calls.push(t);
      return chunk(8);
    };
    const tts = new TtsService(synth, (e) => events.push(e));
    tts.speak('One.');
    tts.speak('Two.');
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'tts-end')).toHaveLength(1));
    expect(calls).toEqual(['One.', 'Two.']);
    expect(events.map((e) => e.type)).toEqual(['tts-start', 'tts-chunk', 'tts-chunk', 'tts-end']);
  });

  it('serializes synthesis (one at a time)', async () => {
    const { synth, resolvers } = deferredSynth();
    const tts = new TtsService(synth, () => {});
    tts.speak('A.');
    tts.speak('B.');
    await vi.waitFor(() => expect(resolvers).toHaveLength(1)); // B not started yet
    resolvers[0]!(chunk(4));
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
  });

  it('cancel drops queued sentences and the in-flight result', async () => {
    const events: VoiceEvent[] = [];
    const { synth, resolvers } = deferredSynth();
    const tts = new TtsService(synth, (e) => events.push(e));
    tts.speak('A.');
    tts.speak('B.');
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    tts.cancel();
    resolvers[0]!(chunk(4)); // resolves after cancel — must be dropped
    await vi.waitFor(() => expect(events.some((e) => e.type === 'tts-end')).toBe(true));
    expect(events.some((e) => e.type === 'tts-chunk')).toBe(false);
    expect(tts.pending).toBe(0);
  });

  it('a synthesis error skips the sentence and continues the queue', async () => {
    const events: VoiceEvent[] = [];
    let first = true;
    const synth: SynthFn = async (t) => {
      if (first) {
        first = false;
        throw new Error('boom');
      }
      return chunk(4);
    };
    const tts = new TtsService(synth, (e) => events.push(e));
    tts.speak('Bad.');
    tts.speak('Good.');
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'tts-end')).toHaveLength(1));
    expect(events.filter((e) => e.type === 'tts-chunk')).toHaveLength(1);
  });

  it('emits tts-start again for a new batch after draining', async () => {
    const events: VoiceEvent[] = [];
    const tts = new TtsService(async () => chunk(4), (e) => events.push(e));
    tts.speak('One.');
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'tts-end')).toHaveLength(1));
    tts.speak('Two.');
    await vi.waitFor(() => expect(events.filter((e) => e.type === 'tts-end')).toHaveLength(2));
    expect(events.filter((e) => e.type === 'tts-start')).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test src/main/voice/tts.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

```ts
// src/main/voice/tts.ts
// Sentence-by-sentence TTS queue. Synthesis is serialized (Kokoro is
// CPU-bound); cancellation uses a generation counter so an in-flight
// result that resolves after cancel() is silently dropped.
import type { VoiceEvent } from '@shared/voice';

export type SynthFn = (text: string) => Promise<{ pcm: Float32Array; sampleRate: number }>;

export class TtsService {
  private queue: string[] = [];
  private running = false;
  private generation = 0;

  constructor(
    private readonly synth: SynthFn,
    private readonly emit: (e: VoiceEvent) => void
  ) {}

  get pending(): number {
    return this.queue.length;
  }

  speak(sentence: string): void {
    this.queue.push(sentence);
    if (!this.running) void this.drain();
  }

  cancel(): void {
    this.generation++;
    this.queue = [];
  }

  private async drain(): Promise<void> {
    this.running = true;
    this.emit({ type: 'tts-start' });
    while (this.queue.length > 0) {
      const gen = this.generation;
      const sentence = this.queue.shift()!;
      try {
        const { pcm, sampleRate } = await this.synth(sentence);
        if (gen !== this.generation) break; // cancelled mid-synthesis
        // Copy into a plain ArrayBuffer for structured-clone over IPC.
        const buf = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
        this.emit({ type: 'tts-chunk', pcm: buf, sampleRate });
      } catch {
        if (gen !== this.generation) break;
        // Skip the failed sentence, keep going.
      }
    }
    this.running = false;
    this.emit({ type: 'tts-end' });
  }
}

/** Real Kokoro adapter. Heavy: loads ~300MB of ONNX weights on first call. */
export async function createKokoroSynth(cacheDir: string): Promise<SynthFn> {
  process.env.HF_HUB_CACHE = cacheDir; // keep model downloads under userData
  const { KokoroTTS } = await import('kokoro-js');
  const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
    dtype: 'q8',
    device: 'cpu',
  });
  return async (text: string) => {
    const audio = await tts.generate(text, { voice: 'af_heart' });
    return { pcm: audio.audio as Float32Array, sampleRate: audio.sampling_rate as number };
  };
}
```

Note for the implementer: verify the exact `kokoro-js` API surface against the installed version (`node_modules/kokoro-js/README.md` or its `.d.ts`) — `from_pretrained` options, `generate` return shape (`audio` / `sampling_rate`), and the env var the underlying `@huggingface/transformers` uses for its cache (`HF_HUB_CACHE` vs `TRANSFORMERS_CACHE` vs an `env.cacheDir` setting). Adjust `createKokoroSynth` to the real API; the `SynthFn` boundary keeps everything else unaffected. The unit tests never load Kokoro.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test src/main/voice/tts.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/voice/tts.ts src/main/voice/tts.test.ts package.json pnpm-lock.yaml
git commit -m "feat: TTS queue service with cancellation and Kokoro adapter"
```

---

### Task 7: SpeechPipeline — session events → sentences → TTS (TDD)

**Files:**
- Create: `src/main/voice/pipeline.ts`
- Test: `src/main/voice/pipeline.test.ts`

**Interfaces:**
- Consumes: `SpeechTextStream` (Task 3), `TtsService.speak/cancel` (Task 6), `SessionEvent` from `@shared/ipc-contract`.
- Produces (consumed by Task 8):

```ts
export class SpeechPipeline {
  constructor(tts: Pick<TtsService, 'speak' | 'cancel'>);
  /** Enable speaking for one session (null sessionId disables). */
  setEnabled(enabled: boolean, sessionId: string | null): void;
  /** Called from the main session-event fan-out for every event. */
  handleSessionEvent(e: SessionEvent): void;
}
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/voice/pipeline.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { SpeechPipeline } from './pipeline';

const spoken: string[] = [];
let cancelled = 0;
const tts = {
  speak: (s: string) => {
    spoken.push(s);
  },
  cancel: () => {
    cancelled++;
  },
};

const delta = (sessionId: string, text: string) =>
  ({ type: 'text-delta', sessionId, messageId: 'm1', text }) as const;

beforeEach(() => {
  spoken.length = 0;
  cancelled = 0;
});

describe('SpeechPipeline', () => {
  it('speaks completed sentences from text-deltas of the enabled session', () => {
    const p = new SpeechPipeline(tts);
    p.setEnabled(true, 's1');
    p.handleSessionEvent(delta('s1', 'Hello there. More to'));
    p.handleSessionEvent(delta('s1', ' come.'));
    expect(spoken).toEqual(['Hello there.', 'More to come.']);
  });

  it('ignores deltas for other sessions and when disabled', () => {
    const p = new SpeechPipeline(tts);
    p.setEnabled(true, 's1');
    p.handleSessionEvent(delta('s2', 'Should not speak.'));
    p.setEnabled(false, null);
    p.handleSessionEvent(delta('s1', 'Also silent.'));
    expect(spoken).toEqual([]);
  });

  it('flushes the tail on message-end', () => {
    const p = new SpeechPipeline(tts);
    p.setEnabled(true, 's1');
    p.handleSessionEvent(delta('s1', 'No terminal punctuation'));
    p.handleSessionEvent({ type: 'message-end', sessionId: 's1', messageId: 'm1' });
    expect(spoken).toEqual(['No terminal punctuation']);
  });

  it('cancels speech and drops buffered text on message-cancelled and error', () => {
    const p = new SpeechPipeline(tts);
    p.setEnabled(true, 's1');
    p.handleSessionEvent(delta('s1', 'Partial sentence'));
    p.handleSessionEvent({ type: 'message-cancelled', sessionId: 's1', messageId: 'm1' });
    expect(cancelled).toBe(1);
    p.handleSessionEvent({ type: 'message-end', sessionId: 's1', messageId: 'm1' });
    expect(spoken).toEqual([]); // buffer was reset, nothing to flush
  });

  it('disabling mid-message cancels and resets', () => {
    const p = new SpeechPipeline(tts);
    p.setEnabled(true, 's1');
    p.handleSessionEvent(delta('s1', 'Buffered'));
    p.setEnabled(false, null);
    expect(cancelled).toBe(1);
  });

  it('switching sessions resets the buffer', () => {
    const p = new SpeechPipeline(tts);
    p.setEnabled(true, 's1');
    p.handleSessionEvent(delta('s1', 'Old session tail'));
    p.setEnabled(true, 's2');
    p.handleSessionEvent({ type: 'message-end', sessionId: 's2', messageId: 'm9' });
    expect(spoken).toEqual([]);
  });

  it('does not speak reasoning or tool events', () => {
    const p = new SpeechPipeline(tts);
    p.setEnabled(true, 's1');
    p.handleSessionEvent({ type: 'reasoning', sessionId: 's1', messageId: 'm1', text: 'thinking.' });
    p.handleSessionEvent({
      type: 'tool-call-start',
      sessionId: 's1',
      messageId: 'm1',
      callId: 'c1',
      name: 'bash',
      input: {},
    });
    expect(spoken).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/main/voice/pipeline.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/main/voice/pipeline.ts
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
    if (wasActive && !this.enabled) this.tts.cancel();
    if (wasActive && this.enabled) this.tts.cancel(); // session switch: stop stale speech
  }

  handleSessionEvent(e: SessionEvent): void {
    if (!this.enabled) return;
    if (!('sessionId' in e) || e.sessionId !== this.sessionId) return;
    switch (e.type) {
      case 'text-delta':
        for (const sentence of this.stream.push(e.text)) this.tts.speak(sentence);
        break;
      case 'message-end':
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
```

Note: the "switching sessions resets" test passes because `setEnabled` always resets the stream; the double-`cancel()` branch collapses — simplify to a single `if (wasActive) this.tts.cancel();` and re-run the tests (the disable test expects exactly 1 cancel; enabling fresh from disabled must NOT cancel).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/main/voice/pipeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/voice/pipeline.ts src/main/voice/pipeline.test.ts
git commit -m "feat: speech pipeline from session events to TTS queue"
```

---

### Task 8: VoiceManager + IPC handlers + main wiring

**Files:**
- Create: `src/main/voice/manager.ts`
- Create: `src/main/ipc/voice.ts`
- Modify: `src/main/index.ts` (instantiate + tap `baseEmit` at `~line 208`, register handlers near `registerIpcHandlers` call at `~line 549`)

**Interfaces:**
- Consumes: `WhisperService` (Task 5), `TtsService`/`createKokoroSynth` (Task 6), `SpeechPipeline` (Task 7), `VoiceEvent`/`VOICE_EVENT_CHANNEL` (Task 2).
- Produces:

```ts
export class VoiceManager {
  constructor(opts: { assetsDir: string; cacheDir: string; emit(e: VoiceEvent): void });
  setMode(enabled: boolean, sessionId: string | null): Promise<void>;
  transcribe(pcm: Float32Array, sampleRate: number): Promise<string>;
  cancelSpeech(): void;
  handleSessionEvent(e: SessionEvent): void; // delegate to pipeline
  dispose(): Promise<void>;                  // app quit
}
export function registerVoiceIpc(voice: VoiceManager): void;
export function emitVoiceEvent(event: VoiceEvent): void; // broadcast helper in ipc/voice.ts
```

- [ ] **Step 1: Implement `VoiceManager`**

```ts
// src/main/voice/manager.ts
import path from 'node:path';
import type { SessionEvent } from '@shared/ipc-contract';
import type { VoiceEvent } from '@shared/voice';
import { WhisperService } from './whisper';
import { TtsService, createKokoroSynth, type SynthFn } from './tts';
import { SpeechPipeline } from './pipeline';
import { logger } from '../logger';

const MAX_RESPAWNS = 3;

export class VoiceManager {
  private whisper: WhisperService | null = null;
  private tts: TtsService | null = null;
  private synth: SynthFn | null = null;
  private pipeline: SpeechPipeline | null = null;
  private enabled = false;
  private respawns = 0;

  constructor(
    private readonly opts: {
      assetsDir: string; // resources/voice
      cacheDir: string; // <userData>/voice-models
      emit(e: VoiceEvent): void;
    }
  ) {}

  handleSessionEvent(e: SessionEvent): void {
    this.pipeline?.handleSessionEvent(e);
  }

  async setMode(enabled: boolean, sessionId: string | null): Promise<void> {
    if (!enabled) {
      this.enabled = false;
      this.pipeline?.setEnabled(false, null);
      this.tts?.cancel();
      await this.whisper?.stop();
      return;
    }

    this.enabled = true;
    this.respawns = 0;
    // Kokoro: load once, reuse across mode toggles (model load is seconds).
    if (!this.synth) this.synth = await createKokoroSynth(this.opts.cacheDir);
    if (!this.tts) this.tts = new TtsService(this.synth, this.opts.emit);
    if (!this.pipeline) this.pipeline = new SpeechPipeline(this.tts);

    if (!this.whisper) {
      const binary = path.join(this.opts.assetsDir, 'whisper-server');
      const model = path.join(this.opts.assetsDir, 'models', 'ggml-small.en.bin');
      this.whisper = new WhisperService({
        command: binary,
        args: (port) => ['-m', model, '--host', '127.0.0.1', '--port', String(port), '--threads', '4'],
        onExit: (code) => void this.handleWhisperExit(code),
      });
    }
    if (!this.whisper.isRunning()) await this.whisper.start();

    this.pipeline.setEnabled(true, sessionId);
    this.opts.emit({ type: 'voice-ready' });
  }

  private async handleWhisperExit(code: number | null): Promise<void> {
    if (!this.enabled) return;
    this.respawns++;
    logger.warn(`whisper-server exited (code ${code}), respawn ${this.respawns}/${MAX_RESPAWNS}`);
    if (this.respawns > MAX_RESPAWNS) {
      await this.setMode(false, null);
      this.opts.emit({ type: 'voice-error', message: 'Speech recognition crashed repeatedly; voice mode disabled.' });
      return;
    }
    await new Promise((r) => setTimeout(r, 500 * this.respawns));
    try {
      await this.whisper?.start();
    } catch (err) {
      logger.error(`whisper-server respawn failed: ${String(err)}`);
      void this.handleWhisperExit(null);
    }
  }

  async transcribe(pcm: Float32Array, sampleRate: number): Promise<string> {
    if (!this.whisper?.isRunning()) throw new Error('voice mode is not active');
    return this.whisper.transcribe(pcm, sampleRate);
  }

  cancelSpeech(): void {
    this.tts?.cancel();
  }

  async dispose(): Promise<void> {
    this.enabled = false;
    this.tts?.cancel();
    await this.whisper?.stop();
  }
}
```

- [ ] **Step 2: Implement the IPC registration + event broadcast**

```ts
// src/main/ipc/voice.ts
import { BrowserWindow, ipcMain } from 'electron';
import { VOICE_EVENT_CHANNEL, type VoiceEvent } from '@shared/voice';
import type { VoiceManager } from '../voice/manager';

export function emitVoiceEvent(event: VoiceEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(VOICE_EVENT_CHANNEL, event);
  }
}

export function registerVoiceIpc(voice: VoiceManager): void {
  ipcMain.handle('voice.setMode', async (_e, args: { enabled: boolean; sessionId: string | null }) => {
    await voice.setMode(args.enabled, args.sessionId);
  });
  ipcMain.handle('voice.transcribe', async (_e, args: { pcm: ArrayBuffer; sampleRate: number }) => {
    const text = await voice.transcribe(new Float32Array(args.pcm), args.sampleRate);
    return { text };
  });
  ipcMain.handle('voice.cancelSpeech', () => {
    voice.cancelSpeech();
  });
}
```

- [ ] **Step 3: Wire into `src/main/index.ts`**

Three edits (read the surrounding code first; anchors given from current HEAD):

1. Construct the manager before `baseEmit` (~line 207). `assetsDir` in dev is `path.join(app.getAppPath(), 'resources', 'voice')`; check how `resources/embedding` is resolved in this file and use the same helper if one exists. `cacheDir` is `path.join(app.getPath('userData'), 'voice-models')`.

```ts
const { VoiceManager } = await import('./voice/manager');
const { registerVoiceIpc, emitVoiceEvent } = await import('./ipc/voice');
const voice = new VoiceManager({
  assetsDir: path.join(app.getAppPath(), 'resources', 'voice'),
  cacheDir: path.join(app.getPath('userData'), 'voice-models'),
  emit: emitVoiceEvent,
});
```

2. Tap the fan-out — add one line inside `baseEmit` (line ~208), alongside `notifier.handle(event)` and `overlay.handleSessionEvent(event)`:

```ts
voice.handleSessionEvent(event);
```

3. Register handlers next to the `registerIpcHandlers({...})` call (~line 549):

```ts
registerVoiceIpc(voice);
```

4. Cleanup on quit — find the existing `before-quit` / `will-quit` handler in this file (grep `before-quit`) and add:

```ts
await voice.dispose();
```

If quit cleanup is synchronous there, use `void voice.dispose()` and rely on `WhisperService.stop()`'s SIGKILL fallback.

- [ ] **Step 4: Typecheck and boot**

Run: `pnpm typecheck` then `pnpm dev`
Expected: clean typecheck; app boots with no behavior change (voice mode is off by default). In the app's devtools console run:

```js
await window.otto.invoke('voice.setMode', { enabled: true, sessionId: null })
```

Expected: resolves after several seconds (Kokoro downloads/loads on first run, whisper-server boots); main-process log shows no errors; `voice-ready` arrives if you subscribed via `window.otto.onVoiceEvent(console.log)`. Then disable: `await window.otto.invoke('voice.setMode', { enabled: false, sessionId: null })` and confirm the whisper-server process exits (`pgrep -f whisper-server`).

- [ ] **Step 5: Commit**

```bash
git add src/main/voice/manager.ts src/main/ipc/voice.ts src/main/index.ts
git commit -m "feat: voice manager with IPC handlers and main-process wiring"
```

---

### Task 9: Renderer store — voice state (TDD)

**Files:**
- Modify: `src/renderer/state/store.ts`
- Test: `src/renderer/state/store.voice.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 10–11): store fields `voiceMode: boolean`, `voiceState: VoiceState` and actions `setVoiceMode(on: boolean): void`, `setVoiceState(s: VoiceState): void` on the existing `useOttoStore` zustand store. `VoiceState` imported from `@shared/voice`.

- [ ] **Step 1: Read `src/renderer/state/store.ts`** to learn the store's exact shape (state interface name, `create` call, how existing actions are defined). Follow that style precisely in the next steps.

- [ ] **Step 2: Write the failing test**

```ts
// src/renderer/state/store.voice.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useOttoStore } from './store';

beforeEach(() => {
  useOttoStore.setState({ voiceMode: false, voiceState: 'idle' });
});

describe('voice state', () => {
  it('defaults to off/idle', () => {
    const s = useOttoStore.getState();
    expect(s.voiceMode).toBe(false);
    expect(s.voiceState).toBe('idle');
  });

  it('setVoiceMode toggles mode and resets state to idle when turning off', () => {
    useOttoStore.getState().setVoiceMode(true);
    useOttoStore.getState().setVoiceState('speaking');
    useOttoStore.getState().setVoiceMode(false);
    const s = useOttoStore.getState();
    expect(s.voiceMode).toBe(false);
    expect(s.voiceState).toBe('idle');
  });

  it('setVoiceState updates the state', () => {
    useOttoStore.getState().setVoiceMode(true);
    useOttoStore.getState().setVoiceState('listening');
    expect(useOttoStore.getState().voiceState).toBe('listening');
  });
});
```

(If the store export is named differently than `useOttoStore`, match the real name found in Step 1 — update the test accordingly.)

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test src/renderer/state/store.voice.test.ts`
Expected: FAIL — properties don't exist.

- [ ] **Step 4: Implement** — add to the store's state interface and creator, following existing action style:

```ts
// state fields
voiceMode: boolean;
voiceState: VoiceState;
// actions
setVoiceMode(on: boolean): void;
setVoiceState(s: VoiceState): void;

// in the creator
voiceMode: false,
voiceState: 'idle',
setVoiceMode: (on) => set(on ? { voiceMode: true } : { voiceMode: false, voiceState: 'idle' }),
setVoiceState: (s) => set({ voiceState: s }),
```

with `import type { VoiceState } from '@shared/voice';` at the top.

- [ ] **Step 5: Run the full renderer store tests**

Run: `pnpm test src/renderer/state`
Expected: new test passes AND existing `store.test.ts` / `store.memory-probe.test.ts` still pass.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/state/store.ts src/renderer/state/store.voice.test.ts
git commit -m "feat: voice mode state in renderer store"
```

---

### Task 10: PcmPlayer — gapless Web Audio playback queue (TDD)

**Files:**
- Create: `src/renderer/voice/player.ts`
- Test: `src/renderer/voice/player.test.ts`

**Interfaces:**
- Produces (consumed by Task 11):

```ts
export class PcmPlayer {
  constructor(ctx: Pick<AudioContext, 'createBuffer' | 'createBufferSource' | 'destination' | 'currentTime'>);
  enqueue(pcm: Float32Array, sampleRate: number): void; // schedules gaplessly
  stop(): void;                                          // immediate silence + clear queue
  get playing(): boolean;
  onPlayingChange?: (playing: boolean) => void;
}
```

The constructor takes the narrow `AudioContext` slice so tests can inject a fake; production passes a real `AudioContext`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/renderer/voice/player.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { PcmPlayer } from './player';

type Handler = () => void;

class FakeSource {
  buffer: FakeBuffer | null = null;
  started: number[] = [];
  stopped = false;
  onended: Handler | null = null;
  connect() {}
  start(when: number) {
    this.started.push(when);
  }
  stop() {
    this.stopped = true;
    this.onended?.();
  }
  end() {
    this.onended?.();
  }
}

class FakeBuffer {
  data: Float32Array;
  constructor(
    public numberOfChannels: number,
    public length: number,
    public sampleRate: number
  ) {
    this.data = new Float32Array(length);
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  copyToChannel(src: Float32Array) {
    this.data.set(src);
  }
}

function fakeCtx() {
  const sources: FakeSource[] = [];
  const ctx = {
    currentTime: 0,
    destination: {} as AudioDestinationNode,
    createBuffer: (ch: number, len: number, rate: number) => new FakeBuffer(ch, len, rate) as unknown as AudioBuffer,
    createBufferSource: () => {
      const s = new FakeSource();
      sources.push(s);
      return s as unknown as AudioBufferSourceNode;
    },
  };
  return { ctx, sources };
}

describe('PcmPlayer', () => {
  it('plays the first chunk immediately and reports playing', () => {
    const { ctx, sources } = fakeCtx();
    const p = new PcmPlayer(ctx);
    p.enqueue(new Float32Array(24000), 24000); // 1s
    expect(sources).toHaveLength(1);
    expect(p.playing).toBe(true);
  });

  it('schedules subsequent chunks back-to-back (gapless)', () => {
    const { ctx, sources } = fakeCtx();
    const p = new PcmPlayer(ctx);
    p.enqueue(new Float32Array(24000), 24000); // 1s -> starts at ~0
    p.enqueue(new Float32Array(12000), 24000); // 0.5s -> starts at ~1.0
    expect(sources[1]!.started[0]!).toBeCloseTo(1.0, 5);
  });

  it('becomes not-playing after all sources end', () => {
    const { ctx, sources } = fakeCtx();
    const p = new PcmPlayer(ctx);
    const states: boolean[] = [];
    p.onPlayingChange = (v) => states.push(v);
    p.enqueue(new Float32Array(2400), 24000);
    sources[0]!.end();
    expect(p.playing).toBe(false);
    expect(states).toEqual([true, false]);
  });

  it('stop() silences all scheduled sources and clears state', () => {
    const { ctx, sources } = fakeCtx();
    const p = new PcmPlayer(ctx);
    p.enqueue(new Float32Array(24000), 24000);
    p.enqueue(new Float32Array(24000), 24000);
    p.stop();
    expect(sources.every((s) => s.stopped)).toBe(true);
    expect(p.playing).toBe(false);
    // Next enqueue starts fresh at currentTime.
    p.enqueue(new Float32Array(2400), 24000);
    expect(sources[2]!.started[0]!).toBeCloseTo(0, 5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/renderer/voice/player.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/renderer/voice/player.ts
// Gapless PCM chunk playback: each chunk becomes an AudioBufferSourceNode
// scheduled at the tail of the previous one. stop() is the barge-in path —
// it must silence output immediately.

type Ctx = Pick<AudioContext, 'createBuffer' | 'createBufferSource' | 'destination' | 'currentTime'>;

export class PcmPlayer {
  private nextStartTime = 0;
  private live = new Set<AudioBufferSourceNode>();
  private isPlaying = false;
  onPlayingChange?: (playing: boolean) => void;

  constructor(private readonly ctx: Ctx) {}

  get playing(): boolean {
    return this.isPlaying;
  }

  enqueue(pcm: Float32Array, sampleRate: number): void {
    const buffer = this.ctx.createBuffer(1, pcm.length, sampleRate);
    buffer.copyToChannel(pcm, 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const startAt = Math.max(this.ctx.currentTime, this.nextStartTime);
    source.onended = () => {
      this.live.delete(source);
      if (this.live.size === 0) this.setPlaying(false);
    };
    this.live.add(source);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
    this.setPlaying(true);
  }

  stop(): void {
    for (const s of this.live) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        // already ended
      }
    }
    this.live.clear();
    this.nextStartTime = 0;
    this.setPlaying(false);
  }

  private setPlaying(v: boolean): void {
    if (this.isPlaying === v) return;
    this.isPlaying = v;
    this.onPlayingChange?.(v);
  }
}
```

Note: the test's `stop()` fake calls `onended`, but the implementation nulls `onended` before stopping — that's deliberate (a stopped source must not flip `playing` back). Verify the "stop()" test still passes given the fake's behavior; the fake's `stop()` triggers `this.onended?.()` which is null by then.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/renderer/voice/player.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/voice/player.ts src/renderer/voice/player.test.ts
git commit -m "feat: gapless PCM playback queue for TTS output"
```

---

### Task 11: VAD assets, useVoice hook, mic button, App wiring

**Files:**
- Modify: `electron.vite.config.ts` (renderer: static-copy VAD/onnx assets)
- Create: `src/renderer/voice/useVoice.ts`
- Modify: `src/renderer/components/CommandBar.tsx` (mic toggle button)
- Modify: `src/renderer/App.tsx` (wire hook to submit path)

This task is integration glue around browser APIs (mic, worklets) — no unit tests; verification is manual in Step 6. Keep logic OUT of this layer: anything testable belongs in the classes from Tasks 3–10.

**Interfaces:**
- Consumes: `PcmPlayer` (Task 10), store actions (Task 9), IPC channels (Task 2/8), CommandBar props (existing: `onSubmit`, `ensureSession`).
- Produces:

```ts
// src/renderer/voice/useVoice.ts
export function useVoice(opts: {
  /** Submit a transcript through the same path as typed messages. */
  submitText(text: string): Promise<void> | void;
  /** Resolve (possibly creating) the active session id. */
  ensureSession(): Promise<string>;
}): { toggle(): Promise<void> };
// voiceMode / voiceState are read from the store by consumers.
```

- [ ] **Step 1: Install deps and copy VAD assets**

Run: `pnpm add @ricky0123/vad-web` and `pnpm add -D vite-plugin-static-copy`

In `electron.vite.config.ts`, add to the **renderer** config's `plugins`:

```ts
import { viteStaticCopy } from 'vite-plugin-static-copy';

// inside renderer: { plugins: [ ...existing,
viteStaticCopy({
  targets: [
    { src: 'node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js', dest: 'vad' },
    { src: 'node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx', dest: 'vad' },
    { src: 'node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx', dest: 'vad' },
    { src: 'node_modules/onnxruntime-web/dist/*.wasm', dest: 'vad' },
    { src: 'node_modules/onnxruntime-web/dist/*.mjs', dest: 'vad' },
  ],
}),
// ]}
```

Check the actual filenames in `node_modules/@ricky0123/vad-web/dist/` — the ONNX filename varies by version (`silero_vad.onnx` in older releases). Copy what exists.

- [ ] **Step 2: Implement `useVoice`**

```ts
// src/renderer/voice/useVoice.ts
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
  submitText(text: string): Promise<void> | void;
  ensureSession(): Promise<string>;
}) {
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
    const off = window.otto.onVoiceEvent((e) => {
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
      additionalAudioConstraints: { echoCancellation: true, noiseSuppression: true },
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
            const buf = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer;
            const { text } = await ipc.invoke('voice.transcribe', { pcm: buf, sampleRate: 16000 });
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

async function teardownVad(ref: React.MutableRefObject<MicVAD | null>): Promise<void> {
  const vad = ref.current;
  ref.current = null;
  try {
    vad?.destroy();
  } catch {
    // already destroyed
  }
}
```

Verify against the installed `@ricky0123/vad-web` version: option names (`baseAssetPath`/`onnxWASMBasePath` vs older `workletURL`/`modelURL`), `destroy()` vs `pause()`, and whether `onSpeechEnd` audio is 16 kHz (it is, by library contract). `ipc` here is the existing thin wrapper in `src/renderer/ipc.ts` — check its export shape and use `window.otto.invoke` directly if simpler.

- [ ] **Step 3: Mic button in CommandBar**

Add props to `Props` in `src/renderer/components/CommandBar.tsx`:

```ts
  /** Voice conversation mode (undefined hides the mic button). */
  voice?: { mode: boolean; state: 'idle' | 'listening' | 'transcribing' | 'speaking'; onToggle(): void };
```

Render a button next to the existing paperclip button (find the `Paperclip` usage; mirror its styling/classes exactly):

```tsx
{voice && (
  <button
    type="button"
    aria-label={voice.mode ? 'Turn off voice mode' : 'Turn on voice mode'}
    title={voice.mode ? `Voice: ${voice.state}` : 'Voice mode'}
    onClick={voice.onToggle}
    className={/* copy the paperclip button's className, plus a conditional accent when voice.mode */ ''}
  >
    {voice.mode ? <MicOff size={16} /> : <Mic size={16} />}
  </button>
)}
```

with `import { Mic, MicOff } from 'lucide-react';`. Use the project's existing accent conventions (violet accent per the UI DNA) for the active state — e.g. the same classes the `Lock` pill uses when `isPrivate`. A subtle CSS pulse on `state === 'listening'` is nice-to-have; skip if it takes more than a few lines.

- [ ] **Step 4: Wire in App.tsx**

In `src/renderer/App.tsx`: find the existing submit handler passed to `CommandBar` (`onSubmit`) and the `ensureSession` prop (App already has `ensureForSubmit` plumbing — reuse the exact same function it passes to CommandBar). Add:

```tsx
const { toggle: toggleVoice } = useVoice({
  submitText: (text) => handleSubmit({ text, attachments: [] }), // whatever the existing onSubmit fn is named
  ensureSession, // the same fn passed to CommandBar
});
const voiceMode = useOttoStore((s) => s.voiceMode);
const voiceState = useOttoStore((s) => s.voiceState);
```

and pass to CommandBar:

```tsx
voice={{ mode: voiceMode, state: voiceState, onToggle: () => void toggleVoice() }}
```

**Session-change sync:** where App switches/creates sessions (the code path that updates the active session id), add: if `useOttoStore.getState().voiceMode`, re-invoke `ipc.invoke('voice.setMode', { enabled: true, sessionId: newId })` so the speech pipeline follows the active session.

- [ ] **Step 5: Typecheck + full test suite**

Run: `pnpm typecheck && pnpm test`
Expected: clean; all suites pass.

- [ ] **Step 6: Manual verification (dev run)**

Run: `pnpm dev`, then:
1. Click the mic button → first enable downloads Kokoro (watch main log), whisper-server boots; button shows active state.
2. Say "hello otto, what time is it?" → pause → your words appear as a user message; Otto's reply is spoken sentence-by-sentence and rendered as text.
3. Ask something tool-heavy ("list my running processes") → narration is spoken, tool output is not.
4. Talk over Otto mid-reply → playback stops instantly; your utterance becomes the next queued message; the in-flight turn completes.
5. Toggle mic off → playback stops, `pgrep -f whisper-server` shows the sidecar exited.
6. Ask for a code snippet → the code block is silently skipped in speech.

- [ ] **Step 7: Commit**

```bash
git add electron.vite.config.ts src/renderer/voice/useVoice.ts src/renderer/components/CommandBar.tsx src/renderer/App.tsx package.json pnpm-lock.yaml
git commit -m "feat: voice conversation mode — mic toggle, VAD capture, spoken replies"
```

---

### Task 12: End-to-end validation pass + risk checks

**Files:** none created — this is the Phase 1 acceptance gate. Record findings in the commit message or a follow-up issue list for Phase 2.

- [ ] **Step 1: Latency measurement**

In voice mode, measure speech-end → first audible TTS (stopwatch or timestamps in main log). Target from spec: **< 2s** with `small.en` on CPU. If over: try `--threads 8` on whisper-server, or `base.en`.

- [ ] **Step 2: Echo/self-trigger check (spec-flagged risk)**

With speakers (not headphones) at normal volume, let Otto speak a long reply and confirm VAD does not barge-in on Otto's own voice. If it self-triggers: raise the VAD positive-speech threshold while `voiceState === 'speaking'` (`vad-web` exposes `positiveSpeechThreshold`; recreate or reconfigure on state change) — implement and commit as a fix.

- [ ] **Step 3: Wayland/PipeWire mic check (spec-flagged risk)**

Confirm `getUserMedia` capture works in the dev build on this machine's Wayland session. If the mic prompt/capture fails, document the failure mode and investigate Electron flags (`--enable-features=WebRTCPipeWireCapturer` historically) before proceeding.

- [ ] **Step 4: Rapid back-to-back utterances**

Speak two questions in quick succession — both should transcribe and queue in order (existing session queue handles this; verify `queueDepth` behaves in the UI).

- [ ] **Step 5: Commit any fixes; summarize residual issues**

```bash
git add -A
git commit -m "fix: voice mode validation fixes (latency/echo/wayland)"
```

Report residual issues + measurements to the user; these seed Phase 2 (settings/polish) and Phase 3 (cross-platform packaging).

---

## Self-Review Notes

- **Spec coverage:** activation (T11 toggle+VAD), STT sidecar w/ resident model (T1, T5), Kokoro TTS (T6), barge-in stop-TTS-only (T6 cancel + T10 stop + T11 onSpeechStart — agent turn untouched), voice-mode-as-state + speak-all-responses (T7–T9, T11), never speak code/tool output (T3, T7), transcript through existing session.send (T11 submitText), error handling (T5 timeouts, T6 skip-on-error, T8 respawn/3-strikes, T11 voice-error teardown), edge cases (back-to-back utterances T12.4, mode-off mid-speech T8/T11, all-code responses T3, echo T12.2, Wayland T12.3), unit tests for filter/chunker/queue/lifecycle per spec's testing section, <2s latency target (T12.1).
- **Deliberately out of plan (per spec phasing):** settings schema v6 + UI, first-run download progress UX (`model-download-progress` event is defined in the shared contract via spec but only `voice-ready`/`voice-error` are emitted in Phase 1 — the type union in Task 2 omits it intentionally; Phase 2 adds it), packaging/CI binaries, macOS/Windows.
- **Type consistency check:** `VoiceEvent` shape used in T2/T6/T8/T11 matches; `SynthFn` return `{pcm, sampleRate}` consistent T6/T8; `WhisperServiceOpts.args(port)` consistent T5/T8; store action names `setVoiceMode`/`setVoiceState` consistent T9/T11; `pcmToWav` returns `Uint8Array` (T4) and is consumed via `Blob([wav])` (T5) — valid.
