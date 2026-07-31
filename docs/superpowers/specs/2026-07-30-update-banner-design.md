# Auto-Update Banner

**Date:** 2026-07-30
**Status:** Approved (Option A — auto-download, single restart banner)

## Problem

Otto's updater backend is complete (electron-updater against GitHub releases, checks 30s after boot and every 4h, state broadcast over `updater:state`, install-on-quit) but has no in-app surface. Users only learn about updates from OS notifications or by opening Settings → Updates. Updates also require a manual download click, so users who miss the notification never get them.

## Design

### Policy change: auto-download (main process)

In `src/main/ipc/updater.ts`, when the updater transitions to `available`, trigger `api.download()` automatically instead of sending the "available" OS notification. The download runs in the background; install still happens on quit (existing `autoInstallOnAppQuit: true`) or via the banner.

- `createUpdater` (`src/main/updater/index.ts`) is untouched — the policy lives at the integration layer, keeping the unit-tested state machine as is.
- `notifyUpdateAvailable` is removed from the `UpdateNotifier` interface (`ipc/updater.ts`) and from `Notifier` (`src/main/notifier.ts`) — it's redundant once download is automatic. `notifyUpdateReady` stays: it's the only signal users get while the app is in the tray.
- Dev no-op branch unchanged.

### UpdateBanner component (renderer)

New `src/renderer/components/UpdateBanner.tsx`:

- Subscribes via existing bridge: `ipc.updater.status()` on mount, `ipc.updater.onStateChange` for live changes.
- Renders **only** when state is `downloaded` and that version hasn't been dismissed. All other states (`checking`, `available`, `downloading`, `error`) render nothing — download is silent; errors remain visible in Settings → Updates only.
- Content: "Otto v{version} is ready" with two actions:
  - **Restart to update** → `ipc.updater.install()`
  - **Later** (dismiss) → hides the banner and stores the version in `localStorage['otto.update-dismissed']`. The update still installs on next quit. A newer version's banner ignores an older dismissal.
- Styling: slim strip matching the app DNA (near-black surface, violet accent, existing border tokens), no animation beyond the standard fade the app already uses.

### Placement

- **Panel window:** in the footer stack above `CommandBar` (`App.tsx`, the existing `flex flex-col gap-2` footer slot).
- **Chat window:** above `CommandBar` inside the composer area (`ChatWindow.tsx`).
- **Bar mode:** nothing — too small; the user will see the banner on the panel after their first submit.

The component is self-contained (owns its own subscription and dismissal state), so both mounts are just `<UpdateBanner />`.

## Error handling

- Download failures put the updater in `error`; the banner never shows and the 4-hour re-check retries naturally. Errors stay visible in Settings → Updates.
- `install()` on a non-`downloaded` state is already a no-op in the state machine.

## Testing

- `UpdateBanner.test.tsx`: hidden for `idle`/`available`/`downloading`/`error`; shown on `downloaded`; Restart calls `ipc.updater.install`; Later hides and persists per-version; a newer version reappears despite an older dismissal.
- Existing `src/main/updater/index.test.ts` unchanged.
- The `ipc/updater.ts` auto-download hook imports Electron and stays untested, consistent with the rest of that file.

## Out of scope

- Bar-mode indicator, release notes display, update channels, download progress UI outside Settings.
