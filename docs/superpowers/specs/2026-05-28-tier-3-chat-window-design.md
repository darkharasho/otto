# Tier 3 — Floating Chat Window — Design

## Summary

Add a third window tier to Otto: a full chat-app window with a left conversation sidebar, reusing today's message list and composer. Tier 3 is **draggable, resizable, frameless, always-on-top, hotkey-summonable**, with min/max controls (no close — the hotkey hides). Tiers 1 (condensed bar) and 2 (expanded panel) are untouched.

Up arrow promotes condensed → expanded → tier 3. Down arrow demotes. When demoting from tier 3 the lower tiers snap back to their pinned anchor. Tier 3 remembers its own dragged position and size, and Otto resumes the last tier at the last position when summoned via hotkey.

## Goals

- Chat-app feel comparable to Discord / Claude desktop, while staying inside Otto's HUD personality (always-on-top, frameless, hotkey-driven).
- Tiers 1 / 2 remain pinned bar entry points; their behavior is unchanged.
- Reuse — not redesign — the existing `MessageList`, composer, tool cards, approval cards, and `OttoMark` brand.
- Persistent tier 3 position + size across launches.
- Resume-last-tier-at-last-position when summoned.

## Non-goals

- Multi-window (popping conversations into separate floats).
- Redesigning message bubbles, tool cards, or composer.
- Sidebar features beyond list / new / search / pin / status — no bulk-delete, no folders, no tagging.
- Tier 3 reachable from places other than tier 2 ↑ (no tray menu item, no separate hotkey).

## User experience

### Tier transitions

| From | Input | To |
|---|---|---|
| Hidden | hotkey (`Ctrl+Space`) | Last visible tier, at its last position |
| Tier 1 (condensed bar) | `↑` | Tier 2 (expanded panel), anchored |
| Tier 2 (expanded panel) | `↑` | Tier 3 (floating chat), at last dragged position or default |
| Tier 2 | `↓` | Tier 1, anchored |
| Tier 3 | `↓` | Tier 2, **snapped back to anchor** (tier 3 position retained for next promotion) |
| Tier 3 | hotkey | Hidden; tier 3 position + size + "last tier was 3" recorded |
| Tier 1 | `↓` | Hidden |

### Tier 3 window properties

- **Frameless, transparent, always-on-top, floating, visible on all workspaces** — same `BrowserWindow` flags as tiers 1/2.
- **Draggable** by the custom titlebar via `-webkit-app-region: drag`. Interactive titlebar elements (min/max buttons) get `-webkit-app-region: no-drag`.
- **Resizable** from window edges (native Electron resize on a frameless window).
- **Min size**: 560×400. **Default size** (first time, no remembered bounds): 960×620, centered on the active display.
- **Min/maximize controls** in the titlebar; no close button — hotkey is the hide affordance.
- **Hide-on-blur disabled** in tier 3 regardless of the global `hideOnBlur` setting (tiers 1/2 honor it as today).
- **Position memory**: tier 3 bounds (x, y, w, h) persist to disk on move/resize end.
- **Display fallback**: if remembered bounds land on a now-disconnected display, fall back to default sizing centered on the active display.

### Layout (inside the window)

- **Titlebar** (drag region): OttoMark · "Otto" · "· session title" · LIVE pill while a tool is running · keyboard hint (`↓ collapse`, `⌃␣ hide`) · min/max buttons.
- **Left sidebar** (260px, collapsible to 56px icon-rail):
  - Workspace header (label + count).
  - "New conversation" CTA (accent gradient).
  - Search input (filters conversation list by title; client-side).
  - Pinned section (with star-accent rule).
  - Time-grouped sections: Today / Yesterday / Earlier.
  - Per-row: status dot (running / done / errored / stopped), title, subtitle (time + state), tool-glyphs row.
  - Active row: accent rail, gradient background, pulse on the status dot.
  - Footer: autonomy pill + settings affordance.
- **Main pane**:
  - Slim conversation sub-header (title, started/turns, current model).
  - **Reused `<MessageList>`** from `src/renderer/components/MessageList.tsx`.
  - **Reused `<CommandBar>`** from `src/renderer/components/CommandBar.tsx` as the composer.

## Architecture

### Components (new)

| File | Purpose |
|---|---|
| `src/renderer/components/ChatWindow.tsx` | Tier 3 root: titlebar + sidebar + main pane. Owns the responsive split. |
| `src/renderer/components/ChatTitlebar.tsx` | Drag region, OttoMark, session header, live pill, keyboard hints, min/max. |
| `src/renderer/components/ConversationSidebar.tsx` | Sidebar shell (header, CTA, search, scroll body, footer). |
| `src/renderer/components/ConversationSidebarItem.tsx` | One row: status dot, title, subtitle, tool glyphs, active rail. |
| `src/renderer/components/ConversationGroup.tsx` | Pinned / Today / Yesterday / Earlier group heading + children. |

### Components (reused, unchanged)

- `MessageList`, `Message`, `ToolCallCard`, `ApprovalCard`, `ProcessCard`, `StatusFooter` (or the existing composer wrapper) — wired into `ChatWindow`'s main pane.
- `OttoMark` for the titlebar brand glyph.

### Main process

- `src/main/window.ts`:
  - Extend `WindowMode` to `'bar' | 'panel' | 'chat'`.
  - Add `chat` branch in `applyMode`:
    - Skip anchored `bottomCenter` positioning; use remembered bounds (or default).
    - Allow resize (already enabled at construction). Apply `setMinimumSize(560, 400)`.
    - Toggle `setHideOnBlur(false)` behavior internally when `mode === 'chat'` regardless of stored pref.
  - Track and persist tier 3 bounds: listen for `move` and `resize` end on the window; debounce write to settings.
  - Track `lastVisibleTier` in memory + persisted; `show()` from hidden uses it.
  - Promote/demote: `setMode('chat')` saves snapshot of current pinned anchor → on demote, restore anchor; tier 3 bounds stay cached for next promotion.
- `src/main/shortcuts.ts` (or wherever the hotkey + arrow handlers live): wire `ArrowUp` from tier 2 to `setMode('chat')`, `ArrowDown` from tier 3 to `setMode('panel')`.

### IPC contract (`src/shared/ipc-contract.ts`)

- Extend `WindowMode` literal.
- Add `chatBounds: { x: number; y: number; width: number; height: number } | null` to the persisted window settings.
- Add `lastVisibleMode: WindowMode` to persisted settings.

### Settings persistence

- Reuse the existing settings store. New fields:
  - `window.chatBounds` — last known tier 3 bounds.
  - `window.lastVisibleMode` — for resume-from-hide.
- Validation: on load, if `chatBounds` doesn't intersect any current display work area, treat as null.

### Sidebar data

- Read sessions from the same store `SessionSwitcher` consumes today (`src/renderer/components/SessionSwitcher.tsx`).
- Pin state stored as an array of session IDs in settings: `window.pinnedSessionIds`.
- Time grouping computed in the renderer from session `updatedAt`. Buckets: Pinned, Today (≥ today 00:00 local), Yesterday, Earlier.
- Status dot derived from session state: running (active stream / pending tool) → accent + pulse; done → muted; errored / denied-approval → red; idle / not-yet-run → grey.
- Tool glyphs: take the most recent 3 tool kinds used in the session, render as small accent chips. Mapping reuses `ToolIcon`.

## Behavior details

### Drag

- Titlebar background gets `-webkit-app-region: drag`. The min/max controls and any text we want clickable get `-webkit-app-region: no-drag`.
- On Wayland we already accept that `setBounds` quirks exist; for chat tier we don't reposition while dragging — Electron handles that natively when the user moves the OS window.

### Resize

- `BrowserWindow` is created with `resizable: true` already. Tier 3 simply lifts the bounds-reapplication that tiers 1/2 do in `applyMode`. Min size set via `setMinimumSize`.

### Persistence write timing

- Debounce 250 ms after the last `move` / `resize` event before writing. Avoids hammering settings during drag.

### Resume behavior

- App start: open hidden (current behavior). On first hotkey: show `lastVisibleMode` (default `'bar'`).
- If `lastVisibleMode === 'chat'` and `chatBounds` is null or off-screen, use default sizing centered on the active display.

### Sidebar collapse

- Local UI state, not persisted across launches in v1 (keep scope tight). Collapsing yields a 56px icon rail with the OttoMark, CTA `+`, search icon, and dotted-rail of pinned sessions.

### Maximize

- Maps to `BrowserWindow.maximize()`. The "maximized" state is not persisted; on re-show after hide, we restore to remembered bounds, not the maximized state.

## Edge cases

| Case | Behavior |
|---|---|
| Tier 3 dragged onto a display that's later removed | On next show, detect missing display, fall back to default centered on active display. |
| User presses ↑ in tier 2 while a modal/approval is focused | Ignore the arrow (arrows are tier-promote only when the composer / window-chrome has focus, not when an inline UI is consuming them). |
| Tier 3 minimized then hotkey pressed | Hotkey unhides + brings to front + restores from minimized. |
| Tier 3 maximized then ↓ pressed | Unmaximize, then snap-collapse to tier 2 at anchor. |
| `hideOnBlur=true` set globally | Honored for tiers 1/2; ignored for tier 3. |
| Sidebar item click while a session is streaming | Switch sessions like `SessionSwitcher` does today; preserve streaming state per-session as already implemented. |

## Testing

- `WindowManager.applyMode('chat')` — covered by a unit test asserting it does **not** call `setBounds` to anchor coordinates, applies remembered bounds, and applies min size.
- Settings round-trip: write bounds → reload → bounds returned.
- Off-screen bounds rejection: write bounds outside all current displays → loader returns null.
- Sidebar grouping: given a fixture of sessions, assert correct bucket assignment for Pinned / Today / Yesterday / Earlier.
- Status-dot mapping: given session state fixtures, assert dot variant.
- E2E (Playwright already present): ↑ from tier 2 opens tier 3; drag it; ↓ collapses to tier 2 at anchor; ↑ again restores tier 3 at the dragged position.

## Out of scope (explicitly)

- Sidebar collapse-state persistence.
- Multi-select / bulk operations in the sidebar.
- Drag-to-reorder pinned sessions (pin list is insertion-order in v1).
- Conversation export from the sidebar.
- Per-conversation autonomy badge in the sidebar row (footer autonomy applies globally).
