# Otto Release Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Otto v0.1.0 via a tag-triggered GitHub Actions workflow that builds signed/notarized macOS, Windows, and Linux artifacts; wire an in-app `electron-updater` flow; and rewrite the README with logo header, badges, feature copy, and three product screenshots.

**Architecture:** Three phases share infrastructure (build resources → release CI → updater feed → README). Phase 1 produces buildable, signed artifacts. Phase 2 makes the running app self-update from those artifacts. Phase 3 documents the result.

**Tech Stack:** electron-builder 25, electron-updater 6, GitHub Actions, Apple Developer ID (Team `YMPSC6RQ4F`, reusing SAI cert), `sharp` + `png2icons` for icon generation, Playwright (via `readme-screenshots` skill) for capture, `op` (1Password CLI) + `gh` for one-shot secret setup.

**Reference spec:** `docs/superpowers/specs/2026-05-23-release-pipeline-design.md`

---

## Phase 1 — Build infrastructure

### Task 1: Add icon generation script

**Files:**
- Create: `scripts/generate-app-icons.mjs`
- Create: `build/` (directory, empty for now — git keeps it via the generated files)
- Modify: `package.json` (add `icons` script + `png2icons` devDep)

- [ ] **Step 1: Install `png2icons`**

```bash
npm install --save-dev png2icons
```

- [ ] **Step 2: Write the generator script**

Create `scripts/generate-app-icons.mjs`:

```javascript
#!/usr/bin/env node
// Reads public/svg/otto.svg, rasterizes to 1024px, then emits:
//   build/icon.png   (512x512, Linux)
//   build/icon.ico   (Windows multi-resolution)
//   build/icon.icns  (macOS)
// Run via `npm run icons`.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import png2icons from 'png2icons';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const srcSvg = join(repoRoot, 'public', 'svg', 'otto.svg');
const outDir = join(repoRoot, 'build');

async function main() {
  const svg = await readFile(srcSvg);
  await mkdir(outDir, { recursive: true });

  // 1024x1024 master PNG (in-memory) for ico/icns generation.
  const master = await sharp(svg, { density: 384 })
    .resize(1024, 1024, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // Linux: 512x512 PNG
  await sharp(master).resize(512, 512).png().toFile(join(outDir, 'icon.png'));

  // Windows .ico (multi-size)
  const ico = png2icons.createICO(master, png2icons.BILINEAR, 0, false);
  if (!ico) throw new Error('createICO failed');
  await writeFile(join(outDir, 'icon.ico'), ico);

  // macOS .icns
  const icns = png2icons.createICNS(master, png2icons.BILINEAR, 0);
  if (!icns) throw new Error('createICNS failed');
  await writeFile(join(outDir, 'icon.icns'), icns);

  console.log('Wrote build/icon.{png,ico,icns}');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Add npm scripts**

In `package.json` `scripts`:
- Add `"icons": "node scripts/generate-app-icons.mjs"`
- Modify `prepackage` to chain icons: `"prepackage": "node scripts/ensure-abi.mjs electron && node scripts/generate-app-icons.mjs"`

- [ ] **Step 4: Run and verify**

```bash
npm run icons
ls -la build/
file build/icon.png build/icon.ico build/icon.icns
```

Expected: three files exist; `file` reports PNG/MS Windows icon/Mac OS X icon respectively. `icon.png` is 512×512.

- [ ] **Step 5: Commit**

```bash
git add scripts/generate-app-icons.mjs package.json package-lock.json build/icon.png build/icon.ico build/icon.icns
git commit -m "build: generate cross-platform app icons from otto.svg"
```

---

### Task 2: Add macOS entitlements

**Files:**
- Create: `build/entitlements.mac.plist`

- [ ] **Step 1: Write the entitlements plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.allow-dyld-environment-variables</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
    <key>com.apple.security.device.audio-input</key>
    <true/>
    <key>com.apple.security.automation.apple-events</key>
    <true/>
</dict>
</plist>
```

Rationale: JIT + unsigned-exec-memory + dyld-env are required by Electron; disable-library-validation is needed for `better-sqlite3` / `sharp` native binaries; audio-input + apple-events support computer-use features (driving other apps, future voice).

- [ ] **Step 2: Verify**

```bash
plutil -lint build/entitlements.mac.plist
```

Expected: `build/entitlements.mac.plist: OK` (on macOS — on Linux just `cat` it and visually confirm).

- [ ] **Step 3: Commit**

```bash
git add build/entitlements.mac.plist
git commit -m "build: add macOS entitlements for hardened runtime"
```

---

### Task 3: Update electron-builder.yml for all platforms

**Files:**
- Modify: `electron-builder.yml` (full rewrite)

- [ ] **Step 1: Rewrite the config**

Replace the entire contents of `electron-builder.yml`:

```yaml
appId: dev.otto.app
productName: Otto
directories:
  output: dist
  buildResources: build
files:
  - out/**
  - public/tray/**
  - public/svg/**
  - package.json

publish:
  provider: github
  owner: darkharasho
  repo: otto

linux:
  target:
    - AppImage
    - deb
  category: Utility
  maintainer: otto-dev@otto.app
  icon: build/icon.png
  artifactName: ${productName}-${version}-${arch}.${ext}

win:
  target: nsis
  icon: build/icon.ico
  artifactName: ${productName}-${version}-${arch}-setup.${ext}

mac:
  target:
    - target: dmg
      arch:
        - x64
        - arm64
    - target: zip
      arch:
        - x64
        - arm64
  category: public.app-category.utilities
  icon: build/icon.icns
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: build/entitlements.mac.plist
  entitlementsInherit: build/entitlements.mac.plist
  notarize:
    teamId: YMPSC6RQ4F

asarUnpack:
  - "**/node_modules/better-sqlite3/**"
  - "**/node_modules/sharp/**"
```

- [ ] **Step 2: Verify Linux build still works locally**

```bash
npm run package -- --linux AppImage --publish never
ls dist/
```

Expected: `Otto-*-x86_64.AppImage` in `dist/`. (`--publish never` prevents accidental upload.)

- [ ] **Step 3: Commit**

```bash
git add electron-builder.yml
git commit -m "build: configure win/mac targets, github publish, icons, entitlements"
```

---

### Task 4: One-shot secret setup script

**Files:**
- Create: `scripts/setup-release-secrets.mjs`

- [ ] **Step 1: Write the script**

```javascript
#!/usr/bin/env node
// One-shot: pulls Apple signing creds from 1Password and sets them as
// GitHub Actions secrets on the otto repo. Idempotent — re-running just
// overwrites. Requires `op` (1Password CLI, signed in) and `gh` (signed in).
//
// Usage: node scripts/setup-release-secrets.mjs

import { execFileSync } from 'node:child_process';

const OP_ITEM = 'Apple App Specific Password';
const OP_VAULT = 'Private';
const GH_REPO = 'darkharasho/otto';

function op(ref) {
  return execFileSync('op', ['read', ref], { encoding: 'utf8' }).trim();
}

function setSecret(name, value) {
  console.log(`Setting ${name}...`);
  execFileSync('gh', ['secret', 'set', name, '--repo', GH_REPO, '--body', value], { stdio: 'inherit' });
}

function main() {
  // The SAI cert section UUID in the 1Password item.
  const SAI_SECTION = 'cq4d2obdnqvlw6obucelfsf77y';

  const cscLink = op(`op://${OP_VAULT}/${OP_ITEM}/${SAI_SECTION}/Cert Base64`);
  const cscKeyPassword = op(`op://${OP_VAULT}/${OP_ITEM}/${SAI_SECTION}/Cert Password`);
  const appleId = op(`op://${OP_VAULT}/${OP_ITEM}/username`);
  const appleAppPassword = op(`op://${OP_VAULT}/${OP_ITEM}/password`);
  const appleTeamId = op(`op://${OP_VAULT}/${OP_ITEM}/add more/Team ID`);

  setSecret('CSC_LINK', cscLink);
  setSecret('CSC_KEY_PASSWORD', cscKeyPassword);
  setSecret('APPLE_ID', appleId);
  setSecret('APPLE_APP_SPECIFIC_PASSWORD', appleAppPassword);
  setSecret('APPLE_TEAM_ID', appleTeamId);

  console.log('\nAll release secrets set on', GH_REPO);
}

main();
```

- [ ] **Step 2: Run it**

```bash
node scripts/setup-release-secrets.mjs
gh secret list --repo darkharasho/otto
```

Expected: five secrets listed (`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`, `CSC_KEY_PASSWORD`, `CSC_LINK`).

- [ ] **Step 3: Commit**

```bash
git add scripts/setup-release-secrets.mjs
git commit -m "build: add one-shot script to sync release secrets from 1Password"
```

---

### Task 5: Release workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write the workflow**

```yaml
name: Build Release Artifacts

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Lint
        run: npm run lint

      - name: Unit tests
        run: npm test

  prepare-release:
    needs: [test]
    runs-on: ubuntu-latest
    steps:
      - name: Create draft release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          tag="${GITHUB_REF#refs/tags/}"
          existing=$(gh release view "$tag" --repo ${{ github.repository }} --json isDraft --jq '.isDraft' 2>/dev/null || echo "none")
          if [ "$existing" = "false" ]; then
            gh release delete "$tag" --repo ${{ github.repository }} --yes
          fi
          gh release create "$tag" --draft --title "$tag" --notes "" --repo ${{ github.repository }} 2>/dev/null || true

  build:
    needs: [prepare-release]
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: ubuntu-latest
            platform: linux
            args: --linux AppImage deb
          - os: windows-latest
            platform: win
            args: --win nsis
          - os: macos-latest
            platform: mac
            args: --mac dmg zip
    runs-on: ${{ matrix.os }}

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Build app
        run: npm run build
        env:
          NODE_OPTIONS: --max-old-space-size=6144

      - name: Build and publish Electron distributables
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          CSC_LINK: ${{ matrix.platform == 'mac' && secrets.CSC_LINK || '' }}
          CSC_KEY_PASSWORD: ${{ matrix.platform == 'mac' && secrets.CSC_KEY_PASSWORD || '' }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_ID_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        run: npx electron-builder ${{ matrix.args }} --publish always

  publish:
    needs: [build]
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set release notes
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          tag="${GITHUB_REF#refs/tags/}"
          if [ -f RELEASE_NOTES.md ]; then
            awk -v ver="$tag" '
              /^Version v[0-9]/ { capture = ($2 == ver) ? 1 : 0; next }
              capture { print }
            ' RELEASE_NOTES.md > /tmp/release-notes-section.md
            if [ -s /tmp/release-notes-section.md ]; then
              gh release edit "$tag" --notes-file /tmp/release-notes-section.md
            else
              gh release edit "$tag" --notes-file RELEASE_NOTES.md
            fi
          fi

      - name: Publish release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          tag="${GITHUB_REF#refs/tags/}"
          gh release edit "$tag" --draft=false
```

- [ ] **Step 2: Validate workflow syntax**

```bash
# If actionlint is installed; otherwise just commit and let GH validate on push.
which actionlint && actionlint .github/workflows/release.yml || echo "actionlint not installed; skipping"
```

- [ ] **Step 3: Commit (do NOT tag yet)**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add tag-triggered release workflow for linux/win/mac"
```

We'll cut a real tag in Task 14 after Phase 2 lands so the first release also exercises the updater feed.

---

## Phase 2 — In-app auto-updater

### Task 6: Install electron-updater + scaffold types

**Files:**
- Modify: `package.json` (add `electron-updater` dep)

- [ ] **Step 1: Install**

```bash
npm install electron-updater
```

- [ ] **Step 2: Verify it resolves**

```bash
node -e "console.log(require('electron-updater/package.json').version)"
```

Expected: `6.x.x` printed.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add electron-updater for auto-update support"
```

---

### Task 7: Updater service — failing tests

**Files:**
- Create: `src/main/updater/index.ts` (stub)
- Create: `src/main/updater/index.test.ts`

- [ ] **Step 1: Write the stub so the tests can import it**

`src/main/updater/index.ts`:

```typescript
export type UpdaterState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

export interface UpdaterApi {
  getState(): UpdaterState;
  check(): Promise<void>;
  download(): Promise<void>;
  install(): void;
  dispose(): void;
}

export interface UpdaterDeps {
  autoUpdater: {
    on(event: string, handler: (...args: unknown[]) => void): void;
    checkForUpdates(): Promise<unknown>;
    downloadUpdate(): Promise<unknown>;
    quitAndInstall(): void;
    autoDownload: boolean;
    autoInstallOnAppQuit: boolean;
  };
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  onStateChange?: (state: UpdaterState) => void;
}

export function createUpdater(_deps: UpdaterDeps): UpdaterApi {
  throw new Error('not implemented');
}
```

- [ ] **Step 2: Write the failing tests**

`src/main/updater/index.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createUpdater, type UpdaterDeps, type UpdaterState } from './index';

function makeDeps(): { deps: UpdaterDeps; handlers: Map<string, (...args: unknown[]) => void>; states: UpdaterState[] } {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const states: UpdaterState[] = [];
  const deps: UpdaterDeps = {
    autoUpdater: {
      on: (event, handler) => { handlers.set(event, handler); },
      checkForUpdates: vi.fn().mockResolvedValue(undefined),
      downloadUpdate: vi.fn().mockResolvedValue(undefined),
      quitAndInstall: vi.fn(),
      autoDownload: true,
      autoInstallOnAppQuit: true,
    },
    setInterval: vi.fn(() => 0 as unknown as NodeJS.Timeout) as unknown as typeof setInterval,
    clearInterval: vi.fn() as unknown as typeof clearInterval,
    onStateChange: (s) => states.push(s),
  };
  return { deps, handlers, states };
}

describe('createUpdater', () => {
  let env: ReturnType<typeof makeDeps>;
  beforeEach(() => { env = makeDeps(); });

  it('starts in idle state and disables electron-updater auto-download', () => {
    const u = createUpdater(env.deps);
    expect(u.getState()).toEqual({ kind: 'idle' });
    expect(env.deps.autoUpdater.autoDownload).toBe(false);
    expect(env.deps.autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it('check() moves to checking, then up-to-date when no update', async () => {
    const u = createUpdater(env.deps);
    const p = u.check();
    expect(u.getState()).toEqual({ kind: 'checking' });
    env.handlers.get('update-not-available')!({});
    await p;
    expect(u.getState()).toEqual({ kind: 'up-to-date' });
  });

  it('transitions to available on update-available event', async () => {
    const u = createUpdater(env.deps);
    const p = u.check();
    env.handlers.get('update-available')!({ version: '0.2.0' });
    await p;
    expect(u.getState()).toEqual({ kind: 'available', version: '0.2.0' });
  });

  it('download() triggers downloadUpdate and reports progress', async () => {
    const u = createUpdater(env.deps);
    await u.check();
    env.handlers.get('update-available')!({ version: '0.2.0' });
    const dp = u.download();
    expect(env.deps.autoUpdater.downloadUpdate).toHaveBeenCalled();
    env.handlers.get('download-progress')!({ percent: 42.5 });
    expect(u.getState()).toEqual({ kind: 'downloading', version: '0.2.0', percent: 42.5 });
    env.handlers.get('update-downloaded')!({ version: '0.2.0' });
    await dp;
    expect(u.getState()).toEqual({ kind: 'downloaded', version: '0.2.0' });
  });

  it('install() calls quitAndInstall when downloaded', async () => {
    const u = createUpdater(env.deps);
    await u.check();
    env.handlers.get('update-available')!({ version: '0.2.0' });
    await u.download();
    env.handlers.get('update-downloaded')!({ version: '0.2.0' });
    u.install();
    expect(env.deps.autoUpdater.quitAndInstall).toHaveBeenCalled();
  });

  it('captures errors as error state', async () => {
    const u = createUpdater(env.deps);
    void u.check();
    env.handlers.get('error')!(new Error('network down'));
    expect(u.getState()).toMatchObject({ kind: 'error', message: 'network down' });
  });

  it('emits state changes to onStateChange callback', async () => {
    const u = createUpdater(env.deps);
    await u.check();
    env.handlers.get('update-available')!({ version: '0.2.0' });
    const kinds = env.states.map((s) => s.kind);
    expect(kinds).toContain('checking');
    expect(kinds).toContain('available');
  });
});
```

- [ ] **Step 3: Run tests, confirm they fail**

```bash
npx vitest run src/main/updater
```

Expected: all 7 tests fail with `not implemented`.

- [ ] **Step 4: Commit (red)**

```bash
git add src/main/updater/index.ts src/main/updater/index.test.ts
git commit -m "test(updater): add failing state-machine tests"
```

---

### Task 8: Updater service — implementation

**Files:**
- Modify: `src/main/updater/index.ts`

- [ ] **Step 1: Implement `createUpdater`**

Replace the stub function with:

```typescript
const FOUR_HOURS = 4 * 60 * 60 * 1000;

export function createUpdater(deps: UpdaterDeps): UpdaterApi {
  let state: UpdaterState = { kind: 'idle' };
  let pendingCheck: { resolve: () => void } | null = null;
  let pendingDownload: { resolve: () => void } | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  // We manage the lifecycle ourselves — disable electron-updater's auto-mode
  // for downloads but keep auto-install on quit (matches our UX promise).
  deps.autoUpdater.autoDownload = false;
  deps.autoUpdater.autoInstallOnAppQuit = true;

  function setState(next: UpdaterState) {
    state = next;
    deps.onStateChange?.(state);
  }

  deps.autoUpdater.on('update-available', (info: unknown) => {
    const version = (info as { version?: string })?.version ?? 'unknown';
    setState({ kind: 'available', version });
    pendingCheck?.resolve();
    pendingCheck = null;
  });

  deps.autoUpdater.on('update-not-available', () => {
    setState({ kind: 'up-to-date' });
    pendingCheck?.resolve();
    pendingCheck = null;
  });

  deps.autoUpdater.on('download-progress', (info: unknown) => {
    const percent = (info as { percent?: number })?.percent ?? 0;
    const version = state.kind === 'available' || state.kind === 'downloading'
      ? state.version
      : 'unknown';
    setState({ kind: 'downloading', version, percent });
  });

  deps.autoUpdater.on('update-downloaded', (info: unknown) => {
    const version = (info as { version?: string })?.version ?? 'unknown';
    setState({ kind: 'downloaded', version });
    pendingDownload?.resolve();
    pendingDownload = null;
  });

  deps.autoUpdater.on('error', (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    setState({ kind: 'error', message });
    pendingCheck?.resolve();
    pendingCheck = null;
    pendingDownload?.resolve();
    pendingDownload = null;
  });

  function check(): Promise<void> {
    setState({ kind: 'checking' });
    return new Promise((resolve) => {
      pendingCheck = { resolve };
      deps.autoUpdater.checkForUpdates().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: 'error', message });
        resolve();
      });
    });
  }

  function download(): Promise<void> {
    if (state.kind !== 'available' && state.kind !== 'error') {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      pendingDownload = { resolve };
      deps.autoUpdater.downloadUpdate().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: 'error', message });
        resolve();
      });
    });
  }

  function install() {
    if (state.kind === 'downloaded') {
      deps.autoUpdater.quitAndInstall();
    }
  }

  timer = deps.setInterval(() => { void check(); }, FOUR_HOURS);

  return {
    getState: () => state,
    check,
    download,
    install,
    dispose: () => { if (timer !== null) deps.clearInterval(timer); },
  };
}
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run src/main/updater
```

Expected: all 7 tests pass.

- [ ] **Step 3: Commit (green)**

```bash
git add src/main/updater/index.ts
git commit -m "feat(updater): implement state-machine wrapper around electron-updater"
```

---

### Task 9: IPC + preload wiring for updater

**Files:**
- Create: `src/main/ipc/updater.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/index.ts` (wire setup)

- [ ] **Step 1: Inspect existing IPC and preload conventions**

Read `src/main/ipc/handlers.ts`, `src/main/ipc/events.ts`, and `src/preload/index.ts` to match style. The pattern is: handlers register `ipcMain.handle('channel', fn)`; preload exposes a typed API via `contextBridge.exposeInMainWorld`.

- [ ] **Step 2: Add the updater IPC module**

Create `src/main/ipc/updater.ts`:

```typescript
import { app, ipcMain, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { logger } from '../logger';
import { createUpdater, type UpdaterApi, type UpdaterState } from '../updater';

let api: UpdaterApi | null = null;

export function setupUpdaterIpc(getWindows: () => BrowserWindow[]): UpdaterApi | null {
  // No-op in dev — electron-updater can't resolve a feed without a packaged build.
  if (!app.isPackaged) {
    ipcMain.handle('updater:status', () => ({ kind: 'idle' } satisfies UpdaterState));
    ipcMain.handle('updater:check', () => ({ kind: 'idle' } satisfies UpdaterState));
    ipcMain.handle('updater:download', () => ({ kind: 'idle' } satisfies UpdaterState));
    ipcMain.handle('updater:install', () => undefined);
    return null;
  }

  autoUpdater.logger = logger;

  api = createUpdater({
    autoUpdater: autoUpdater as unknown as Parameters<typeof createUpdater>[0]['autoUpdater'],
    setInterval,
    clearInterval,
    onStateChange: (state) => {
      for (const w of getWindows()) {
        if (!w.isDestroyed()) w.webContents.send('updater:state', state);
      }
    },
  });

  ipcMain.handle('updater:status', () => api!.getState());
  ipcMain.handle('updater:check', async () => { await api!.check(); return api!.getState(); });
  ipcMain.handle('updater:download', async () => { await api!.download(); return api!.getState(); });
  ipcMain.handle('updater:install', () => api!.install());

  // First check ~30s after startup so we don't block the boot path.
  setTimeout(() => { void api!.check(); }, 30_000);

  return api;
}

export function disposeUpdater() {
  api?.dispose();
  api = null;
}
```

- [ ] **Step 3: Expose to preload**

In `src/preload/index.ts`, locate the existing `contextBridge.exposeInMainWorld(...)` call and add an `updater` namespace alongside the existing APIs:

```typescript
updater: {
  status: () => ipcRenderer.invoke('updater:status'),
  check: () => ipcRenderer.invoke('updater:check'),
  download: () => ipcRenderer.invoke('updater:download'),
  install: () => ipcRenderer.invoke('updater:install'),
  onStateChange: (cb: (state: unknown) => void) => {
    const listener = (_: unknown, state: unknown) => cb(state);
    ipcRenderer.on('updater:state', listener);
    return () => ipcRenderer.removeListener('updater:state', listener);
  },
},
```

Add a matching type to whatever shared types file defines `window.otto` (search for `declare global` or `interface Window` in the renderer/shared directories).

- [ ] **Step 4: Wire into main**

In `src/main/index.ts`, after the main window is created and IPC handlers are registered, call:

```typescript
import { setupUpdaterIpc, disposeUpdater } from './ipc/updater';
import { BrowserWindow } from 'electron';

// inside app.whenReady().then(...)
setupUpdaterIpc(() => BrowserWindow.getAllWindows());

// register cleanup
app.on('before-quit', () => { disposeUpdater(); });
```

- [ ] **Step 5: Build + typecheck**

```bash
npm run typecheck
npm run build
```

Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc/updater.ts src/preload/index.ts src/main/index.ts
git commit -m "feat(updater): wire IPC + preload bridge for renderer access"
```

---

### Task 10: Settings UI for updater

**Files:**
- Create: `src/renderer/components/UpdaterSection.tsx`
- Modify: `src/renderer/SettingsApp.tsx` (mount the section)

- [ ] **Step 1: Inspect SettingsApp**

Read `src/renderer/SettingsApp.tsx` to understand the existing section layout (autonomy, notifications, system). Match the styling conventions.

- [ ] **Step 2: Build UpdaterSection**

Create `src/renderer/components/UpdaterSection.tsx`:

```tsx
import { useEffect, useState } from 'react';

type UpdaterState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

declare global {
  interface Window {
    otto: {
      updater: {
        status(): Promise<UpdaterState>;
        check(): Promise<UpdaterState>;
        download(): Promise<UpdaterState>;
        install(): Promise<void>;
        onStateChange(cb: (s: UpdaterState) => void): () => void;
      };
    } & Window['otto'];
  }
}

export function UpdaterSection({ appVersion }: { appVersion: string }) {
  const [state, setState] = useState<UpdaterState>({ kind: 'idle' });

  useEffect(() => {
    void window.otto.updater.status().then(setState);
    return window.otto.updater.onStateChange(setState);
  }, []);

  const busy = state.kind === 'checking' || state.kind === 'downloading';

  return (
    <section className="settings-section">
      <h2>Updates</h2>
      <p className="muted">Current version: <code>{appVersion}</code></p>
      <StatusLine state={state} />
      <div className="row">
        <button disabled={busy} onClick={() => window.otto.updater.check().then(setState)}>
          Check for updates
        </button>
        {state.kind === 'available' && (
          <button onClick={() => window.otto.updater.download().then(setState)}>
            Download {state.version}
          </button>
        )}
        {state.kind === 'downloaded' && (
          <button onClick={() => window.otto.updater.install()}>
            Install &amp; restart
          </button>
        )}
      </div>
      {state.kind === 'downloading' && (
        <progress max={100} value={state.percent} />
      )}
    </section>
  );
}

function StatusLine({ state }: { state: UpdaterState }) {
  switch (state.kind) {
    case 'idle': return <p className="muted">Idle.</p>;
    case 'checking': return <p>Checking…</p>;
    case 'up-to-date': return <p>You're on the latest version.</p>;
    case 'available': return <p>Otto {state.version} is available.</p>;
    case 'downloading': return <p>Downloading {state.version} — {state.percent.toFixed(0)}%</p>;
    case 'downloaded': return <p>Otto {state.version} downloaded. Install on next quit, or click below.</p>;
    case 'error': return <p className="error">Updater error: {state.message}</p>;
  }
}
```

- [ ] **Step 3: Mount in SettingsApp**

In `src/renderer/SettingsApp.tsx`, import and render `<UpdaterSection appVersion={…} />` next to the other sections. App version comes from `package.json` — read it via the existing preload `getAppVersion` channel if one exists; otherwise add a small `ipcMain.handle('app:version', () => app.getVersion())` to `src/main/ipc/handlers.ts` and expose `window.otto.appVersion()` in preload.

- [ ] **Step 4: Smoke-test in dev**

```bash
npm run dev
```

Open Settings (via tray or hotkey), navigate to the new Updates section. Verify:
- Current version shows.
- "Check for updates" button is present and shows "Idle." (dev no-ops).
- No console errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/UpdaterSection.tsx src/renderer/SettingsApp.tsx src/main/ipc/handlers.ts src/preload/index.ts
git commit -m "feat(updater): add Updates section to Settings"
```

---

### Task 11: Notifier integration

**Files:**
- Modify: `src/main/notifier.ts`
- Modify: `src/main/ipc/updater.ts`

- [ ] **Step 1: Extend Notifier**

Add two methods to the `Notifier` class in `src/main/notifier.ts`:

```typescript
notifyUpdateAvailable(version: string, onClick: () => void): void {
  if (!Notification.isSupported()) return;
  if (this.deps.silent()) return;
  const n = new Notification({
    title: 'Otto update available',
    body: `Otto ${version} is ready to download. Click to install.`,
  });
  n.on('click', onClick);
  n.show();
}

notifyUpdateReady(version: string, onClick: () => void): void {
  if (!Notification.isSupported()) return;
  if (this.deps.silent()) return;
  const n = new Notification({
    title: 'Otto update ready',
    body: `Otto ${version} will install when you quit. Click to install now.`,
  });
  n.on('click', onClick);
  n.show();
}
```

- [ ] **Step 2: Wire from setupUpdaterIpc**

In `src/main/ipc/updater.ts`, accept a `notifier` param and call it from the `onStateChange` callback:

```typescript
export function setupUpdaterIpc(
  getWindows: () => BrowserWindow[],
  notifier: { notifyUpdateAvailable(v: string, cb: () => void): void; notifyUpdateReady(v: string, cb: () => void): void } | null,
): UpdaterApi | null {
  // ...
  onStateChange: (state) => {
    for (const w of getWindows()) {
      if (!w.isDestroyed()) w.webContents.send('updater:state', state);
    }
    if (state.kind === 'available' && notifier) {
      notifier.notifyUpdateAvailable(state.version, () => { void api!.download(); });
    }
    if (state.kind === 'downloaded' && notifier) {
      notifier.notifyUpdateReady(state.version, () => api!.install());
    }
  },
  // ...
}
```

Update the call site in `src/main/index.ts` to pass the existing notifier instance.

- [ ] **Step 3: Typecheck + build**

```bash
npm run typecheck && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/main/notifier.ts src/main/ipc/updater.ts src/main/index.ts
git commit -m "feat(updater): system notifications for available + ready updates"
```

---

## Phase 3 — README + screenshots

### Task 12: Logo header asset

**Files:**
- Create: `public/img/otto-logo.png` (generated from SVG)
- Modify: `scripts/generate-app-icons.mjs` (also emit a 256px logo for README)

- [ ] **Step 1: Extend the icon generator**

In `scripts/generate-app-icons.mjs`, after the master PNG is built, also write:

```javascript
const readmeOutDir = join(repoRoot, 'public', 'img');
await mkdir(readmeOutDir, { recursive: true });
await sharp(master).resize(256, 256).png().toFile(join(readmeOutDir, 'otto-logo.png'));
```

- [ ] **Step 2: Regenerate**

```bash
npm run icons
ls -la public/img/otto-logo.png
```

Expected: 256×256 PNG file present.

- [ ] **Step 3: Commit**

```bash
git add scripts/generate-app-icons.mjs public/img/otto-logo.png
git commit -m "build: emit 256px README logo from icon pipeline"
```

---

### Task 13: Capture README screenshots

**Files:**
- Create: `public/img/screenshots/hero.png`
- Create: `public/img/screenshots/approval-flow.png`
- Create: `public/img/screenshots/settings.png`

- [ ] **Step 1: Invoke the `readme-screenshots` skill**

Use the skill to drive `npm run dev` via Playwright. Target three surfaces:
1. **hero.png** — the main toggle window with a sample prompt entered (e.g. "Fix the audio cracking when I open Discord"). 1400×900 frame.
2. **approval-flow.png** — Otto mid-task with a tool-call approval card visible. Seed the chat via a temporary script if needed (see step 2).
3. **settings.png** — the Settings window open on the Autonomy + Model sections.

The skill handles capture, framing, and writes the PNGs.

- [ ] **Step 2: If needed, seed a demo state**

If the approval-flow shot can't be captured naturally, create `scripts/seed-demo-state.mjs` that pre-populates the SQLite session DB with a synthetic chat + pending approval. Run with `OTTO_DEMO_STATE=1 npm run dev`. (Skip this step if the natural flow works during capture.)

- [ ] **Step 3: Verify files**

```bash
ls -la public/img/screenshots/
file public/img/screenshots/*.png
```

Expected: three PNG files, ~1400×900 dimensions.

- [ ] **Step 4: Commit**

```bash
git add public/img/screenshots/ scripts/seed-demo-state.mjs 2>/dev/null || true
git commit -m "docs: capture README screenshots (hero, approval flow, settings)"
```

---

### Task 14: Rewrite README

**Files:**
- Modify: `README.md` (full rewrite)

- [ ] **Step 1: Write the new README**

```markdown
<p align="center">
  <img src="public/img/otto-logo.png" alt="Otto Logo" width="180" />
</p>

<h1 align="center">Otto</h1>

<p align="center">
  <strong>A computer coworking agent that acts, not advises.</strong>
</p>

<p align="center">
  <a href="https://github.com/darkharasho/otto/releases/latest"><img src="https://img.shields.io/github/v/release/darkharasho/otto?style=flat-square&color=7c7dff" alt="Latest Release" /></a>
  <a href="https://github.com/darkharasho/otto/blob/main/LICENSE"><img src="https://img.shields.io/github/license/darkharasho/otto?style=flat-square" alt="License" /></a>
  <a href="https://github.com/darkharasho/otto/releases"><img src="https://img.shields.io/github/downloads/darkharasho/otto/total?style=flat-square&color=7c7dff" alt="Downloads" /></a>
</p>

---

## Press a hotkey. Tell Otto what's broken. Walk away.

Otto is a desktop coworker for your whole machine. Game stuttering? Discord audio cracking? Some app eating CPU you can't trace? Hit the global hotkey, describe the symptom, and Otto investigates — screenshotting windows, reading logs, running diagnostic shells, browsing for fixes, and applying them with your permission. It's the difference between "here's what to try" and "I tried it, here's what worked."

<img src="public/img/screenshots/hero.png" alt="Otto's command bar with a prompt about fixing audio crackling" width="1400" />

---

## Features

### Action over guidance
Otto runs on the Claude Agent SDK with a computer-use loop: screenshots, mouse, keyboard, shell, web search, and page reading. It diagnoses *and* fixes — it doesn't hand you a checklist.

### Three autonomy modes
Pick **Strict** (every tool call needs approval), **Balanced** (reads + reversible actions are auto-approved, destructive actions prompt), or **Full** (Otto runs unattended). Every tool is tagged by action class: `read` / `reversible` / `destructive` / `irreversible`. A hard denylist blocks catastrophic commands no matter the mode.

<img src="public/img/screenshots/approval-flow.png" alt="An in-progress task showing a tool-call approval card" width="1400" />

### Long-running observation
Otto can sit and watch — sampling CPU, listening for log lines, polling a window's title — until a transient problem reproduces, then capture the state for analysis.

### Per-machine memory
Quirks Otto learns ("on this box, killing PulseAudio fixes Discord; the trackpad gets confused after sleep") get written to a local markdown knowledge file and carried forward across sessions. No cloud sync, no leakage.

### Global hotkey + tray
Otto lives in the system tray. A hotkey raises the command bar; another dismisses it. The app never demands your attention — you summon it.

### Cross-platform shell adapters
Per-OS shell, process, and window adapters mean Otto knows how to enumerate windows on Wayland, list services on Windows, and read logs on macOS without your help.

### Native notifications + auto-update
Tool approvals and turn-complete events ping the system notification center when Otto's window is in the background. Updates check on startup and notify you to install on next quit.

<img src="public/img/screenshots/settings.png" alt="Otto's Settings window showing autonomy, notifications, and model picker" width="1400" />

---

## Quick start

### Download

Grab the latest release for your platform:

- **Linux** — [AppImage / deb](https://github.com/darkharasho/otto/releases/latest)
- **Windows** — [Installer](https://github.com/darkharasho/otto/releases/latest) (unsigned — click "More info → Run anyway" on SmartScreen)
- **macOS** — [DMG (Intel + Apple Silicon)](https://github.com/darkharasho/otto/releases/latest) (signed + notarized)

### Prerequisites

Otto uses the Claude Agent SDK. You'll need an Anthropic API key set in Settings on first launch, or via `ANTHROPIC_API_KEY` in your environment.

### Build from source

```bash
git clone https://github.com/darkharasho/otto.git
cd otto
npm install
npm run dev              # development
npm run package          # build distributable for current platform
```

---

## Tech stack

| Layer        | Technology                              |
|--------------|-----------------------------------------|
| Framework    | Electron 33                             |
| Frontend     | React 18, TypeScript 5.6, Vite          |
| Agent        | Claude Agent SDK                        |
| Storage      | better-sqlite3                          |
| Updates      | electron-updater                        |
| Images       | sharp                                   |
| Build        | electron-builder + electron-vite        |

---

## Contributing

Contributions welcome. Fork, branch, PR.

```bash
git checkout -b my-feature
npm run typecheck
npm run lint
npm test
```

---

## License

See [LICENSE](LICENSE) for details.

---

<p align="center">
  <sub>Built for people who'd rather have it fixed than understand why.</sub>
</p>
```

- [ ] **Step 2: Verify rendering**

Push to a branch and view on GitHub, or run a local markdown preview. Confirm all three screenshots load, logo renders centered, badges link correctly.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README with logo, screenshots, and feature copy"
```

---

### Task 15: Cut v0.1.0 release

**Files:**
- Modify: `package.json` (bump version to `0.1.0`)
- Create: `RELEASE_NOTES.md` (optional — for the publish job's notes step)

- [ ] **Step 1: Bump version**

```bash
npm version 0.1.0 --no-git-tag-version
```

This sets `package.json` `version` to `0.1.0` without creating a tag yet.

- [ ] **Step 2: (Optional) Add RELEASE_NOTES.md**

```markdown
Version v0.1.0

First public release of Otto.

Highlights:
- Global-hotkey command bar with computer-use, shell, and web tools
- Three autonomy modes with per-tool action classes
- Per-machine markdown knowledge file
- Cross-platform builds (Linux AppImage + deb, Windows NSIS, macOS DMG + ZIP signed/notarized)
- In-app auto-update via GitHub Releases
```

- [ ] **Step 3: Commit + tag + push**

```bash
git add package.json RELEASE_NOTES.md
git commit -m "release: v0.1.0"
git tag v0.1.0
git push origin main
git push origin v0.1.0
```

- [ ] **Step 4: Watch the release workflow**

```bash
gh run watch --repo darkharasho/otto
```

Expected: `test` → `prepare-release` → `build` (3 parallel runners, mac ~15 min for notarize) → `publish`. Total ~20–25 min.

- [ ] **Step 5: Verify the release**

```bash
gh release view v0.1.0 --repo darkharasho/otto
```

Expected: release is `Latest`, not draft, with assets: `Otto-0.1.0-x86_64.AppImage`, `Otto-0.1.0-amd64.deb`, `Otto-0.1.0-x64-setup.exe`, `Otto-0.1.0-x64.dmg`, `Otto-0.1.0-arm64.dmg`, plus `.zip` files and `latest*.yml` files (the updater feed).

- [ ] **Step 6: Smoke-test the updater**

Install the v0.1.0 build locally. Then bump to `0.1.1` on a branch, push tag `v0.1.1`, wait for the workflow to publish, and confirm the running v0.1.0 app detects + downloads + installs the update.

---

## Verification checklist (post-implementation)

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm test` passes (including new updater tests)
- [ ] `npm run package` builds locally for current platform
- [ ] Release workflow succeeds end-to-end on `v0.1.0`
- [ ] All three platforms' artifacts download + install + launch
- [ ] macOS build opens without Gatekeeper warning (signed + notarized OK)
- [ ] Settings → Updates section renders and reports state
- [ ] Cutting `v0.1.1` triggers an update notification in the running v0.1.0 app
- [ ] README renders correctly on GitHub with all images visible
