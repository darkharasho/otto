# Beautiful Tool Card Bodies

## Problem

Tool cards currently classify results into a handful of `ResultView` kinds (`terminal`, `image`, `markdown`, `kv`, `error`, `json`) and render each as a flat block. The classification is good; the rendering is plain. A `shell_exec` result is a single dark `<pre>`. A `Read` result, a Glob, a Grep, a web search, a GitHub PR — all currently fall through to `kv` or `json`, producing a wall of generic key/value or raw JSON. The opportunity is to give each common shape a body that looks and reads like the thing it represents: a faux terminal for shells, a search-results list for `web_search`, a unified diff for `Edit`, a code preview for `Read`, a file tree for `Glob`, file-grouped matches for `Grep`, a browser-chrome snippet for `web_fetch`, a status-badged card for GitHub, a crosshair for `click`, keycaps for `key`/`type`, a cell preview for `NotebookEdit`, a checklist for `TodoWrite`/`TaskCreate`, and a collapsible tree for any other JSON.

## Goal

Replace `ToolResultRenderer`'s flat-per-kind render with a registry of kind-specific React components, and extend `classifyResult` with enough new `ResultView` variants to recognize the common SDK/MCP tools listed above. All polish lives **inside the card body**; the existing `ToolCallCard` header and chrome are unchanged.

## Non-Goals

- No changes to `ToolCallCard.tsx`'s header, status glyph, collapse animation, or the existing input-preview block.
- No changes to transport, event shape, or agent/SDK wiring.
- No new tools or capabilities — presentation only.
- No theming knobs — one canonical look per kind.
- Overlay (`OverlayApp.tsx`) stays a glance ticker; no new renderers there.

## Constraints (from brainstorm)

- **Header preserved.** All polish goes in the expanded body.
- **Syntax highlighting via Shiki.** Used by `code`, `diff`, and `notebook` kinds. Loaded lazily so the bundle cost only hits sessions that actually expand a code card.
- **JSON tree built in-house.** A small recursive component, no new dependency.
- **Live-tail streaming Bash/shell** is in scope for v1.
- **Click crosshair** is its own card. No overlay-on-prior-screenshot in v1.

## Architecture

### Shared module — extend `src/shared/tool-presenters.ts`

Add new `ResultView` variants. Each variant is a pure data shape; no JSX, no React.

```ts
export type ResultView =
  // existing
  | { kind: 'image';    src: string; alt?: string; meta?: string }
  | { kind: 'terminal'; stdout?: string; stderr?: string; exitCode?: number; durationMs?: number; streaming?: boolean }
  | { kind: 'markdown'; text: string }
  | { kind: 'kv';       entries: Array<[string, string]> }
  | { kind: 'error';    text: string; suggestion?: string }
  | { kind: 'empty' }
  // new
  | { kind: 'code';     path?: string; language?: string; text: string; startLine?: number; totalLines?: number; truncated?: boolean }
  | { kind: 'diff';     path: string; isNew?: boolean; hunks: Hunk[]; added: number; removed: number }
  | { kind: 'paths';    pattern?: string; matches: string[]; truncated?: boolean }
  | { kind: 'matches';  pattern: string; files: Array<{ path: string; line: number; snippet: string; matchStart?: number; matchEnd?: number }>; truncated?: boolean }
  | { kind: 'search';   query: string; results: Array<{ title: string; url: string; snippet?: string }> }
  | { kind: 'page';     url: string; title?: string; snippet?: string }
  | { kind: 'github';   repo: string; flavor: 'pr' | 'issue' | 'release' | 'commit'; number?: number | string; title?: string; state?: string; author?: string; stats?: { added: number; removed: number; files: number } }
  | { kind: 'click';    x: number; y: number; button?: string }
  | { kind: 'keypress'; keys: string[] }
  | { kind: 'typed';    text: string }
  | { kind: 'tasks';    items: Array<{ status: 'pending' | 'in_progress' | 'completed'; title: string }> }
  | { kind: 'notebook'; path: string; cellIndex?: number; cellType?: 'code' | 'markdown'; language?: string; text: string; op?: 'replace' | 'insert' | 'delete' }
  | { kind: 'tree';     value: unknown }   // collapsible JSON tree replaces the bare `json` fallback for non-trivial objects
  // unchanged terminal fallback
  | { kind: 'json';     value: unknown };

export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: Array<{ kind: 'add' | 'del' | 'ctx'; text: string }>;
}
```

### Classification — extend `classifyResult`

The function gains more recognizers. Order of checks (after the existing image/error/empty/markdown short-circuits):

1. **Edit / Write inputs that have surfaced as results.** SDK tools `Edit` and `Write` typically echo the file path. If `result` is a string starting with a known acknowledgement (`"File created"`, `"File written"`, `"The file ... has been updated"`) we look at the *input* (`old_string`/`new_string` for Edit; `content` for Write) to synthesize a `diff` view. Edit produces a single-hunk diff; Write produces an all-added diff with `isNew: true`.
2. **Read.** Tool name `Read` and result is a string with embedded line-number prefixes (`/^\s*\d+→/m`) — strip the prefixes and build `{ kind: 'code', path, language, text, startLine, totalLines }`. `path` and `startLine` come from input; `language` from extension.
3. **Glob.** Tool name `Glob`. Result is a newline-delimited path list. Build `{ kind: 'paths', pattern: input.pattern, matches }`. Cap at 200; set `truncated`.
4. **Grep.** Tool name `Grep`.
   - `output_mode: 'files_with_matches'` → `paths` view.
   - `output_mode: 'count'` → `kv` view.
   - default / `output_mode: 'content'` → parse `path:line:snippet` lines into `matches`; preserve the pattern.
5. **WebSearch.** Result is a string list of "1. Title (url) — snippet" entries or a JSON array. Parse into `search` view.
6. **WebFetch.** Markdown result → wrap into `page` view with `url` from input and a first-heading title heuristic.
7. **GitHub MCP.** Tools matching `mcp__*github*__(create|get|update)_(pull_request|issue|release)` produce JSON with `number`, `title`, `state`, `html_url`, `additions`, `deletions`, `changed_files`. Map into `github` view.
8. **Click / type / key.** Built-in Otto tools `click`, `double_click`, `move`, `type`, `key` — derive from *input*, not result, since the result is typically empty. (`classifyResult` gets access to the input via a new optional 3rd-arg fallback or via a small helper used by `ToolCallCard`.)
9. **Tasks.** Tools `TaskCreate`, `TaskUpdate`, `TodoWrite` — aggregate consecutive task ops in the same turn into one `tasks` view. (v1: render single-op as a single-item list; aggregation deferred to v2.)
10. **NotebookEdit.** Tool name `NotebookEdit` — build `notebook` view from input.
11. **Object fallback.** Replace the current `json` fallback for objects/arrays with `tree`. Strings, numbers, booleans still go to `json`.

The classifier remains conservative: if any required field is missing, fall through to the existing `json`/`kv`/`markdown` path.

### Renderer — `ToolResultRenderer.tsx` becomes a dispatcher

```tsx
const RENDERERS: Record<ResultView['kind'], React.FC<{ view: any; compact?: boolean }>> = {
  empty:    () => null,
  image:    ImageCard,
  terminal: TerminalCard,
  markdown: MarkdownCard,
  kv:       KvCard,
  error:    ErrorCard,
  json:     JsonScalarCard,
  code:     CodeCard,
  diff:     DiffCard,
  paths:    PathsCard,
  matches:  MatchesCard,
  search:   SearchCard,
  page:     PageCard,
  github:   GithubCard,
  click:    ClickCard,
  keypress: KeyCapsCard,
  typed:    TypedCard,
  tasks:    TasksCard,
  notebook: NotebookCard,
  tree:     JsonTreeCard,
};
```

Each card is its own file under `src/renderer-shared/tool-cards/`. The `compact` prop tightens padding and font sizes for mobile.

### Per-card design notes (body content only)

| Kind | Body content |
|---|---|
| `terminal` | Soft dark inner panel (no traffic lights — the outer card already has chrome). `$` prompt prefix on the first line of stdout. Stderr in danger color. Footer: `↳ exited <code> · <duration>`. While `streaming: true`, the panel auto-scrolls and shows a cursor block at the tail. |
| `image` | Existing renderer + lightbox on click. Meta line under (dimensions, size). |
| `code` | Filename strip across the top with basename bolded, language tag, line count. Body is Shiki-highlighted with gutter line numbers starting at `startLine`. "Showing N of M lines" footer when truncated. |
| `diff` | Filename strip with `+N −M` and an "EDIT" or "NEW" badge. Body is unified diff rows: `addBg`/`delBg` background, old/new line numbers in the gutter. Hunks separated by a `…` divider. Multi-hunk diffs collapse all but the first hunk by default. |
| `paths` | Pattern echoed at the top (`pattern: **/*.tsx`), match count badge. Body is a tree-grouped path list (shared longest prefix collapsed into a folder header). Cap at 50 visible; "Show all N" toggle. |
| `matches` | Pattern in slashes at the top, total match + file count. Body groups by file: file header, then each `Lnnn` row with the snippet, the matching range highlighted. Cap at 20 rows; expandable. |
| `search` | Query as a quoted header. Body is a vertical list: title (link), URL (muted, eTLD+1 colored), 2-line snippet. Favicons resolved via Google's `s2/favicons` service. Top 5 inline. |
| `page` | URL bar across the top with favicon. Body is `title` (bold) then snippet (~3 lines). Click URL → open in browser. |
| `github` | Repo header, flavor-tinted state pill (open=green, draft=gray, closed=red, merged=purple). Body: `#num · title`, author line, `+A −D · N files` when present. Footer: link to `html_url`. |
| `click` | Crosshair card: a small (200×120 in v1) panel with horizontal + vertical guide lines intersecting at `x, y`, normalized to the screen size if known. Label: `clicked at (x, y)`. |
| `keypress` | Body is rendered keycaps separated by `+`. Mac/Win glyph map (`Meta` → ⌘ on mac, ⊞ on win). |
| `typed` | Body is a single line in a soft mono pill: `"hello world"`. Char count after. |
| `tasks` | Checklist: glyph (`○` pending, spinner `●` in_progress, `✓` completed) + title per row. |
| `notebook` | Cell-style block: small `[N]: code · python3` strip on top, Shiki-highlighted body. Op badge (`replace` / `insert` / `delete`) on the right. |
| `tree` | Custom recursive component. Each object/array node is a row with `▾`/`▸` toggle, key, type summary (`{3}`, `[12]`, length for strings). Primitives inline with type-colored value. Click any value to copy. |
| `kv`/`markdown`/`error`/`json` | Existing renderers retained; `error` gains an optional inline `suggestion` line when the classifier recognizes a known error shape (out of scope to populate widely in v1 — placeholder only). |

### Shiki integration

- Import path: `shiki` ESM, theme `github-dark-dimmed` (matches Otto's terminal palette).
- Loaded lazily inside `CodeCard` / `DiffCard` / `NotebookCard` via a small `useShiki()` hook that resolves a singleton highlighter promise. While loading, render the plain mono text — no flash, no skeleton.
- Languages registered on demand: derive from filename extension; default to `text` for unknown.

### Live tail for shell

`TerminalCard` accepts `streaming: true`. The session bridge already streams partial `tool-call-result` deltas — `classifyResult` will pass through partial `stdout`/`stderr` and set `streaming` when no `exitCode` is present yet. The card subscribes via the same render path (no new IPC); each re-render re-runs `classifyResult` on the latest accumulated result and the panel scrolls to bottom. The footer shows `↳ running… <elapsed>` until done.

This requires confirming the SDK client emits deltas for shell tools. If it currently emits only on completion, v1 falls back to "spinner + final dump" with the streaming UI shipped behind a flag; turning it on is a separate small task in the plan.

## Per-Surface Components

### Desktop — `src/renderer/components/ToolCallCard.tsx`

Unchanged. Continues to use `ToolResultRenderer`. The new card files live under `src/renderer-shared/tool-cards/`.

### Mobile — `src/renderer-remote/chat.tsx`

`ToolCard` switches to the same dispatcher, passing `compact={true}`. The card files handle `compact` by reducing padding (8 → 6), font sizes (-1px), and clamping the number of inline items (`search` shows top 3 instead of 5).

### Overlay — `src/renderer/OverlayApp.tsx`

No changes. Already uses `summarizeInput` for the one-line description; results aren't shown.

## Data Flow

```
tool result event
        ▼
classifyResult(name, result, isError, input?)  → ResultView
        ▼
ToolResultRenderer                              → RENDERERS[view.kind]
        ▼
{Kind}Card                                      → body content only
```

`ToolCallCard` continues to wrap the body in the existing header/chrome/collapse.

## File Plan

| File | Change |
|---|---|
| `src/shared/tool-presenters.ts` | Extend `ResultView`, extend `classifyResult` (new recognizers, accept optional input arg). |
| `src/shared/tool-presenters.test.ts` | Add table-driven cases for every new variant. |
| `src/renderer-shared/tool-cards/index.tsx` | New — exports the renderer map. |
| `src/renderer-shared/tool-cards/TerminalCard.tsx` | New — replaces inline terminal branch. |
| `src/renderer-shared/tool-cards/ImageCard.tsx` | New — extracted from current inline branch + lightbox. |
| `src/renderer-shared/tool-cards/MarkdownCard.tsx` | New — extracted; reused. |
| `src/renderer-shared/tool-cards/KvCard.tsx` | New — extracted. |
| `src/renderer-shared/tool-cards/ErrorCard.tsx` | New — extracted; accepts optional `suggestion`. |
| `src/renderer-shared/tool-cards/CodeCard.tsx` | New. |
| `src/renderer-shared/tool-cards/DiffCard.tsx` | New. |
| `src/renderer-shared/tool-cards/PathsCard.tsx` | New. |
| `src/renderer-shared/tool-cards/MatchesCard.tsx` | New. |
| `src/renderer-shared/tool-cards/SearchCard.tsx` | New. |
| `src/renderer-shared/tool-cards/PageCard.tsx` | New. |
| `src/renderer-shared/tool-cards/GithubCard.tsx` | New. |
| `src/renderer-shared/tool-cards/ClickCard.tsx` | New. |
| `src/renderer-shared/tool-cards/KeyCapsCard.tsx` | New. |
| `src/renderer-shared/tool-cards/TypedCard.tsx` | New. |
| `src/renderer-shared/tool-cards/TasksCard.tsx` | New. |
| `src/renderer-shared/tool-cards/NotebookCard.tsx` | New. |
| `src/renderer-shared/tool-cards/JsonTreeCard.tsx` | New — recursive collapsible tree. |
| `src/renderer-shared/tool-cards/JsonScalarCard.tsx` | New — wraps `<pre>` for the leftover scalar/json fallback. |
| `src/renderer-shared/tool-cards/useShiki.ts` | New — lazy highlighter singleton. |
| `src/renderer/components/ToolResultRenderer.tsx` | Replace switch with dispatcher map. |
| `src/renderer/components/ToolResultRenderer.test.tsx` | Update to assert the dispatcher selects the right card. |
| `src/renderer/components/ToolCallCard.tsx` | Unchanged. |
| `src/renderer-remote/chat.tsx` | Inner `ToolCard` switches to the dispatcher with `compact`. |
| `package.json` | Add `shiki`. |

## Testing

1. **Unit (`tool-presenters.test.ts`)** — one or more cases per new variant: a representative Read string with line prefixes, an Edit input pair, a Glob newline list, a Grep `path:line:snippet` block, a WebSearch parse, a WebFetch markdown, a GitHub PR JSON, a click input, a key input, a tasks input, a NotebookEdit input, an object → `tree`.
2. **Component (`*Card.test.tsx`)** — one snapshot/light render test per card asserting the key body element (e.g. `DiffCard` renders both add and del rows; `SearchCard` renders N result rows; `JsonTreeCard` toggles expand on click).
3. **Dispatcher (`ToolResultRenderer.test.tsx`)** — every `kind` selects the corresponding card.
4. **No regression on existing cases** — terminal/image/markdown/kv/error all still render their bodies.

## Rollout

Single PR. No flags. The classifier is conservative (any unrecognized shape falls back to existing `json`/`kv`/`markdown`), so worst case is "same as today" for tools we didn't handle. Live-tail Bash ships if the SDK already emits deltas; otherwise the streaming UI is wired up but unused until a follow-up confirms delta emission.
