# Tool Card Polish — Across Surfaces

## Problem

Tool calls render as a generic accordion in three places, all of which expose raw model-facing names and JSON blobs to the end user:

- **Desktop main window** — `src/renderer/components/ToolCallCard.tsx`: shows tool name verbatim, input + result as `JSON.stringify`. Only `screenshot` has a special case (renders `file://` path as `<img>`).
- **Mobile remote** — `ToolCard` in `src/renderer-remote/chat.tsx`: same shape; screenshots arrive as a separate `screenshot-captured` event so the in-card result is still a JSON blob.
- **Overlay feed (unfocused)** — `src/renderer/OverlayApp.tsx`: already humanizes tool details for a handful of bundled tools via `toolDetail()` and `stripToolPrefix()`, but doesn't generalize to MCP tools.

End users see things like `mcp__plugin_github_github__create_pull_request` and `{"data":"iVBORw0KGgoAAAA…"}` instead of "GitHub · Create Pull Request" with the screenshot rendered inline. The polish gap matters for casual use and is especially rough on mobile, where the unstyled blobs dominate the screen.

## Goal

Make tool cards feel like a first-class part of Otto's UI across all three surfaces, with humanized titles, inline parameter summaries, and rich result renderers — without forking presentation logic per surface.

## Non-Goals

- No new tools or capabilities; this is presentation only.
- No changes to the transport (event names, payload shape).
- No retroactive backfill of past sessions beyond what the existing replay already does.
- No theming/customization knobs; one canonical presentation per surface.

## Architecture

A new shared module exposes **pure (no-JSX) semantics** that all three surfaces consume:

```
src/shared/tool-presenters.ts
```

Each surface owns its own React component and styling. The shared module decides *what* a tool is (icon, label, group) and *how* to summarize its input/result; the surface decides *how to draw it* (full card on desktop, compact card on mobile, one-line row in overlay).

### Shared API

```ts
// src/shared/tool-presenters.ts

export type IconName =
  | 'camera' | 'terminal' | 'edit' | 'file' | 'search' | 'globe'
  | 'mouse' | 'keyboard' | 'github' | 'database' | 'image'
  | 'brain' | 'plug' | 'tool'; // generic fallback

export interface ToolDescriptor {
  /** Human-readable verb, e.g. "Create Pull Request", "Run command", "Screenshot". */
  label: string;
  /** Optional group/namespace shown as a small uppercase tag, e.g. "GitHub", "Shell". */
  group?: string;
  /** Icon key resolved to a Lucide component by the consuming surface. */
  icon: IconName;
}

export function describeTool(name: string): ToolDescriptor;

/**
 * One-line param summary suitable for a card header, overlay row, or
 * approval prompt. Returns null when no useful summary exists.
 * Truncates to ~80 chars by default.
 */
export function summarizeInput(name: string, input: unknown, maxLen?: number): string | null;

export type ResultView =
  | { kind: 'image';    src: string; alt?: string; meta?: string }
  | { kind: 'terminal'; stdout?: string; stderr?: string; exitCode?: number; durationMs?: number }
  | { kind: 'markdown'; text: string }
  | { kind: 'kv';       entries: Array<[string, string]> }
  | { kind: 'error';    text: string }
  | { kind: 'empty' }                  // result is undefined / null / ""
  | { kind: 'json';     value: unknown }; // fallback

export function classifyResult(name: string, result: unknown, isError: boolean): ResultView;
```

### Naming logic (`describeTool`)

Resolves in this order:

1. **Built-in Otto tools** (exact map) — `screenshot`, `shell_exec`, `shell_spawn`, `click`, `double_click`, `move`, `type`, `key`, `knowledge_append`, `web_search`, `web_fetch`, etc. Each gets a hand-picked icon + label.
2. **MCP tools** — names matching `^mcp__([^_]+(?:_[^_]+)*?)__(.+)$` are parsed:
   - Strip a `plugin_` prefix if present from the server segment.
   - Strip an `otto-tools` server segment entirely (these are bundled tools — fall back to (1) on the inner name).
   - Title-case the tool name (`create_pull_request` → "Create Pull Request").
   - Title-case the server name as the group, after stripping a trailing `-mcp` / `_mcp` suffix and replacing `-`/`_` with spaces (`github` → "GitHub", `chrome-devtools-mcp` → "Chrome Devtools", with a small override map for known servers like `chrome-devtools-mcp` → "Chrome DevTools" and `github` → "GitHub").
   - Icon picked from a small substring table keyed off the tool name (`screenshot`/`take_screenshot` → camera, `click` → mouse, `read`/`get_file_contents` → file, `search` → search, etc.), falling back to `plug` for unknown MCP tools.
3. **Unknown** — generic `tool` icon, label is the raw name.

### Input summary (`summarizeInput`)

Lifts and generalizes `OverlayApp.tsx`'s `toolDetail()`. Per-tool extractors return a short string suitable for the card header. Examples (existing rules preserved, MCP tools added):

| Tool                                  | Summary                                          |
|---                                    |---                                               |
| `shell_exec`, `shell_spawn`           | first 80 chars of `command`                      |
| `click`, `double_click`, `move`       | `x, y`                                           |
| `type`                                | `"<truncated text>"`                             |
| `key`                                 | `combo`                                          |
| `screenshot`                          | `window` ?? `region` ?? "full"                   |
| `knowledge_append`                    | first 80 chars of `note`                         |
| `web_search`                          | `"<query>"`                                      |
| `web_fetch`                           | hostname of `url`                                |
| `read_file` / `*get_file_contents`    | `path` (basename or last 2 segments)             |
| `edit_file` / Edit / Write            | `path`                                           |
| `mcp__*github*__create_pull_request`  | `repo · "<title>"`                               |
| `mcp__*github*__list_*`               | `repo` / `query`                                 |
| MCP generic                           | first string field of input, truncated          |
| Unknown                               | `null`                                           |

A small registry table drives this so adding a new tool is one entry.

### Result classification (`classifyResult`)

Order of checks:

1. **`isError`** → `{ kind: 'error', text }` (extracts message from `result.error` / string).
2. **Empty** → `{ kind: 'empty' }` if `null` / `undefined` / `""`.
3. **Image-shaped**:
   - `screenshot` result with `path` → `{ kind: 'image', src: 'file://...' }` (desktop only — mobile gets `signedUrl` via the existing separate `screenshot-captured` channel).
   - Any string containing `data:image/...;base64,...` → strip and use as `src`. (Catches `chrome-devtools-mcp.take_screenshot`, `playwright.browser_take_screenshot`.)
   - SDK content-block array containing `{ type: 'image', source: { type: 'base64', media_type, data } }` → reassemble to `data:<media_type>;base64,<data>`.
4. **Terminal-shaped**: `shell_exec` / `shell_spawn` results with `stdout` / `stderr` / `exitCode` → `{ kind: 'terminal', ... }`.
5. **Markdown-shaped**: `web_fetch`, `knowledge_*` results, or any result whose primary string content looks like markdown (heuristic: contains `\n#` or `\n- ` or `](`) → `{ kind: 'markdown', text }`.
6. **KV-shaped**: small flat objects (≤ 6 top-level scalar fields) → `{ kind: 'kv', entries }`. MCP results like `{number, url, state}` land here.
7. **Fallback** → `{ kind: 'json', value }`.

The function is intentionally conservative — anything ambiguous falls through to `json`, which renders identically to today.

## Per-Surface Components

### Desktop — `ToolCallCard.tsx`

Header: `[Icon] [GROUP · Label]   [one-line input summary]                 [status] [chev]`

Expanded body sections (in order, each present only when relevant):

- **Input** — `kv` of the top-level scalar input fields, or `json` for nested.
- **Result** — driven by `classifyResult`:
  - `image` → `<img>` (responsive max-width, lazy load), with `meta` line (path · size · dimensions when known).
  - `terminal` → dark `<pre>` with stdout, distinct color for stderr, footer `↳ exited <code> · <duration>`.
  - `markdown` → ReactMarkdown (reuse the existing `MD_COMPONENTS` from `chat.tsx`, lifted to a shared file).
  - `kv` → two-column key/value grid; long URLs become links.
  - `error` → red bordered box with the message.
  - `empty` → omit the Result section entirely.
  - `json` → existing pretty-printed `<pre>`.
- Each section gets a small **Copy** button (clipboard).
- Smooth expand/collapse and the running → done check-pop animation already in the file are preserved.

### Mobile — `renderer-remote/chat.tsx ToolCard`

Identical renderers to desktop. Differences:

- Smaller icon (22px vs 26px), tighter padding (8px vs 12px), 12px header text.
- The summary line is allowed to wrap once (`line-clamp-1` → `line-clamp-2`) since horizontal space is at a premium.
- For `image` results: the existing `screenshot-captured` channel keeps producing `ScreenshotItem`s as separate transcript items (out of scope to change). For *MCP* screenshots that arrive as base64 in the tool result, the new `image` renderer handles them inline. (So mobile gets inline images for MCP screenshot tools — a net win — while built-in screenshots keep their current separate-bubble UX.)
- Tap target on the header ≥ 44px tall.

### Overlay — `OverlayApp.tsx`

Already does the right shape; just switch to the shared module:

- `stripToolPrefix` → `describeTool(name).label` (drops the bundled `mcp__otto-tools__` prefix and handles arbitrary MCP servers).
- Render `group` as a small uppercase tag before the label when present.
- `toolDetail()` → `summarizeInput(name, input)`.
- Add the icon glyph (14px) in front of each row, consistent with the other surfaces.

No new event types, no expanded state — overlay stays a glance-and-go ticker.

## Data Flow

No changes to transport. The new shared module is purely a presentation layer over the existing `tool-call-start` / `tool-call-result` events.

```
agent → bridge → renderer/renderer-remote
                    │
                    ▼
            describeTool(name)           ──┐
            summarizeInput(name, input)    ├── render
            classifyResult(name, result) ──┘
```

## Testing

Two layers:

1. **Pure unit tests** for `tool-presenters.ts` — table-driven:
   - `describeTool` for ~12 representative names (built-ins, MCP github, MCP otto-tools, MCP chrome-devtools, unknown).
   - `summarizeInput` for each summarizer.
   - `classifyResult` for each kind, including a base64 string, an SDK image content block, a shell result, an error, an empty result.
2. **Component tests** alongside existing `ToolCallCard.test.tsx`:
   - Renders humanized group + label in collapsed header.
   - Renders summary line in collapsed header.
   - Image result renders `<img>` with `data:image/...` src.
   - Terminal result renders stdout and exit code.
   - Error result renders red box.
   - JSON fallback still works.

Mobile and overlay tests follow the same patterns where they already have coverage.

## Existing Code Improvements (in-scope, focused)

While we're in these files:

- Lift `MD_COMPONENTS` from `chat.tsx` to `src/renderer-shared/markdown.tsx` (or duplicate to renderer + renderer-remote if a true shared file is awkward), so desktop's new markdown renderer doesn't fork.
- Replace the existing `screenshot` `file://` special-case in `ToolCallCard.tsx` with the new `classifyResult` `image` path.

Not in scope: refactoring transcript replay, changing event names, restyling other components.

## File Plan

| File                                                | Change                                          |
|---                                                  |---                                              |
| `src/shared/tool-presenters.ts`                     | **new** — semantics module                       |
| `src/shared/tool-presenters.test.ts`                | **new** — table-driven unit tests                |
| `src/renderer-shared/tool-icon.tsx` (or per-surface)| **new** — `IconName` → Lucide component map     |
| `src/renderer/components/ToolCallCard.tsx`          | rewrite body using `classifyResult`             |
| `src/renderer/components/ToolCallCard.test.tsx`     | extend                                           |
| `src/renderer-remote/chat.tsx`                      | rewrite inner `ToolCard` using shared module    |
| `src/renderer/OverlayApp.tsx`                       | switch to `describeTool` / `summarizeInput`     |
| `package.json`                                      | add `lucide-react` to desktop bundle if missing |
