# Otto Screenshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single `screenshot({ region? })` tool that captures the active monitor on KDE Wayland via `spectacle`, persists the PNG to `~/.config/otto/screenshots/<sessionId>/<uuid>.png`, attaches a downscaled copy to the SDK tool result as an `image` content block so the model can see it, and renders the captured image inline in the chat panel via `ToolCallCard`.

**Architecture:** New `src/main/screenshot/` module with three thin units — `executor` (calls `PlatformAdapter.screenshot.capture`), `processor` (`downscaleIfNeeded`), `store` (writes file). The `PlatformAdapter` gains a `screenshot` namespace; `LinuxAdapter` invokes `spectacle -bn`. The SDK handler in `sdk-client.ts` special-cases `name === 'screenshot'` (parallel to `shell_spawn`) so it can attach the base64 image content block. `ToolCallCard` detects the result shape and renders `<img src="file://...">` inline. Action class `read`, no denylist. Spec: `docs/superpowers/specs/2026-05-22-otto-screenshot-design.md`.

**Tech Stack:** TypeScript, Vitest, React + Tailwind, Electron IPC, `node:child_process`, `sharp` (with Electron `nativeImage` as documented fallback).

---

## File Structure

```
src/main/screenshot/
  executor.ts                          # Task 3: capture(opts, adapter) wrapper
  executor.test.ts
  processor.ts                         # Task 4: downscaleIfNeeded
  processor.test.ts
  store.ts                             # Task 5: save bytes to disk
  store.test.ts
src/main/platform/
  index.ts                             # Task 1: +PlatformAdapter.screenshot interface
  linux.ts                             # Task 2: spectacle impl
src/main/agent/
  tools.ts                             # Task 6: +buildScreenshotTool
  tools.test.ts                        # Task 6
  sdk-client.ts                        # Task 7: special-case screenshot result
src/main/index.ts                      # Task 7: pass getConfigDir to SDK client
src/renderer/components/
  ToolCallCard.tsx                     # Task 8: render <img> for screenshot tool
  ToolCallCard.test.tsx                # Task 8
tests/integration/
  screenshot.spec.ts                   # Task 9: fake-SDK driven smoke
```

No changes to `src/shared/messages.ts` or `src/shared/ipc-contract.ts`. No new IPC channels, no new ContentBlock variants, no store reducer changes. The screenshot rides on the existing `tool_use` + `tool_result` round trip.

---

## Task 1: PlatformAdapter.screenshot interface

**Files:**
- Modify: `src/main/platform/index.ts`

Pure type addition. No behavior. The `LinuxAdapter` impl lands in Task 2.

- [ ] **Step 1: Read `src/main/platform/index.ts`**

Note the existing shape — `PlatformAdapter` already has `name`, `detectDisplayServer`, `defaultHotkey`, `shell`. We're adding a sibling `screenshot` namespace.

- [ ] **Step 2: Add `MonitorInfo`, `CaptureResult`, `CaptureOptions`, and extend `PlatformAdapter`**

Add to the file (alongside the existing `ShellChild` and `DisplayServer` types):

```ts
export interface MonitorInfo {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

export interface CaptureOptions {
  region?: { x: number; y: number; w: number; h: number };
}

export interface CaptureResult {
  bytes: Buffer;
  width: number;
  height: number;
  monitor: MonitorInfo;
}
```

Extend the existing `PlatformAdapter` interface to include:

```ts
  screenshot: {
    capture(opts: CaptureOptions): Promise<CaptureResult>;
  };
```

The `getPlatformAdapter()` factory at the bottom of the file doesn't change.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: FAIL — `LinuxAdapter` doesn't yet implement `screenshot`. We'll fix it in Task 2.

This is intentional. The interface and impl land in adjacent commits.

- [ ] **Step 4: Commit**

```bash
git add src/main/platform/index.ts
git commit -m "feat(screenshot): PlatformAdapter.screenshot interface"
```

---

## Task 2: LinuxAdapter screenshot impl

**Files:**
- Modify: `src/main/platform/linux.ts`

Wires `spectacle` to the new interface.

- [ ] **Step 1: Read `src/main/platform/linux.ts`**

Existing structure: `LinuxAdapter` is a class with `name`, `detectDisplayServer()`, `defaultHotkey()`, and a `shell` property. Add a sibling `screenshot` property.

- [ ] **Step 2: Add the `screenshot` impl**

At the top, add imports if they're not already present:

```ts
import { spawn as nodeSpawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { screen } from 'electron';
import type {
  CaptureOptions,
  CaptureResult,
  DisplayServer,
  MonitorInfo,
  PlatformAdapter,
  ShellChild,
} from './index';
```

(If `screen` import from electron isn't already in this file, keep it — it's needed for `screen.getCursorScreenPoint()` / `screen.getDisplayNearestPoint()`. If your `linux.ts` was constructed without electron imports, this is the addition.)

Inside the `LinuxAdapter` class, alongside `shell`, add:

```ts
  screenshot = {
    capture: async (opts: CaptureOptions): Promise<CaptureResult> => {
      const monitor = this.activeMonitor();
      if (opts.region) {
        const r = opts.region;
        if (r.x < 0 || r.y < 0 || r.x + r.w > monitor.w || r.y + r.h > monitor.h) {
          throw new Error(
            `region {x:${r.x},y:${r.y},w:${r.w},h:${r.h}} exceeds monitor bounds {0,0,${monitor.w},${monitor.h}}`
          );
        }
      }

      const tmp = path.join(tmpdir(), `otto-screenshot-${randomUUID()}.png`);
      const args = opts.region
        ? [
            '-bn',
            '--region',
            `${monitor.x + opts.region.x},${monitor.y + opts.region.y},${opts.region.w},${opts.region.h}`,
            '-o',
            tmp,
          ]
        : ['-bnf', '-o', tmp];

      await this.runSpectacle(args, 5_000);

      try {
        const bytes = await fsp.readFile(tmp);
        const { width, height } = this.readPngDims(bytes);
        return { bytes, width, height, monitor };
      } finally {
        await fsp.unlink(tmp).catch(() => {});
      }
    },
  };

  private activeMonitor(): MonitorInfo {
    const point = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(point);
    return {
      id: String(display.id),
      x: display.bounds.x,
      y: display.bounds.y,
      w: display.bounds.width,
      h: display.bounds.height,
      scale: display.scaleFactor,
    };
  }

  private runSpectacle(args: string[], timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = nodeSpawn('spectacle', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1_000).unref();
      }, timeoutMs);
      child.once('error', (err) => {
        clearTimeout(timer);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error('spectacle not found — install kde-spectacle'));
        } else {
          reject(err);
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (timedOut) return reject(new Error('screenshot timed out'));
        if (code !== 0) return reject(new Error(`screenshot failed: ${stderr.trim() || `exit ${code}`}`));
        resolve();
      });
    });
  }

  private readPngDims(bytes: Buffer): { width: number; height: number } {
    // PNG signature is 8 bytes, then IHDR chunk starts at offset 8: length(4) type(4) width(4) height(4)
    if (bytes.length < 24 || bytes.toString('latin1', 0, 8) !== '\x89PNG\r\n\x1a\n') {
      throw new Error('captured file is not a PNG');
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return { width, height };
  }
```

**Note on spectacle flag drift:** if `-bnf` (or `--region`) doesn't work on the installed spectacle version, run `spectacle --help` and adjust. The implementer is empowered to tune flag spelling at runtime; the test invocation is your verifier. Document any deviation in your report.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run existing platform tests**

Run: `npm run test -- src/main/platform/platform.test.ts`
Expected: PASS (4 existing tests).

- [ ] **Step 5: Manual smoke (optional but recommended)**

Confirm spectacle is installed:

```bash
which spectacle
```

If installed, take a quick capture to verify your flag spelling works:

```bash
spectacle -bnf -o /tmp/otto-test.png
ls -la /tmp/otto-test.png
file /tmp/otto-test.png
```

Expected: a PNG file is produced.

- [ ] **Step 6: Commit**

```bash
git add src/main/platform/linux.ts
git commit -m "feat(screenshot): LinuxAdapter spectacle impl"
```

---

## Task 3: Executor — capture wrapper

**Files:**
- Create: `src/main/screenshot/executor.ts`
- Test: `src/main/screenshot/executor.test.ts`

- [ ] **Step 1: Write the failing test**

`src/main/screenshot/executor.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { capture } from './executor';
import type { PlatformAdapter, CaptureResult } from '../platform';

function fakeAdapter(result: CaptureResult): PlatformAdapter {
  return {
    name: 'linux',
    detectDisplayServer: () => 'x11',
    defaultHotkey: () => 'Super+Space',
    shell: { spawnShell: () => ({} as never), composeEnv: () => ({}) },
    screenshot: {
      capture: vi.fn(async () => result),
    },
  } as unknown as PlatformAdapter;
}

describe('capture', () => {
  it('delegates to adapter.screenshot.capture and returns its result', async () => {
    const fixture: CaptureResult = {
      bytes: Buffer.from('png'),
      width: 100,
      height: 50,
      monitor: { id: '1', x: 0, y: 0, w: 1920, h: 1080, scale: 1 },
    };
    const adapter = fakeAdapter(fixture);
    const r = await capture({ region: undefined }, adapter);
    expect(r).toEqual(fixture);
    expect(adapter.screenshot.capture).toHaveBeenCalledWith({ region: undefined });
  });

  it('forwards a region option', async () => {
    const fixture: CaptureResult = {
      bytes: Buffer.from('png'),
      width: 100,
      height: 50,
      monitor: { id: '1', x: 0, y: 0, w: 1920, h: 1080, scale: 1 },
    };
    const adapter = fakeAdapter(fixture);
    const region = { x: 10, y: 20, w: 30, h: 40 };
    await capture({ region }, adapter);
    expect(adapter.screenshot.capture).toHaveBeenCalledWith({ region });
  });

  it('propagates rejections from the adapter', async () => {
    const adapter = fakeAdapter({} as CaptureResult);
    (adapter.screenshot.capture as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    await expect(capture({}, adapter)).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 2: Run, expect fail (cannot find module './executor')**

Run: `npm run test -- src/main/screenshot/executor.test.ts`

- [ ] **Step 3: Create `src/main/screenshot/executor.ts`**

```ts
import type { CaptureOptions, CaptureResult, PlatformAdapter } from '../platform';

export async function capture(
  opts: CaptureOptions,
  adapter: PlatformAdapter
): Promise<CaptureResult> {
  return adapter.screenshot.capture(opts);
}
```

- [ ] **Step 4: Run test, expect PASS (3 tests)**

- [ ] **Step 5: Commit**

```bash
git add src/main/screenshot/executor.ts src/main/screenshot/executor.test.ts
git commit -m "feat(screenshot): executor wrapper"
```

---

## Task 4: Processor — downscaleIfNeeded

**Files:**
- Create: `src/main/screenshot/processor.ts`
- Test: `src/main/screenshot/processor.test.ts`

Adds the `sharp` dependency. If `sharp` doesn't install cleanly under Electron's ABI on this machine, fall back to Electron's `nativeImage` (described below).

- [ ] **Step 1: Install sharp**

Run: `npm install sharp@^0.33.5`
Expected: install succeeds. (`sharp` ships prebuilt binaries for common platforms; no compile step.)

If install fails, see "Fallback to nativeImage" at the end of this task and switch to that path.

- [ ] **Step 2: Write the failing test**

`src/main/screenshot/processor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { downscaleIfNeeded } from './processor';

async function makePng(width: number, height: number): Promise<Buffer> {
  // Solid red PNG.
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer();
}

describe('downscaleIfNeeded', () => {
  it('returns the input unchanged when longest edge is within the budget', async () => {
    const bytes = await makePng(800, 600);
    const r = await downscaleIfNeeded(bytes, 4096);
    expect(r.downscaled).toBe(false);
    expect(r.width).toBe(800);
    expect(r.height).toBe(600);
    expect(r.bytes).toBe(bytes);
  });

  it('downscales when longest edge exceeds the budget, preserving aspect', async () => {
    const bytes = await makePng(8000, 4000);
    const r = await downscaleIfNeeded(bytes, 4096);
    expect(r.downscaled).toBe(true);
    expect(r.width).toBe(4096);
    expect(r.height).toBeGreaterThanOrEqual(2047);
    expect(r.height).toBeLessThanOrEqual(2049);
    expect(r.bytes).not.toBe(bytes);
  });

  it('downscales a tall image by height when height is the longest edge', async () => {
    const bytes = await makePng(2000, 8000);
    const r = await downscaleIfNeeded(bytes, 4096);
    expect(r.downscaled).toBe(true);
    expect(r.height).toBe(4096);
    expect(r.width).toBeGreaterThanOrEqual(1023);
    expect(r.width).toBeLessThanOrEqual(1025);
  });
});
```

- [ ] **Step 3: Run test, expect fail**

- [ ] **Step 4: Create `src/main/screenshot/processor.ts`**

```ts
import sharp from 'sharp';

export interface ProcessResult {
  bytes: Buffer;
  width: number;
  height: number;
  downscaled: boolean;
}

export async function downscaleIfNeeded(
  pngBytes: Buffer,
  maxEdge: number
): Promise<ProcessResult> {
  const meta = await sharp(pngBytes).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) {
    throw new Error('could not read PNG dimensions');
  }
  if (Math.max(width, height) <= maxEdge) {
    return { bytes: pngBytes, width, height, downscaled: false };
  }
  const scale = maxEdge / Math.max(width, height);
  const targetW = Math.round(width * scale);
  const targetH = Math.round(height * scale);
  const out = await sharp(pngBytes).resize(targetW, targetH).png().toBuffer();
  return { bytes: out, width: targetW, height: targetH, downscaled: true };
}
```

- [ ] **Step 5: Run test, expect PASS (3 tests)**

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/main/screenshot/processor.ts src/main/screenshot/processor.test.ts
git commit -m "feat(screenshot): processor (downscaleIfNeeded via sharp)"
```

### Fallback to nativeImage

If `npm install sharp` fails (Electron ABI / native rebuild issue), use Electron's `nativeImage` instead. Replace `processor.ts` with:

```ts
import { nativeImage } from 'electron';

export interface ProcessResult {
  bytes: Buffer;
  width: number;
  height: number;
  downscaled: boolean;
}

export async function downscaleIfNeeded(
  pngBytes: Buffer,
  maxEdge: number
): Promise<ProcessResult> {
  const img = nativeImage.createFromBuffer(pngBytes);
  const { width, height } = img.getSize();
  if (Math.max(width, height) <= maxEdge) {
    return { bytes: pngBytes, width, height, downscaled: false };
  }
  const scale = maxEdge / Math.max(width, height);
  const targetW = Math.round(width * scale);
  const targetH = Math.round(height * scale);
  const resized = img.resize({ width: targetW, height: targetH });
  return { bytes: resized.toPNG(), width: targetW, height: targetH, downscaled: true };
}
```

The test fixtures need updating too — replace `sharp({ create: { ... } }).png().toBuffer()` with a hand-built minimal PNG or call into `nativeImage` to generate. The simplest path: keep `sharp` as a **dev**-only dependency (used only by the tests) and use `nativeImage` in the runtime code. Adjust `package.json` to put `sharp` under `devDependencies` in that case.

Document any switch in your report.

---

## Task 5: Store — save bytes to disk

**Files:**
- Create: `src/main/screenshot/store.ts`
- Test: `src/main/screenshot/store.test.ts`

- [ ] **Step 1: Write the failing test**

`src/main/screenshot/store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { save } from './store';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-screenshot-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('save', () => {
  it('writes the bytes under <configDir>/screenshots/<sessionId>/<uuid>.png and returns the path', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]);
    const p = await save(bytes, 's1', dir);
    expect(p).toMatch(new RegExp(`^${dir}/screenshots/s1/.+\\.png$`));
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p).equals(bytes)).toBe(true);
  });

  it('creates the per-session directory if missing', async () => {
    const bytes = Buffer.from('x');
    const p = await save(bytes, 'fresh-session', dir);
    expect(existsSync(path.dirname(p))).toBe(true);
  });

  it('produces distinct paths for two saves in the same session', async () => {
    const a = await save(Buffer.from('a'), 's1', dir);
    const b = await save(Buffer.from('b'), 's1', dir);
    expect(a).not.toBe(b);
    expect(path.dirname(a)).toBe(path.dirname(b));
  });
});
```

- [ ] **Step 2: Run test, expect fail**

- [ ] **Step 3: Create `src/main/screenshot/store.ts`**

```ts
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function save(
  bytes: Buffer,
  sessionId: string,
  configDir: string
): Promise<string> {
  const dir = path.join(configDir, 'screenshots', sessionId);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${randomUUID()}.png`);
  await fsp.writeFile(file, bytes);
  return file;
}
```

- [ ] **Step 4: Run test, expect PASS (3 tests)**

- [ ] **Step 5: Commit**

```bash
git add src/main/screenshot/store.ts src/main/screenshot/store.test.ts
git commit -m "feat(screenshot): store (write PNG to per-session directory)"
```

---

## Task 6: buildScreenshotTool + tools test additions

**Files:**
- Modify: `src/main/agent/tools.ts`
- Modify: `src/main/agent/tools.test.ts`

- [ ] **Step 1: Read `src/main/agent/tools.ts`**

Note the existing `OttoTool` interface, `stubTools`, `buildShellTools(getRegistry)`. We're adding a sibling `buildScreenshotTool()`.

- [ ] **Step 2: Add the new tool**

At the bottom of the file (after `buildShellTools`):

```ts
export function buildScreenshotTool(): OttoTool {
  return {
    name: 'screenshot',
    description:
      'Capture the active monitor (or an optional region of it) as a PNG. Returns { path, width, height, monitor }. The captured image is attached so the model can see it.',
    actionClass: 'read',
    schema: z.object({
      region: z
        .object({
          x: z.number().int().nonnegative(),
          y: z.number().int().nonnegative(),
          w: z.number().int().positive(),
          h: z.number().int().positive(),
        })
        .optional(),
    }),
    async run(_input) {
      throw new Error('screenshot must be invoked via the SDK handler');
    },
  };
}
```

No new imports needed — `z` and `OttoTool` are already in scope.

- [ ] **Step 3: Write failing tests**

Append to `src/main/agent/tools.test.ts`:

```ts
import { buildScreenshotTool } from './tools';

describe('buildScreenshotTool', () => {
  it('returns a tool named screenshot with static read class', () => {
    const t = buildScreenshotTool();
    expect(t.name).toBe('screenshot');
    expect(t.actionClass).toBe('read');
    expect(t.actionClassFor).toBeUndefined();
    expect(t.denyPatterns).toBeUndefined();
  });

  it('schema accepts no args (region optional)', () => {
    const t = buildScreenshotTool();
    expect(t.schema.parse({})).toEqual({});
  });

  it('schema accepts a well-formed region', () => {
    const t = buildScreenshotTool();
    expect(t.schema.parse({ region: { x: 10, y: 20, w: 30, h: 40 } })).toEqual({
      region: { x: 10, y: 20, w: 30, h: 40 },
    });
  });

  it('schema rejects negative coords', () => {
    const t = buildScreenshotTool();
    expect(() => t.schema.parse({ region: { x: -1, y: 0, w: 10, h: 10 } })).toThrow();
  });

  it('schema rejects zero or negative dimensions', () => {
    const t = buildScreenshotTool();
    expect(() => t.schema.parse({ region: { x: 0, y: 0, w: 0, h: 10 } })).toThrow();
    expect(() => t.schema.parse({ region: { x: 0, y: 0, w: 10, h: -1 } })).toThrow();
  });

  it('direct run throws (handler intercepts)', async () => {
    const t = buildScreenshotTool();
    await expect(t.run({})).rejects.toThrow(/SDK handler/);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npm run test -- src/main/agent/tools.test.ts`
Expected: PASS — existing 5 tests plus 6 new tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/tools.ts src/main/agent/tools.test.ts
git commit -m "feat(screenshot): buildScreenshotTool"
```

---

## Task 7: SDK handler special-case + main bootstrap getConfigDir

**Files:**
- Modify: `src/main/agent/sdk-client.ts`
- Modify: `src/main/index.ts`

Two coupled changes; one commit to keep typecheck green at each step.

- [ ] **Step 1: Read `src/main/agent/sdk-client.ts`**

Find `RealSdkClientDeps`, the per-turn `buildOttoMcpServer(sdk, ctx)`, and the handler that already special-cases `shell_spawn`. We'll add `getConfigDir` to deps and a parallel special case for `screenshot`.

- [ ] **Step 2: Update `RealSdkClientDeps` and add the `getConfigDir` dep**

Replace the existing `RealSdkClientDeps` and `ToolCtx` interfaces with:

```ts
export interface RealSdkClientDeps {
  broker: DecisionBroker;
  currentMessageId: () => string;
  getRegistry: () => ProcessRegistry;
  getConfigDir: () => string;
}

interface ToolCtx {
  broker: DecisionBroker;
  sessionId: string;
  messageId: string;
  getRegistry: () => ProcessRegistry;
  getConfigDir: () => string;
}
```

Find where `ToolCtx` is constructed (inside `sendTurn`) and add `getConfigDir: deps.getConfigDir`.

- [ ] **Step 3: Include the screenshot tool in the per-turn tool list**

Find the line:

```ts
const allTools: OttoTool[] = [...stubTools, ...buildShellTools(ctx.getRegistry)];
```

Update to:

```ts
const allTools: OttoTool[] = [
  ...stubTools,
  ...buildShellTools(ctx.getRegistry),
  buildScreenshotTool(),
];
```

Also update the `buildShellTools(deps.getRegistry)` call (or however the `allowedTools` precomputation works in your version of the file) to include `buildScreenshotTool()` so `allowedTools` includes `mcp__otto-tools__screenshot`.

Add `buildScreenshotTool` to the import line:

```ts
import { buildScreenshotTool, buildShellTools, stubTools, type OttoTool } from './tools';
```

- [ ] **Step 4: Add the screenshot special case alongside `shell_spawn`**

In the wrapped tool handler, after the existing `if (t.name === 'shell_spawn') { ... }` block, add:

```ts
        if (t.name === 'screenshot') {
          const sArgs = args as { region?: { x: number; y: number; w: number; h: number } };
          const captured = await capture(sArgs, getPlatformAdapter());
          const downscaled = await downscaleIfNeeded(captured.bytes, 4096);
          const savedPath = await save(captured.bytes, ctx.sessionId, ctx.getConfigDir());
          const meta = {
            path: savedPath,
            width: captured.width,
            height: captured.height,
            monitor: captured.monitor,
          };
          return {
            content: [
              {
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: 'image/png' as const,
                  data: downscaled.bytes.toString('base64'),
                },
              },
              { type: 'text' as const, text: JSON.stringify(meta) },
            ],
          };
        }
```

Add these imports at the top of the file:

```ts
import { capture } from '../screenshot/executor';
import { downscaleIfNeeded } from '../screenshot/processor';
import { save } from '../screenshot/store';
import { getPlatformAdapter } from '../platform';
```

(`getPlatformAdapter` may already be imported.)

- [ ] **Step 5: Wire `getConfigDir` in `src/main/index.ts`**

Read `src/main/index.ts`. Find the `createRealSdkClient({ broker, currentMessageId, getRegistry })` call. Add `getConfigDir`:

```ts
const sdk = createRealSdkClient({
  broker,
  currentMessageId: () => currentMessageId ?? '',
  getRegistry: () => registry,
  getConfigDir: () => ottoConfigDir,
});
```

`ottoConfigDir` is already imported via `await import('./logger')` further up.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Run tests**

Run: `npm run test`
Expected: PASS (all existing tests + the new tool tests from Task 6).

Note: there are no SDK-handler unit tests (the existing pattern is to test through the integration smoke). The Playwright test in Task 9 exercises the new code path.

- [ ] **Step 8: Commit**

```bash
git add src/main/agent/sdk-client.ts src/main/index.ts
git commit -m "feat(screenshot): SDK handler attaches image content; getConfigDir wired in main"
```

---

## Task 8: ToolCallCard renders inline screenshot

**Files:**
- Modify: `src/renderer/components/ToolCallCard.tsx`
- Modify: `src/renderer/components/ToolCallCard.test.tsx`

- [ ] **Step 1: Read the current `ToolCallCard.tsx`**

Note the prop shape (likely `{ name, input, result, isError }`) and how `result` is currently rendered as JSON inside the expanded body.

- [ ] **Step 2: Append failing tests**

Append to `src/renderer/components/ToolCallCard.test.tsx`:

```ts
describe('ToolCallCard: screenshot rendering', () => {
  it('renders an <img> with file:// URL when name === "screenshot" and result has path', async () => {
    render(
      <ToolCallCard
        name="screenshot"
        input={{}}
        result={{
          path: '/tmp/otto-screenshots/sess/abc.png',
          width: 1920,
          height: 1080,
          monitor: { id: '1', x: 0, y: 0, w: 1920, h: 1080, scale: 1 },
        }}
        isError={false}
      />
    );
    // Expand the card so the body renders.
    await userEvent.click(screen.getByRole('button', { name: /screenshot/i }));
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', 'file:///tmp/otto-screenshots/sess/abc.png');
  });

  it('does not render an <img> for non-screenshot tools', async () => {
    render(
      <ToolCallCard name="shell_exec" input={{}} result={{ stdout: 'hi' }} isError={false} />
    );
    await userEvent.click(screen.getByRole('button', { name: /shell_exec/i }));
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('does not render an <img> for screenshot results without a path', async () => {
    render(<ToolCallCard name="screenshot" input={{}} result={{}} isError={false} />);
    await userEvent.click(screen.getByRole('button', { name: /screenshot/i }));
    expect(screen.queryByRole('img')).toBeNull();
  });
});
```

(If the test file doesn't already `import userEvent from '@testing-library/user-event'`, add the import. Likewise `import { render, screen } from '@testing-library/react'` and `import { ToolCallCard } from './ToolCallCard'` should already be there.)

- [ ] **Step 3: Run, expect fail**

Run: `npm run test -- src/renderer/components/ToolCallCard.test.tsx`
Expected: existing tests PASS, new tests FAIL ("no img element found").

- [ ] **Step 4: Update `ToolCallCard.tsx` to render the image**

In the expanded body, BEFORE the existing JSON `<pre>` block, add:

```tsx
{name === 'screenshot' && hasPath(result) && (
  <img
    src={`file://${(result as { path: string }).path}`}
    alt="screenshot"
    className="my-2 max-w-full rounded border border-border"
  />
)}
```

Add this helper at the bottom of the file (after the component):

```ts
function hasPath(result: unknown): result is { path: string } {
  return (
    typeof result === 'object' &&
    result !== null &&
    'path' in result &&
    typeof (result as { path: unknown }).path === 'string'
  );
}
```

- [ ] **Step 5: Run tests, expect PASS**

Run: `npm run test -- src/renderer/components/ToolCallCard.test.tsx`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/ToolCallCard.tsx src/renderer/components/ToolCallCard.test.tsx
git commit -m "feat(renderer): ToolCallCard renders inline image for screenshot tool"
```

---

## Task 9: Playwright integration — screenshot smoke

**Files:**
- Modify: `src/main/agent/sdk-client.ts` (fake client gains `[screenshot]` branch)
- Create: `tests/integration/screenshot.spec.ts`

- [ ] **Step 1: Extend the fake SDK client with a `[screenshot]` branch**

In `src/main/agent/sdk-client.ts`'s `createFakeSdkClient`, inside the `events()` generator alongside the existing `wantsShell` / `wantsSpawn` / `wantsMutate` branches:

```ts
const wantsScreenshot = text.includes('[screenshot]') && !!deps?.broker;
```

After the existing branches, before the final `else` that emits the plain echo tool call:

```ts
} else if (wantsScreenshot && deps?.broker) {
  const messageId = deps.currentMessageId?.() ?? 'fake-msg';
  const outcome = await deps.broker.decide({
    sessionId: sid,
    messageId,
    callId: 'c-ss',
    toolName: 'screenshot',
    actionClass: 'read',
    input: {},
    denyPatternsFn: null,
  });
  if (outcome === 'allow') {
    try {
      const captured = await capture({}, getPlatformAdapter());
      const downscaled = await downscaleIfNeeded(captured.bytes, 4096);
      const savedPath = await save(
        captured.bytes,
        sid,
        deps?.getConfigDir?.() ?? `${process.env.XDG_CONFIG_HOME ?? '/tmp'}/otto`
      );
      const meta = {
        path: savedPath,
        width: captured.width,
        height: captured.height,
        monitor: captured.monitor,
      };
      void downscaled;
      yield { type: 'tool-call-start', callId: 'c-ss', name: 'screenshot', input: {} };
      yield { type: 'tool-call-result', callId: 'c-ss', result: meta, isError: false };
    } catch (err) {
      yield {
        type: 'tool-call-start',
        callId: 'c-ss',
        name: 'screenshot',
        input: {},
      };
      yield {
        type: 'tool-call-result',
        callId: 'c-ss',
        result: { error: err instanceof Error ? err.message : String(err) },
        isError: true,
      };
    }
  }
}
```

Add `getConfigDir?: () => string` to the optional deps shape of `createFakeSdkClient`:

```ts
function createFakeSdkClient(deps?: {
  broker?: DecisionBroker;
  currentMessageId?: () => string;
  getRegistry?: () => ProcessRegistry;
  getConfigDir?: () => string;
}): SdkClient {
```

And in `createRealSdkClient`'s early return for the fake, ensure `deps` (which now includes `getConfigDir`) passes through unchanged.

The imports needed at the top of `sdk-client.ts` are already added by Task 7 (`capture`, `downscaleIfNeeded`, `save`, `getPlatformAdapter`).

- [ ] **Step 2: Create `tests/integration/screenshot.spec.ts`**

```ts
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const hasDisplay = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

async function launch(cfg: string) {
  mkdirSync(path.join(cfg, 'otto'), { recursive: true });
  writeFileSync(
    path.join(cfg, 'otto', 'settings.json'),
    JSON.stringify({ version: 1, autonomy: { mode: 'balanced' } })
  );
  return electron.launch({
    args: [path.join(process.cwd())],
    env: {
      ...process.env,
      OTTO_FAKE_SDK: '1',
      XDG_CONFIG_HOME: cfg,
      NODE_ENV: 'test',
    },
  });
}

test('screenshot: capture renders inline and persists to disk', async () => {
  test.skip(!hasDisplay, 'no display server available (CI)');

  const cfg = mkdtempSync(path.join(tmpdir(), 'otto-screenshot-e2e-'));
  const app = await launch(cfg);
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('input[placeholder*="Ask Otto" i]');
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.show();
    });

    await page.fill('input[placeholder*="Ask Otto" i]', '[screenshot] please');
    await page.press('input[placeholder*="Ask Otto" i]', 'Enter');

    // ToolCallCard for 'screenshot' appears.
    await expect(page.getByText('screenshot').first()).toBeVisible({ timeout: 10_000 });

    // Expand the card.
    await page.getByRole('button', { name: /screenshot/i }).first().click();

    // The inline image renders.
    const img = page.getByRole('img').first();
    await expect(img).toBeVisible({ timeout: 5_000 });
    const src = await img.getAttribute('src');
    expect(src).toMatch(/^file:\/\//);
    expect(src).toContain(`${cfg}/otto/screenshots/`);

    // The PNG exists on disk under the test's XDG_CONFIG_HOME.
    const filePath = src!.replace(/^file:\/\//, '');
    expect(existsSync(filePath)).toBe(true);
  } finally {
    await app.close();
    rmSync(cfg, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Build and run integration tests**

Run: `npm run build`
Run: `npm run test:integration`
Expected: all integration tests pass. If you're running on a host without `DISPLAY`/`WAYLAND_DISPLAY`, this specific test will skip — that's by design.

If the test fails because spectacle doesn't produce output:
- Verify `spectacle -bnf -o /tmp/test.png` works manually.
- Check Otto's main.log for the actual error.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/screenshot.spec.ts src/main/agent/sdk-client.ts
git commit -m "test(integration): screenshot capture smoke via fake SDK"
```

---

## Task 10: Manual verification

**Files:** none — runtime smoke.

- [ ] **Step 1: Start the dev app**

```bash
npm run dev
```

- [ ] **Step 2: Walk the checklist**

- [ ] In balanced mode, prompt "take a screenshot of my screen" — runs without prompting. The `ToolCallCard` named `screenshot` expands to show the inline image of your active monitor.
- [ ] Region capture: "take a screenshot of region 100,100 500x300" — renders just the cropped portion.
- [ ] Region out of bounds (e.g., the model passes `w: 99999`) — clear error card; no file written.
- [ ] Multi-monitor: move your cursor to the secondary display, then ask for a screenshot — captures the secondary display.
- [ ] `ls ~/.config/otto/screenshots/` — directories per session; PNG files at native resolution inside.
- [ ] In strict mode (via the mode badge), screenshot still runs (read class is auto-allow everywhere).

- [ ] **Step 3: Commit any fixes**

Per-fix commits as needed.

---

## Self-Review Notes

Mapped each spec section to tasks:
- **Goals / one tool / read class / KDE spectacle backend** → Tasks 1 (interface), 2 (impl), 6 (tool definition).
- **Disk persistence + auto-downscale** → Tasks 4 (processor), 5 (store), 7 (wiring).
- **Active monitor selection** → Task 2 (`activeMonitor()` via `screen.getCursorScreenPoint`).
- **Inline render** → Task 8 (ToolCallCard).
- **No new SessionEvent / no new ContentBlock / no IPC channel** → enforced by absence; the architecture rides on existing `tool_use`/`tool_result`.
- **Error handling (spectacle missing, timeout, region OOB, downscale failure, etc.)** → Tasks 2 (spectacle errors), 4 (sharp errors), 7 (handler error propagation).
- **Logging** → Tasks 2 (spectacle) and 7 (capture path); covered by existing logger usage in main.
- **Testing (unit/component/integration)** → Tasks 3, 4, 5, 6, 8, 9.
- **CI guard for no-display** → Task 9 (`test.skip` on no DISPLAY/WAYLAND_DISPLAY).
- **Manual verification checklist** → Task 10.

No placeholders, no "TBD". Method names cross-checked: `capture`, `downscaleIfNeeded`, `save`, `buildScreenshotTool`, `RealSdkClientDeps.getConfigDir`, `PlatformAdapter.screenshot.capture`, `LinuxAdapter.activeMonitor`, `MonitorInfo`, `CaptureOptions`, `CaptureResult`, `hasPath`.

Known seams documented inline:
- Task 1 intentionally leaves typecheck broken; Task 2 closes it.
- Task 4's `sharp` install may fail; fallback to `nativeImage` is fully spelled out.
- Task 2's spectacle flag spelling may drift between versions; runtime verification is part of the manual smoke.
- Task 7's special-case is parallel to the existing `shell_spawn` pattern.
- Task 9's integration test skips on headless CI (`test.skip` guard).
