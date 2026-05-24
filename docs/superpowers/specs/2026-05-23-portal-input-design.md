# Portal-Based Mouse Input — Design

**Date:** 2026-05-23
**Status:** Draft for implementation

## Goal

Replace xdotool for mouse input on Linux with the XDG Desktop Portal `RemoteDesktop` interface, so Otto can click, move, scroll, and drag against native Wayland windows (not just XWayland). Keyboard input (`type`, `key`) stays on xdotool — out of scope.

## Non-goals

- Keyboard input replacement.
- macOS / Windows input paths (Otto is Linux-only today).
- xdotool fallback when the portal is unavailable. KDE Wayland with `xdg-desktop-portal-kde` is the assumed environment.
- Native binary / Rust companion. Pure TypeScript via `dbus-next`.
- libei / `ConnectToEIS`. The portal's older `NotifyPointer*` D-Bus methods are sufficient and simpler.
- Absolute pointer motion via PipeWire streams. We use relative motion with a current-cursor-position delta, which KWin treats as raw (no pointer acceleration applied).

## Section 1 — Architecture

**New module:** `src/main/input/portal.ts`. Factory `createPortalInput({ configDir })` returning an `InputHandle` with `move / click / doubleClick / drag / scroll` methods. Owns the D-Bus connection, session handle, and restore-token persistence. Lazy: first call triggers handshake; subsequent calls reuse the session.

**Modified:** `src/main/platform/linux.ts` — the five mouse methods (`move`, `click`, `doubleClick`, `drag`, `scroll`) delegate to a `portalInput` instance constructed at adapter init. `type`, `key`, and `cursorPosition` keep their current implementations.

**New npm dependency:** `dbus-next` (MIT, no native bindings).

The portal module is intentionally a factory rather than a singleton class export so the platform adapter holds the only instance and tests can inject a stub `bus`.

## Section 2 — Portal handshake & event dispatch

### Token persistence

Path: `${ottoConfigDir}/remote-desktop-token`. Plain text, one line. Read at handshake; written (atomically — `${path}.tmp` then `rename`) after each successful `Start`.

`ottoConfigDir` resolves the same way it does in `src/main/logger.ts` — `XDG_CONFIG_HOME` if set, else `~/.config/otto*`. `portal.ts` imports it from `../logger` to avoid restructuring the platform adapter's constructor.

### Handshake sequence

All steps are async D-Bus method calls to `org.freedesktop.portal.Desktop` on `/org/freedesktop/portal/desktop`. Every method returns a `Request` object path; we subscribe to a single `Response` signal on that path and resolve the promise from there.

1. **CreateSession** — args: `{ handle_token, session_handle_token }`, both 32-hex-char random strings (used by the portal to construct the request and session object paths so we know where to listen). Response carries `session_handle` (a D-Bus object path).
2. **SelectDevices(session_handle, options)** — options: `{ types: 2, persist_mode: 2, restore_token? }`. `types=2` = pointer only (bitmask: keyboard=1, pointer=2, touch=4). `persist_mode=2` = persist permanently. `restore_token` included if the token file exists on disk.
3. **Start(session_handle, "", {})** — second arg is `parent_window` (empty string; we have no XID since we're a transparent Electron window). Opens the user-facing approval dialog if no valid token. Silent if token is valid. Response carries the new `restore_token` (always; we write it back to disk every successful Start in case the portal rotates).

### Event dispatch

After handshake, all input calls use the same `session_handle`:

- **Motion (relative):** compute `(dx, dy) = (target.x, target.y) - screen.getCursorScreenPoint()` from Electron's screen API, then call `NotifyPointerMotion(session_handle, {}, dx, dy)`.
- **Button:** `NotifyPointerButton(session_handle, {}, button_code, state)`. Button codes: `BTN_LEFT=0x110`, `BTN_RIGHT=0x111`, `BTN_MIDDLE=0x112`. State: 1 = press, 0 = release.
- **Scroll:** `NotifyPointerAxis(session_handle, { finish: <bool> }, dx, dy)`. One notch ≈ 10.0 logical units. We expose vertical and horizontal scroll by issuing motion-less axis events (no separate cursor move).

### Operation recipes

- `move(x, y)` = single `NotifyPointerMotion(dx, dy)`.
- `click(x, y, button)` = `move(x, y) → NotifyPointerButton(code, 1) → NotifyPointerButton(code, 0)`.
- `doubleClick(x, y, button)` = `click` twice with a ~50 ms inter-click delay.
- `drag(x1, y1, x2, y2, button)` = `move(x1, y1) → button(1) → move(x2, y2) → button(0)`.
- `scroll(dx, dy, x?, y?)` = if `x/y` provided, `move(x, y)` first; then `NotifyPointerAxis({finish: true}, dx*10, dy*10)`.

### Concurrency

All input calls serialize through a single in-module `Promise` chain so concurrent `click()` and `move()` don't interleave D-Bus traffic. Implementation: a private `tail: Promise<void>` field; every public method does `this.tail = this.tail.then(() => realWork())` and returns the chained promise.

### Error handling

- `CreateSession` / `SelectDevices` / `Start` D-Bus errors → rejected promise from the first input call. Message includes the D-Bus error name and human-readable reason. The agent surfaces it as a tool-call failure; user can re-attempt or revoke + retry.
- User denies the dialog on `Start` → portal Response with non-zero code → rejected promise, no token saved.
- D-Bus disconnect mid-session → next input call retries the handshake from scratch.

## Section 3 — Linux adapter wiring + settings

### `src/main/platform/linux.ts`

Add a private `portalInput` field initialized lazily on first input call (so just constructing the adapter doesn't open a D-Bus session). The five mouse methods become wrappers:

```ts
move:        async (x, y)                  => this.getPortal().move(x, y),
click:       async (x, y, button)          => this.getPortal().click(x, y, button),
doubleClick: async (x, y, button)          => this.getPortal().doubleClick(x, y, button),
drag:        async (x1, y1, x2, y2, btn)   => this.getPortal().drag(x1, y1, x2, y2, btn),
scroll:      async (dx, dy, x, y)          => this.getPortal().scroll(dx, dy, x, y),
```

`getPortal()` is a private method that constructs and caches the `InputHandle` on first call.

`ensureXdotool` calls are removed from the five mouse methods. `type` and `key` keep their existing `ensureXdotool` + `runXdotool` paths unchanged.

### Settings: revoke access

New subsection component `src/renderer/components/settings/RemoteDesktopSection.tsx`. Inserted in the **General** tab's sidebar between `Shortcut` and `Startup`. (`SettingsNav.ts` gets a new entry `{ id: 'remoteDesktop', label: 'Remote desktop' }`.)

UI:

- Status row: "Granted — Otto can control mouse via the desktop portal." OR "Not yet requested — the dialog will appear the first time Otto needs to click."
- A "Revoke access" button (DangerButton style, like the existing "Delete all sessions" pattern). Confirms inline; on confirm, calls `remoteDesktop.revoke` IPC which deletes the token file. Next input call re-triggers the dialog.

New IPC channels in `src/shared/ipc-contract.ts`:

```ts
| { channel: 'remoteDesktop.status'; args: void;  result: { granted: boolean } }
| { channel: 'remoteDesktop.revoke'; args: void;  result: void }
```

Handlers in `src/main/ipc/handlers.ts` — both implemented by checking / unlinking `${configDir}/remote-desktop-token`. The handler module gets `configDir` passed in via `registerIpcHandlers` deps (already there from earlier Memory work).

### System prompt cleanup

In `src/main/agent/sdk-client.ts`'s `SYSTEM_PROMPT`, the existing line:

> `'   Cursor-warp tip: on Wayland the cursor cannot be teleported reliably; if a click needs to land precisely, use \`kdotool windowactivate\` to focus the right window first, then use keyboard navigation (\`key("Tab")\`, \`key("Return")\`) instead of clicking when possible.',`

is now obsolete. Delete that line. Clicks reach native Wayland windows via the portal.

The CRITICAL focus discipline lines (about re-activating Otto's window before each input call after approval) stay — they're still relevant since the autonomy approval can move focus to Otto's window even when clicks work.

## Section 4 — Testing

### `src/main/input/portal.test.ts` (new)

Inject a `bus` stub into `createPortalInput({ configDir, bus })`. The stub records all `callMethod` invocations and returns scripted Response signals. Tests:

1. First `move(x, y)` triggers `CreateSession → SelectDevices → Start` in that order; subsequent `move` skips the handshake (asserted by counting `CreateSession` calls = 1 across two `move`s).
2. When the token file exists at construction time, `SelectDevices` is called with `restore_token` set to the file's contents.
3. After a successful `Start` whose Response includes a new token, the file is written atomically (assert the file contents match the Response token; assert no `${path}.tmp` exists after).
4. `click(123, 456)` issues `NotifyPointerMotion(dx, dy)` (where `dx/dy` are computed from a stubbed cursor position injected via the factory), then `NotifyPointerButton(0x110, 1)`, then `NotifyPointerButton(0x110, 0)`. Assert call order via the stub's recorded log.
5. Concurrent `click` + `move` serialize: fire both without awaiting, then assert the recorded D-Bus call log has all of click 1's events before any of move's events (no interleaving).
6. Handshake error: stub `Start` to emit a Response with non-zero code. First `move` rejects with a message mentioning the failure. No token written.

### Manual integration smoke

On the real KDE Wayland 3440×1440 machine:

1. `npm run dev`. Ask Otto to click on a specific spot in **Dolphin** (native Wayland — xdotool can't reach it). Verify the click lands.
2. First click should trigger the portal approval dialog. Approve.
3. Quit and relaunch Otto. Ask for another click. Verify no dialog appears (token reuse).
4. Settings → General → Remote desktop → Revoke access. Ask for another click. Verify dialog reappears.

### `src/main/platform/linux.test.ts` (existing — light update only)

If the file has any mouse-method tests today, update them to assert delegation to `portalInput`. (Quick grep during implementation; if no such tests exist, skip.)

## Files added / changed

**New:**
- `src/main/input/portal.ts`
- `src/main/input/portal.test.ts`
- `src/renderer/components/settings/RemoteDesktopSection.tsx`
- `src/renderer/components/settings/RemoteDesktopSection.test.tsx` (small smoke test: shows status, revoke triggers IPC)

**Modified:**
- `package.json` — add `dbus-next` dep.
- `src/main/platform/linux.ts` — five mouse methods delegate to portal; `ensureXdotool` calls dropped from them.
- `src/renderer/components/settings/SettingsNav.ts` — new `{ id: 'remoteDesktop', label: 'Remote desktop' }` entry in the General tab, between Shortcut and Startup.
- `src/renderer/SettingsApp.tsx` — new `if (activeSub === 'remoteDesktop') return <RemoteDesktopSection />;` branch in `renderSubsection`.
- `src/shared/ipc-contract.ts` — two new channels.
- `src/main/ipc/handlers.ts` — two new handlers.
- `src/main/agent/sdk-client.ts` — remove the obsolete cursor-warp tip line in `SYSTEM_PROMPT`.

## Open questions deferred to implementation

- Exact `dbus-next` API for the `Request/Response` pattern (the library has helpers but the portal's signal-on-request-path semantics are unusual). Implementer should write a small `awaitResponse(requestPath)` helper in `portal.ts` that handles the subscribe / one-shot await / unsubscribe lifecycle.
- Whether KWin's `NotifyPointerMotion` deltas are interpreted as integer device units or floating-point pixels. The spec says `double` for `dx/dy`. Implementation passes integers (Math.round on the delta) and observes behavior in the smoke test; if values are off by a constant factor, tune.
