# Otto Input Injection — Design

**Date:** 2026-05-22
**Sub-project:** 4b of 6 (the deferred input-injection half of the original computer-use sub-project)
**Status:** Spec, awaiting user review

## Context

Sub-project 4 (Screenshot) gave the agent eyes. This sub-project gives it hands: mouse and keyboard injection on Linux/Wayland. Combined with screenshot, the agent can now drive arbitrary UIs — read the screen, decide what to do, click, type, repeat.

Wayland's strict input isolation means we can't use legacy X11 tools (`xdotool`, `xte`). Two real options:

- **`ydotool` + `ydotoold` (uinput kernel device).** Compositor-agnostic. Requires one-time system setup.
- **xdg-desktop-portal `RemoteDesktop`.** Native Wayland API via D-Bus. No system setup. But the portal stack on this Bazzite install gave us "App info not found" pain with GlobalShortcuts, and RemoteDesktop runs through the same plumbing.

We choose **ydotool** because uinput sits below the portal stack entirely — it works whether the portal does or not. The system setup is genuinely one-time.

## Goals

**Eight tools**, all running through `ydotool` via a new `PlatformAdapter.input` namespace:

| Tool | Args | Class |
|------|------|-------|
| `get_cursor_position` | `()` → `{ x, y }` | `read` |
| `move` | `(x, y)` | `reversible` |
| `scroll` | `(dx, dy, x?, y?)` | `reversible` |
| `click` | `(x, y, button='left', delay_ms=100)` | `destructive` |
| `double_click` | `(x, y, button='left')` | `destructive` |
| `drag` | `(x1, y1, x2, y2, button='left')` | `destructive` |
| `type` | `(text, delay_ms=100)` | `destructive` |
| `key` | `(combo, delay_ms=100)` — e.g. `"Control+S"`, `"F5"`, `"Return"` | `destructive` |

- Coordinates are **active-monitor relative**, same convention as `screenshot`. The adapter adds the monitor's offset before shelling out to ydotool.
- Default `100ms` post-action delay; per-call `delay_ms` override.
- No denylist. The matrix + "Approve for session" is the safety net.
- Key naming follows xdotool convention: named keys (`Return`, `Tab`, `F5`, `Escape`, arrows), modifiers (`Control`, `Alt`, `Shift`, `Super`/`Meta`), combos joined with `+` (`"Control+S"`, `"Control+Alt+T"`). Internal `keymap.ts` translates to Linux input event codes.
- Backend: **`ydotool` + `ydotoold`** systemd user service.
- **Setup auto-recovery:** on first input call, if `ydotoold` is installed but inactive, Otto runs `systemctl --user enable --now ydotoold` automatically (no sudo needed). This covers the common case of "forgot to start the service." Missing binary and missing group membership still require manual fixes; Otto surfaces actionable error messages with the exact commands.

## Non-Goals

- macOS / Windows backends. `PlatformAdapter.input` interface is added; only Linux is implemented.
- Window-targeted input (sending keys to a specific window only). Requires X11 or different Wayland APIs.
- Holding modifier keys across multiple calls. Each call is self-contained.
- Recording / replay macros.
- Specific monitor selection (uses active monitor like screenshot — future polish per the screenshot spec's roadmap).
- Mouse-button tracking / hover events.
- Touch / gesture input.
- Non-US keyboard layout-aware `type` — ydotool types USB HID codes; layout translation is the OS keyboard config's job. Documented limitation.
- Detecting / refusing clicks on Otto's own window. Trust the model + the user's screenshot context.
- Bundling ydotool / ydotoold binaries in the AppImage. They come from the OS package and ship a systemd unit and udev rule we'd otherwise have to recreate.

## Architecture

A new `src/main/input/` module with three thin units, plus a new namespace on `PlatformAdapter`. Same shape as the `screenshot` module.

- **`src/main/input/executor.ts`** — `exec(action, adapter, delayMs)` dispatches an `InputAction` discriminated union to the right `adapter.input.<verb>(args)` method and applies the post-action delay (skipped for `cursorPosition`).
- **`src/main/input/keymap.ts`** — pure `translateKeyCombo(combo: string) → KeyEvent[]`. Maps `"Control+S"` to the press/release sequence using Linux input event codes from `linux/input-event-codes.h`.
- **`src/main/input/setup-check.ts`** — `checkYdotoolReady()` probes `which ydotool` and `systemctl --user is-active ydotoold`. On `inactive`, auto-runs `systemctl --user enable --now ydotoold` and re-polls. Caches success per process; re-probes after failure so the user can fix mid-session.

The `PlatformAdapter` gains an `input` namespace alongside `shell` and `screenshot`. `LinuxAdapter` implements it via `ydotool`. Future macOS/Windows adapters slot in cleanly.

The `screenshot` and `input` namespaces use the same `screen.getDisplayNearestPoint(screen.getCursorScreenPoint())` to resolve the active monitor — consistent agent mental model.

`buildInputTools()` in `src/main/agent/tools.ts` produces the eight `OttoTool`s. Each has static action class per the table; their `run` throws (SDK handler intercepts to inject the adapter, same pattern as `shell_spawn` and `screenshot`).

No new IPC channels, no new `ContentBlock` variants, no `SessionEvent` additions. Input is pure tool-call/tool-result rendered by the existing `ToolCallCard`.

### Directory Layout

```
src/main/input/
  executor.ts                  # InputAction dispatch + delay
  executor.test.ts
  keymap.ts                    # translateKeyCombo
  keymap.test.ts
  setup-check.ts               # ydotool/ydotoold detection + auto-enable
  setup-check.test.ts
src/main/platform/index.ts     # +PlatformAdapter.input interface
src/main/platform/linux.ts     # ydotool impl
src/main/agent/tools.ts        # +buildInputTools
src/main/agent/tools.test.ts   # +input tool tests
src/main/agent/sdk-client.ts   # include input tools in per-turn list + allowedTools; handler dispatch
```

No new shared types. No new renderer components.

## Components

### `keymap.ts`

```ts
export interface KeyEvent {
  /** Linux input event code (from /usr/include/linux/input-event-codes.h). */
  code: number;
  /** 1 = press, 0 = release. */
  state: 0 | 1;
}

export function translateKeyCombo(combo: string): KeyEvent[];
```

- Splits `combo` on `+`. The last token is the key; earlier tokens are modifiers.
- Static `NAME_TO_CODE` table:
  - Modifiers: `Control` → 29 (LEFTCTRL), `Alt` → 56 (LEFTALT), `Shift` → 42 (LEFTSHIFT), `Super`/`Meta` → 125 (LEFTMETA).
  - Common keys: `Return`/`Enter` → 28, `Tab` → 15, `Escape` → 1, `Space` → 57, `Backspace` → 14, `Delete` → 111.
  - Function keys: `F1`–`F12` → 59–68, 87, 88.
  - Arrows: `Up`/`Down`/`Left`/`Right` → 103/108/105/106.
  - Letters `a`–`z` → standard Linux event codes (a=30, …).
  - Digits `0`–`9` → 11, 2–10.
- Builds the event sequence: modifiers down (in order) → key down → key up → modifiers up (reverse order).
- Throws `Error("unknown key: <name>")` for anything unmapped.
- Aliases: `Enter` === `Return`, `Meta` === `Super`.

### `setup-check.ts`

```ts
export interface SetupResult {
  ok: boolean;
  reason: string | null;
  hint: string | null;
}

export async function checkYdotoolReady(): Promise<SetupResult>;
```

Logic:

1. `which ydotool`. On `ENOENT`:
   ```
   ok: false
   reason: "ydotool is not installed"
   hint:   "Install on Fedora/Bazzite: sudo dnf install ydotool"
   ```
2. `systemctl --user is-active ydotoold`. If output is `active`, return `{ ok: true }`.
3. If `inactive` or `failed`: run `systemctl --user enable --now ydotoold` (no sudo). Wait 500 ms. Re-poll `is-active`.
4. If now `active`, return `{ ok: true }`.
5. Else:
   ```
   ok: false
   reason: "ydotoold service is not running and could not be started automatically"
   hint:   "Try manually: systemctl --user enable --now ydotoold"
   ```

Caching:
- `{ ok: true }` cached for process lifetime — subsequent calls are no-ops.
- Failure NOT cached — re-probes on next call so the user can fix things mid-session.

The "user not in `input` group" case is detected at runtime when ydotool's spawn fails with `EACCES`. The adapter (not `setup-check`) catches it and returns a clear error with the `usermod` hint.

### `executor.ts`

```ts
export type InputAction =
  | { kind: 'cursorPosition' }
  | { kind: 'move'; x: number; y: number }
  | { kind: 'scroll'; dx: number; dy: number; x?: number; y?: number }
  | { kind: 'click'; x: number; y: number; button: 'left' | 'right' | 'middle' }
  | { kind: 'doubleClick'; x: number; y: number; button: 'left' | 'right' | 'middle' }
  | { kind: 'drag'; x1: number; y1: number; x2: number; y2: number; button: 'left' | 'right' | 'middle' }
  | { kind: 'type'; text: string }
  | { kind: 'key'; combo: string };

export async function exec(
  action: InputAction,
  adapter: PlatformAdapter,
  delayMs: number
): Promise<unknown>;
```

- `cursorPosition` returns `{ x, y }`, no delay.
- All other kinds return `undefined` (model sees `"ok"`) and sleep `delayMs` afterward.

### `LinuxAdapter.input` implementation

```ts
input = {
  cursorPosition(): Promise<{ x: number; y: number }>;
  move(x, y): Promise<void>;
  scroll(dx, dy, x?, y?): Promise<void>;
  click(x, y, button): Promise<void>;
  doubleClick(x, y, button): Promise<void>;
  drag(x1, y1, x2, y2, button): Promise<void>;
  type(text): Promise<void>;
  key(combo): Promise<void>;
};
```

Per method:

1. `await checkYdotoolReady()`. If `!ok`, throw `new Error(\`${reason}\n\n${hint}\`)`.
2. For coord-taking methods: compute `absX = monitor.x + x`, `absY = monitor.y + y` using `activeMonitor()` (the same helper screenshot uses).
3. Build ydotool argv:
   - `move`: `ydotool mousemove --absolute <absX> <absY>`.
   - `click`: `mousemove --absolute <absX> <absY>` then `click <buttonCode>` (`0xC0` left / `0xC1` right / `0xC2` middle).
   - `doubleClick`: same as click, then a 50 ms sleep, then a second `click`.
   - `drag`: `mousemove --absolute <abs1>`, `mousedown <low-byte>`, `mousemove --absolute <abs2>`, `mouseup <low-byte>`.
   - `scroll(dx, dy, x?, y?)`: if `x`/`y` given, `mousemove --absolute` first; then `mousemove --wheel <dy>` (vertical) and/or `mousemove --hwheel <dx>` (horizontal).
   - `type(text)`: spawn `ydotool type --` with `text` written to stdin to avoid shell-escape issues.
   - `key(combo)`: `translateKeyCombo(combo)` → `ydotool key <code>:<state> <code>:<state> ...`.
4. Spawn `ydotool` via `child_process.spawn`. Await exit. Non-zero → catch stderr; if it matches `EACCES`/`Permission denied`, throw with the `usermod` hint; otherwise throw with raw stderr.
5. `cursorPosition()` bypasses ydotool: read `screen.getCursorScreenPoint()` (Electron), subtract `monitor.x`/`monitor.y`, return `{ x, y }`.

The post-action delay is applied by `executor.ts`, not the adapter.

### `buildInputTools` in `tools.ts`

Returns eight `OttoTool`s, all with `run() { throw 'SDK handler intercepts' }`. Schemas validate coords (non-negative integers) and required fields (text, combo). Action classes per the table.

### SDK handler integration

`src/main/agent/sdk-client.ts` — same pattern as `shell_spawn` and `screenshot`. Add a branch in the wrapped MCP handler:

```ts
const INPUT_TOOL_NAMES = new Set([
  'get_cursor_position', 'move', 'scroll', 'click', 'double_click',
  'drag', 'type', 'key',
]);

if (INPUT_TOOL_NAMES.has(t.name)) {
  const action = toInputAction(t.name, args);
  const delayMs = (args as { delay_ms?: number }).delay_ms ?? 100;
  const result = await exec(action, getPlatformAdapter(), delayMs);
  return {
    content: [
      { type: 'text' as const, text: typeof result === 'undefined' ? 'ok' : JSON.stringify(result) },
    ],
  };
}
```

`toInputAction(name, args)` is a small dispatch helper. Also add the eight tool names to `allowedTools`.

`SYSTEM_PROMPT` is updated to list the eight new tools so the model knows about them.

## Data Flow

### Typical click

1. Model calls `click({ x: 200, y: 150 })`.
2. SDK handler sees `t.name === 'click'`, action class `'destructive'`, `broker.decide(...)`.
3. Balanced mode: prompts. User clicks **Approve for session**.
4. Handler routes to `exec({ kind: 'click', x: 200, y: 150, button: 'left' }, adapter, 100)`.
5. `executor.exec` dispatches to `adapter.input.click(200, 150, 'left')`.
6. `LinuxAdapter.input.click`:
   - `checkYdotoolReady()` → cached `{ ok: true }`.
   - Active monitor at `(0, 0)`; `absX=200, absY=150`.
   - Spawns `ydotool mousemove --absolute 200 150`; awaits exit.
   - Spawns `ydotool click 0xC0`; awaits exit.
7. `executor.exec` sleeps 100 ms.
8. Returns `"ok"` to the SDK; model proceeds.
9. Renderer's `ToolCallCard` shows the call.

### Setup auto-recovery

1. Model calls `click(...)` on first input attempt of the session.
2. `checkYdotoolReady()` finds ydotool installed but `ydotoold` inactive.
3. Runs `systemctl --user enable --now ydotoold` (no sudo). Sleeps 500 ms. Re-polls `is-active`.
4. Now `active` → cached `{ ok: true }` → returns to step (3) above and proceeds normally.

If the auto-enable fails (rare — e.g., systemd user instance not running), the error surfaces with the manual hint.

## Error Handling

| Case | Behavior |
|------|----------|
| `ydotool` not installed | Tool returns `{ isError: true, content: "ydotool is not installed\n\nInstall on Fedora/Bazzite: sudo dnf install ydotool" }`. |
| `ydotoold` inactive | Auto-runs `systemctl --user enable --now ydotoold`. If still inactive, returns the manual hint. |
| User not in `input` group (EACCES on uinput) | Adapter catches the EACCES stderr, throws with `"Permission denied — add your user to the input group: sudo usermod -aG input $USER, then log out and back in."` |
| Coords off-monitor | Validation in the tool: `x ≥ 0`, `y ≥ 0`, `x ≤ monitor.w`, `y ≤ monitor.h`. Off-monitor → `Error("(x, y) outside active monitor bounds {0, 0, W, H}")`. |
| Drag start and end same point | Allowed; degenerates to click + release. |
| `key` combo with unknown name | `translateKeyCombo` throws `Error("unknown key: <name>")`. Tool error envelope. |
| `type` text contains characters ydotool can't produce on the current layout | ydotool returns non-zero or types garbage. Documented limitation; we surface the ydotool exit + stderr. |
| Spawn fails with `ENOENT` (transient race after setup-check passes) | Standard child-process error envelope: `Error("ydotool failed: <stderr or errno>")`. |
| Concurrent input calls | Each spawns its own ydotool process. ydotool itself serializes via uinput. No locking in Otto. |
| Otto's own window at the click target | We don't try to detect/avoid this. If the click hits the chat panel, it typically just refocuses the input — recoverable. |
| Cursor position requested while window hidden | `screen.getCursorScreenPoint()` works regardless. No issue. |
| Setup cached `ok: true`, then user breaks ydotoold mid-session | The actual ydotool spawn fails with a runtime error. Surfaced normally. We don't auto-re-probe. |

**Logging:** every input action logs `input <kind> args=<json>` at debug. Spawn failures at warn with stderr. Setup-check failures at warn with the hint included. Auto-enable attempts at info.

## Testing

### Unit (Vitest)

- **`keymap.test.ts`** — exhaustive table:
  - `'Return'`, `'Enter'`, `'Tab'`, `'Escape'`, `'Space'`, `'Backspace'`, `'Delete'`.
  - `'F1'`–`'F12'`.
  - Arrows: `'Up'`, `'Down'`, `'Left'`, `'Right'`.
  - Letters: `'a'`, `'z'`. Digits: `'0'`, `'9'`.
  - Single modifier + key: `'Control+S'` → `[ctrl_down, s_down, s_up, ctrl_up]`.
  - Multi modifier: `'Control+Alt+T'` → all four modifier transitions wrapping the key.
  - Aliases: `'Enter'` === `'Return'`; `'Meta'` === `'Super'`.
  - Unknown key throws: `'NotAKey'` → `Error("unknown key: NotAKey")`.
  - Unknown modifier throws.

- **`setup-check.test.ts`** — mocks `node:child_process.exec`:
  - `which ydotool` errors `ENOENT` → `{ ok: false, reason: /not installed/, hint: contains 'dnf install ydotool' }`. No `systemctl` call attempted.
  - `which ydotool` ok + `systemctl --user is-active` returns `active` → `{ ok: true }`.
  - `which ydotool` ok + `is-active` returns `inactive` → auto-runs `systemctl --user enable --now ydotoold` → re-polls `is-active` → if now `active`, returns `{ ok: true }`.
  - Same path but the auto-enable still leaves it inactive → `{ ok: false, reason: /could not be started/, hint: contains 'systemctl --user enable --now ydotoold' }`.
  - Second call after success is cached: `exec` called exactly twice total across two calls (once for `which`, once for `is-active`).
  - Second call after failure re-probes.

- **`executor.test.ts`** — fake adapter with `vi.fn`'d `input` methods:
  - `exec({ kind: 'click', x: 10, y: 20, button: 'left' }, adapter, 100)` calls `adapter.input.click(10, 20, 'left')` and waits ≥ 90 ms (fake timers).
  - `exec({ kind: 'cursorPosition' }, adapter, 100)` calls `adapter.input.cursorPosition()` and does NOT add a delay.
  - Each action kind dispatches to the right adapter method with right args.
  - Adapter errors propagate.

- **`tools.test.ts` additions** — for each of the eight tools:
  - Name matches the SDK-facing name (`get_cursor_position`, `move`, etc.).
  - Action class matches the table.
  - Schema accepts well-formed args.
  - Schema rejects negative coords, missing required fields.
  - Direct `.run(...)` throws "must be invoked via the SDK handler".

### Component (Vitest + RTL)

- No new component changes. Input tools render through the existing `ToolCallCard`. No new visual treatment to test.

### Integration (Playwright)

- **None.** Real ydotool requires uinput permissions; faking would just test the mock. Coverage from unit tests + manual.

### Manual Verification

Pre-flight (one-time):

```bash
sudo dnf install ydotool                         # if not installed
sudo usermod -aG input $USER                     # if not in input group
# log out + back in
```

Otto will handle ydotoold start automatically. Verify:

```bash
which ydotool && groups | grep -q input && echo OK
```

Then `npm run dev` and walk:

- [ ] Balanced mode: `"type 'hello' into the focused window"` → approval card, **Approve for session**, "hello" appears wherever your focus is.
- [ ] `"press Control+T"` → opens a new tab in your focused browser/terminal (or whatever has Ctrl+T bound).
- [ ] `"click at 500, 500"` → cursor moves there and clicks.
- [ ] `"scroll down by 5"` → focused window scrolls down.
- [ ] `"drag from 100,100 to 400,400"` → visible drag.
- [ ] `"get cursor position"` → no approval (read class), returns current `{ x, y }`.
- [ ] Strict mode: `move` (reversible) prompts; `get_cursor_position` (read) still doesn't.
- [ ] Stop ydotoold (`systemctl --user stop ydotoold`), restart Otto, prompt to type something → setup-check auto-starts ydotoold, action proceeds. Confirm `systemctl --user is-active ydotoold` is `active` after.
- [ ] Remove yourself from `input` group temporarily (`sudo gpasswd -d $USER input`, log out + back in), try to click — error card shows the exact `usermod` hint.

## Open Questions

None blocking. Known future-deferred items:

- Bundling ydotool/ydotoold in the AppImage.
- Window-targeted input.
- Holding modifier keys across calls.
- Layout-aware `type`.
- macOS / Windows backends.
- Click-on-Otto detection.
