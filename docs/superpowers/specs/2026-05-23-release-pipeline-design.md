# Otto Release Pipeline — Design

**Date:** 2026-05-23
**Scope:** GitHub-built multi-platform releases, in-app auto-update, README with logo + screenshots.

## Goals

1. Tag-triggered GitHub Actions release workflow that builds **Linux** (AppImage + deb), **Windows** (NSIS), and **macOS** (DMG + ZIP, signed + notarized) and publishes artifacts to a GitHub Release.
2. An in-app auto-updater that checks GitHub Releases, notifies the user, downloads on confirm, and installs on next quit.
3. A README with the Otto logo, badges, feature copy, and three product screenshots (hero / approval flow / settings).

## Non-goals

- Code-signing for Windows (no EV cert; ship unsigned NSIS for now — SmartScreen warning is acceptable).
- Linux package signing.
- Auto-update for AppImage outside of `electron-updater`'s built-in support (deb users update manually).
- App Store / MAS distribution.
- A delta/differential update channel (full installer downloads only).

---

## 1. GitHub Release Workflow

### Trigger

`push` of any tag matching `v*` (e.g. `v0.1.0`). Mirrors axipulse/axibridge/sai.

### Jobs

**`test`** (ubuntu-latest)
- Setup Node 22 with npm cache.
- `npm ci`
- `npm run typecheck`
- `npm run lint`
- `npm run test` (vitest)

We skip `test:integration` (Playwright) in the release path — it runs in `ci.yml` on PRs. Release blocks on unit tests + typecheck only to keep tag-builds fast.

**`prepare-release`** (ubuntu-latest, needs: test)
- Creates a draft GitHub release for the tag (idempotent: if a non-draft already exists, delete and recreate as draft, matching axipulse's pattern).

**`build`** (matrix, needs: prepare-release)
- Matrix:
  - `ubuntu-latest` → `--linux AppImage deb`
  - `windows-latest` → `--win nsis`
  - `macos-latest` → `--mac dmg zip`
- Steps: checkout, setup-node 22, `npm ci`, `npm run build`, `npx electron-builder ${args} --publish always`.
- `NODE_OPTIONS=--max-old-space-size=6144` for the build step.
- Mac job additionally sets:
  - `CSC_LINK` — base64 cert (.p12) from secret
  - `CSC_KEY_PASSWORD` — cert password from secret
  - `APPLE_ID` — Apple ID email
  - `APPLE_ID_PASSWORD` and `APPLE_APP_SPECIFIC_PASSWORD` — app-specific password (both names set for compatibility)
  - `APPLE_TEAM_ID` — `YMPSC6RQ4F`
- `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` for all jobs (electron-builder reads this to upload to the draft).

**`publish`** (ubuntu-latest, needs: build)
- If `RELEASE_NOTES.md` exists, slice the section for this tag (`Version vX.Y.Z` header → next header, awk-style like axipulse) and set it as the release body.
- Flip draft → published.

### Required GitHub repo secrets

| Secret | Value source |
|---|---|
| `CSC_LINK` | base64 of the SAI cert .p12 (1Password: "Apple App Specific Password" → Cert (SAI) → "Cert Base64" field) |
| `CSC_KEY_PASSWORD` | `h3sm3rmw24rt` (1Password: same item → Cert (SAI) → "Cert Password") |
| `APPLE_ID` | `mks.stephens@gmail.com` |
| `APPLE_APP_SPECIFIC_PASSWORD` | `ajge-cvel-tbpc-bhll` |
| `APPLE_TEAM_ID` | `YMPSC6RQ4F` |

A one-shot helper script `scripts/setup-release-secrets.mjs` will read these from 1Password via `op` and set them on the GitHub repo via `gh secret set`. Run-once, idempotent.

### Tagging convention

`v<semver>` — e.g. `v0.1.0`. `package.json` `version` must match the tag (sans `v`). A `scripts/release.mjs` helper bumps version, commits, tags, and pushes; the rest is GitHub.

---

## 2. electron-builder config changes

`electron-builder.yml` gains:

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
  target: [AppImage, deb]
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
      arch: [x64, arm64]
    - target: zip
      arch: [x64, arm64]
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

(`sharp` added to `asarUnpack` because its native binaries can fail when packed.)

### New `build/` directory

- `build/entitlements.mac.plist` — JIT, unsigned executable memory, dyld env, plus `com.apple.security.device.audio-input` and `com.apple.security.automation.apple-events` (Otto needs to drive other apps via AppleScript / Accessibility for computer-use).
- `build/icon.icns` — macOS app icon, generated from `public/svg/otto.svg`.
- `build/icon.ico` — Windows icon, generated.
- `build/icon.png` — 512×512 Linux icon, generated.

A new script `scripts/generate-app-icons.mjs` renders all three from the SVG using `sharp` (PNG sizes) plus `png2icons` for `.icns`/`.ico`. Wired as `npm run icons` and called automatically from a new `prepackage` step.

---

## 3. In-app auto-updater

### Library

`electron-updater` (already battle-tested with GH releases; matches sai). Native to electron-builder's publish flow.

### Behavior

- **Disabled in dev** (`!app.isPackaged` → no-op).
- **On app ready + 30s delay:** check for updates.
- **Periodic:** re-check every 4 hours while running.
- **`update-available`:** show a system notification ("Otto vX.Y.Z is available — click to install"). User clicks → `autoUpdater.downloadUpdate()`. No prompt if user dismisses; they can re-trigger from Settings.
- **`download-progress`:** track in renderer state for a Settings progress bar (no toast spam).
- **`update-downloaded`:** show notification ("Update ready — install on quit"). On app quit, electron-updater installs automatically. Also expose an "Install now" button in Settings that calls `quitAndInstall()`.
- **`error`:** log via `electron-log`; surface in Settings updater section only (no toast).

### Code layout

- `src/main/updater/index.ts` — `setupUpdater(mainWindow)`: registers `electron-updater` event handlers, owns the interval timer, manages state.
- `src/main/ipc/updater.ts` — IPC handlers: `updater:check`, `updater:download`, `updater:install`, `updater:status` (returns `{ state, version, progress, error }`).
- `src/preload/updater.ts` — typed `window.otto.updater` API.
- `src/renderer/settings/UpdaterSection.tsx` — Settings panel: current version, status line, "Check for updates" / "Download" / "Install now" buttons, progress bar.

State machine in main:
```
idle → checking → { up-to-date | available }
available → downloading → downloaded
downloaded → (quit-and-install)
* → error → idle  (after surfacing)
```

### Notification reuse

Hooks the existing notify module (`src/main/notify` — added in commit `4ad9c0c`). Adds two new notification kinds: `update-available` and `update-ready`. Both have a single primary action that calls back into IPC.

---

## 4. README

### Structure (modeled on sai)

1. **Logo header** — centered, `public/svg/otto.svg` (the existing logo asset).
2. **Title + tagline** — "Otto — Your computer coworking agent."
3. **Badges** — latest release, license, downloads (shields.io).
4. **Pitch paragraph** — what Otto does, why it exists (action-over-guidance, computer-use, autonomy modes).
5. **Hero screenshot** — main toggle window.
6. **Features** — sections with short copy:
   - Computer-use that actually acts
   - Three autonomy modes (strict / balanced / full)
   - Per-tool action class (read / reversible / destructive / irreversible)
   - Plan-step confirmations + hard denylist
   - Per-machine knowledge file
   - Global hotkey invocation + tray
   - Long-running observation tools
   - Cross-platform shell adapters
   - Native notifications + auto-update
7. **Screenshot — approval flow** — Otto running a task with an approval prompt in view.
8. **Screenshot — Settings** — the expanded settings window (autonomy, notifications, model picker).
9. **Quick start** — download links for each platform, prerequisite note about Anthropic API key, build-from-source block.
10. **Tech stack table** — Electron 33, React 18, Claude Agent SDK, better-sqlite3, electron-updater, sharp.
11. **Contributing** — fork/branch/PR.
12. **License** — link to LICENSE.

### Screenshots

Captured via the `readme-screenshots` skill against `npm run dev`. Saved to `public/img/screenshots/` and referenced with relative paths. Three images, 1400×900 max (matches sai). The skill drives the app via Playwright into each surface, takes the shot, and writes the file.

Pre-screenshot setup:
- A fake/seeded session for the "in-progress task / approval flow" shot (otherwise we'd capture an empty state). Use a scripted IPC harness like sai's `dev:update` pattern — a small script `scripts/seed-demo-state.mjs` that pre-fills a chat with a tool-call awaiting approval, only when `OTTO_DEMO_STATE=1`.

---

## Risks & open questions

- **Mac cert reuse:** Developer ID Application certs are identity-bound (Team `YMPSC6RQ4F`), not app-bound — reusing the SAI cert is technically supported. If Apple ever wants per-app provisioning (e.g. for entitlements requiring extra review), we'd need a fresh cert. Not blocking.
- **Notarization timing:** Apple notarization can take 5–30 min. The release workflow will wait synchronously inside `electron-builder`. Acceptable; if it becomes a bottleneck, we can move notarize to a separate job.
- **Windows SmartScreen:** Unsigned NSIS will show "Windows protected your PC." Users must click "More info → Run anyway." Documented in README. EV cert purchase is a future decision.
- **AppImage auto-update:** electron-updater supports AppImage in-place updates, but the binary must be run from a writable location. Documented in README.
- **better-sqlite3 ABI:** The `predev`/`prebuild`/`prepackage` ABI scripts already exist — confirm they run cleanly under Windows/macOS in CI (they should; they wrap `electron-rebuild`).

## Order of work

1. Build resources: icons + entitlements + electron-builder.yml updates.
2. `scripts/setup-release-secrets.mjs` (one-shot, run locally).
3. `.github/workflows/release.yml`.
4. Auto-updater (main + preload + renderer Settings section).
5. README rewrite + screenshots.
6. Cut `v0.1.0` to validate end-to-end.
