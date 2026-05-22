# Otto Skeleton — Design

**Date:** 2026-05-22
**Sub-project:** 1 of 6 (Skeleton)
**Status:** Spec, awaiting user review

## Context

Otto is a cross-platform Electron coworking agent (see `README.md` / `CLAUDE.md`). The full vision spans an Electron shell, the Claude Agent SDK, computer-use tools, per-OS shell/process adapters, web search, long-running observers, an autonomy/permission system, and a persistent knowledge file. That is too much for a single spec.

We decomposed into six sub-projects, ordered roughly by dependency:

1. **Skeleton** (this spec) — Electron app + global hotkey + minimal chat UI + Agent SDK, no real tools.
2. Autonomy / permission system — action-class tagging, modes, denylist, confirmations.
3. Shell / process adapter (Linux first) — first real tool.
4. Computer-use tools — screenshot + mouse/keyboard.
5. Web search + page reader.
6. Long-running observers + knowledge file.

Each sub-project gets its own spec → plan → implementation cycle.

The skeleton proves the end-to-end loop (hotkey → UI → Agent SDK → streaming → persistence) so subsequent sub-projects bolt onto a known-good foundation.

## Goals

The skeleton ships:

- Electron app, **Linux-only build**, launches in the background.
- Global hotkey **`Ctrl+Alt+Space`** toggles a frameless, always-on-top, top-center "command bar" window.
- Typing a prompt + Enter starts a Claude Agent SDK session (default model **Sonnet 4.6**, ID `claude-sonnet-4-6`), reusing local Claude Code OAuth credentials. No API key handling in Otto.
- Window grows downward from bar into a panel showing streaming assistant output, tool-call cards, and scrollback. Esc collapses panel back to bar; Esc again hides.
- Smart-resume on next hotkey: if a session is active or recently idle (< 30 min), reopen it; otherwise show a fresh bar.
- Session list / switcher in the panel, backed by **SQLite** (`better-sqlite3`, prebuilt binaries).
- **No real tools yet.** The Agent SDK runs as a pure chat agent. A single stub `echo` tool exists to exercise the tool-call rendering pipeline end-to-end; it is removed when real tools land.
- React + Vite + Tailwind renderer. Target is a "top-tier chat experience" — streaming polish, markdown/code rendering, tool-call cards, animations.

## Non-Goals

Explicitly out of scope for the skeleton:

- Autonomy modes, action-class tags, denylist, plan-step confirmations (sub-project 2).
- Computer-use, shell, web search, observer tools (sub-projects 3–6).
- Windows / macOS builds and packaging.
- Settings UI, model picker, hotkey rebinding. Config via JSON file / env for now.
- Persistent per-machine knowledge file.
- Telemetry, crash reporting, auto-update.

## Architecture

Standard Electron three-process split:

- **Main process** (Node): Electron lifecycle, window mgmt, global hotkey registration, SQLite, Agent SDK host. Single source of truth for persisted state. Inherits auth from local Claude Code.
- **Preload** (sandboxed bridge): exposes a typed `window.otto` API to renderer via `contextBridge`. `nodeIntegration: false`, `contextIsolation: true`.
- **Renderer** (React + Vite + Tailwind): command bar + panel UI. Receives streaming events, sends user input, renders messages and tool-call cards.

**Per-OS adapter seam from day one.** Anything OS-specific (hotkey, window positioning, future shell/process adapters) goes through a `PlatformAdapter` interface in `src/main/platform/`. Linux implementation lives in `src/main/platform/linux.ts`. The interface forces the seam to stay clean even though only Linux is implemented today.

**Agent SDK integration.** Runs in the main process via the official Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). Each Otto session is a long-lived SDK conversation; streaming events flow main → renderer over typed IPC.

**Tooling:** `electron-vite` (Vite for renderer + main + preload in one config), `electron-builder` for packaging, `better-sqlite3` with prebuilt binaries to avoid native rebuild pain in Electron.

### Directory Layout

```
src/
  main/                # Electron main process
    index.ts           # app entry, lifecycle
    window.ts          # window creation, show/hide/grow
    hotkey.ts          # global shortcut registration (delegates to platform adapter)
    agent/             # Agent SDK host (session lifecycle, streaming, tool registration)
    ipc/               # typed IPC handlers
    db/                # SQLite + migrations
    platform/          # OS adapters
      index.ts         # PlatformAdapter interface
      linux.ts         # Linux implementation
  preload/
    index.ts           # contextBridge API
  renderer/            # React app
    App.tsx
    components/        # CommandBar, Panel, MessageList, Message, ToolCallCard, SessionSwitcher, StatusFooter
    state/             # zustand store
    ipc.ts             # typed wrapper around window.otto
  shared/              # types shared across main/preload/renderer (IPC contract, message shapes)
electron-builder.yml
electron.vite.config.ts
package.json
tsconfig.json
tailwind.config.ts
```

## Components

### Renderer

- `CommandBar` — collapsed input, autofocused on hotkey-show. Submitting promotes window to panel mode.
- `Panel` — message list + input footer. Renders as the same window grows downward.
- `MessageList` — virtualized list.
- `Message` variants:
  - `UserMessage`
  - `AssistantMessage` — streams markdown + code blocks; syntax highlighting.
  - `ToolCallCard` — collapsible, shows tool name, args summary, status (pending/running/done/error), result.
- `SessionSwitcher` — popover triggered from panel header; lists past sessions from SQLite, clickable to load.
- `StatusFooter` — model badge, session id, "thinking…" indicator, error state.

### Renderer State (zustand)

- `activeSession`: `{ id, messages[], streaming: boolean, error: string | null }`
- `windowMode`: `'bar' | 'panel'`
- `sessions`: `SessionMeta[]` — lightweight list (id, title, lastActiveAt).

Renderer state is a projection of main-process state, kept up to date via IPC events. Main is authoritative.

### Main

- `agent/session.ts` — manages live SDK sessions, AbortController per turn.
- `agent/tools.ts` — registers the stub `echo` tool.
- `db/repo.ts` — typed SQLite repo (sessions, messages).
- `ipc/handlers.ts` — wires IPC channels to agent + db.
- `window.ts` — bar/panel mode transitions via `setBounds`; positioning per active display.
- `hotkey.ts` — registers `Ctrl+Alt+Space` via Electron `globalShortcut`, delegates platform-specific behavior to `PlatformAdapter`.
- `platform/linux.ts` — X11 hotkey works via Electron built-in; under Wayland (e.g., GNOME) emits a clear startup warning. CLI-toggle fallback for Wayland is deferred.

## Data Flow

### IPC Contract (`shared/ipc.ts`, discriminated unions)

Renderer → Main (request/response):

- `session.start({ resume?: id }) → { sessionId }`
- `session.send({ sessionId, text }) → void`
- `session.cancel({ sessionId }) → void`
- `session.list() → SessionMeta[]`
- `session.load({ sessionId }) → Message[]`
- `window.collapseToBar() → void`

Main → Renderer (streamed events on `session.event`):

- `text-delta` — incremental assistant text.
- `message-start` / `message-end`
- `tool-call-start` — name, args, callId.
- `tool-call-result` — callId, result (or error).
- `error` — structured `{ kind, message, retryable }`.
- `done` — turn complete.

### Turn Lifecycle

1. User submits text in `CommandBar`. Renderer sends IPC `session.start` (if no active session) or reuses the active one, then `session.send`.
2. Renderer transitions `bar → panel`.
3. Main persists the user message to SQLite, calls the SDK with the text on the session.
4. SDK streams events. Main translates each into typed IPC events to renderer.
5. Renderer appends `text-delta` to the active assistant message; `tool-call-*` events render as cards.
6. On `done`, main persists the final assistant message (and any tool calls) to SQLite. Renderer marks streaming complete.

### Smart-Resume on Hotkey

Main keeps `activeSessionId` in memory. On hotkey:

- If `activeSessionId` exists and the session is `active` or its `last_active` is within 30 minutes, the renderer opens directly into panel mode for that session.
- Otherwise, the bar opens fresh.

### Stub Tool

A single `echo` tool is registered with the SDK. Its arg schema, call event, and result event exercise the full tool-call rendering path end-to-end. It is removed when real tools (sub-project 3) land.

## Persistence

**Database file:** `~/.config/otto/otto.db` (XDG_CONFIG_HOME aware). Migrations run on app start; a `schema_version` table tracks the current revision.

### Schema (v1)

```sql
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,         -- SDK session id
  title        TEXT,                     -- derived from first user message; null until set
  created_at   INTEGER NOT NULL,
  last_active  INTEGER NOT NULL,
  model        TEXT NOT NULL,
  status       TEXT NOT NULL             -- 'active' | 'idle' | 'ended'
);

CREATE TABLE messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,         -- ordering within session
  role         TEXT NOT NULL,            -- 'user' | 'assistant' | 'tool'
  content      TEXT NOT NULL,            -- JSON: mirrors SDK content-block model
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_messages_session_seq ON messages(session_id, seq);

CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY
);
```

`messages.content` is a JSON blob whose shape mirrors the SDK's content-block model (text blocks, `tool_use`, `tool_result`). Keeping it as JSON avoids schema churn as tool surfaces evolve. JSON1 queries can be added later if needed.

### What We Don't Store

- Raw streaming deltas. Only final assembled messages get persisted on turn completion.
- The SDK's own session state. The SDK persists its own conversation history under `~/.claude/projects/...`; Otto's DB is for UI-side metadata + a readable mirror for the history view.

### Write Points

- New `sessions` row on first user message.
- New `messages` row on each `message-end` event (or on cancellation, with a `cancelled` marker in `content`).
- `last_active` and `status` updated on every event boundary.

### Reads

- `session.list()` → recent N sessions ordered by `last_active DESC`.
- `session.load()` → all messages for a session ordered by `seq ASC`.

## Window Behavior

- Single `BrowserWindow`, created on app start, hidden initially.
- `frame: false`, `transparent: true`, `alwaysOnTop: true` (level `floating`), `resizable: true`, `skipTaskbar: true`, `focusable: true`.
- Positioned top-center of the active display, recomputed on each show.
- **Bar mode:** ~640 × ~56 px. Just the input. Rounded corners, subtle shadow via CSS.
- **Panel mode:** same width; height grows up to ~70% of display height, min ~320 px. Resize handle on bottom edge.
- Transitions are CSS height animations on a renderer container; the `BrowserWindow` itself resizes via `setBounds` to match (debounced ~16 ms).

### Show / Hide

- Hotkey toggles `window.show()` / `window.hide()` (not destroy) so renderer state survives.
- On show: focus the input. On hide: keep streaming alive in main.
- Click-outside (blur) does **not** auto-hide — too aggressive for an agent mid-step.
- Esc collapses panel → bar. Esc again hides.

### Global Hotkey

- Registered via Electron `globalShortcut.register('Ctrl+Alt+Space', toggle)` on `app.whenReady`.
- If registration fails (another app holds it), log a warning surfaced on next show. No retry loop.
- `BrowserWindow.setVisibleOnAllWorkspaces(true)` so the bar appears on the current workspace.

### Linux Specifics (`platform/linux.ts`)

- X11: Electron `globalShortcut` works natively.
- Wayland (e.g., GNOME): `globalShortcut` is limited. The skeleton targets X11 and emits a clear startup warning on Wayland. A CLI `otto toggle` invoked from a DE shortcut is the planned fallback but is deferred past the skeleton.

## Error Handling

Philosophy: the skeleton is small enough to fail loudly. Errors surface to the renderer as `session.event` `error` payloads and render in-panel as red error cards. No silent swallow.

| Case | Behavior |
|------|----------|
| Local Claude Code creds missing | SDK errors on first `session.start` → structured `error` event → renderer shows "Sign in to Claude Code, then retry." card. |
| Hotkey registration fails | Logged, one-time toast on first show. |
| SDK stream error mid-turn | Mark assistant message as errored, keep prior partial content, allow user to retry. |
| SQLite open fails | Fatal error dialog, app exits. |
| Renderer crash | Electron default crash UI; main logs and keeps running. |
| Unhandled rejections in main | Logged to `~/.config/otto/logs/main.log`; do not crash. |

**Cancellation:** `session.cancel` aborts the in-flight SDK call via AbortSignal. Partial assistant message persists with a `cancelled` marker in its content JSON.

**Logging:** simple file logger at `~/.config/otto/logs/`. One file, rotated by size. Levels: info / warn / error. No telemetry.

## Testing

- **Unit (Vitest):** IPC contract round-trip; SQLite layer (migrations, message read/write); renderer reducer logic; `messages.content` JSON shape.
- **Component (Vitest + React Testing Library):** message renderers (user / assistant / tool-call card); `CommandBar` → `Panel` transition; error card rendering.
- **Integration (Playwright + Electron):** launch the packaged app, fire hotkey via the test harness, type a prompt, assert streaming deltas render, assert the echo stub tool call renders a card, assert resume-on-hotkey behavior.
- **Mocked at the boundary:** the Agent SDK is mocked in unit and integration tests — no real Anthropic API calls in CI.
- **Out of test scope (skeleton):** real Anthropic API responses, cross-OS behavior (Linux only).

### Manual Verification Checklist

Run before declaring the skeleton done:

- [ ] Hotkey toggles window show/hide.
- [ ] Typing a prompt → streaming text appears as deltas.
- [ ] Echo stub tool call renders as a card with name/args/result.
- [ ] Esc collapses panel → bar; Esc again hides.
- [ ] Close + reopen → session resumes if within 30 min.
- [ ] Past sessions visible in switcher; clicking one loads its messages.
- [ ] Restart app → sessions still present in switcher.
- [ ] Auth missing → clear error card with retry instruction.

## Open Questions

None blocking. Future-deferred items (settings UI, Wayland CLI fallback, model picker) are tracked in the Non-Goals section and pick up in subsequent sub-projects.
