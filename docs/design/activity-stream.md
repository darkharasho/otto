# Activity Stream — design spec

Status: locked 2026-09-14 · Mocks: three SAI renders ("activity stream mock (live)",
"activity card states (spec sheet)", "everything settled (end of session)") produced in the
2026-09-14 design session.

The polish pass for tool-call visibility. Today every tool call renders as a collapsed
`ToolCallCard` row (icon · label · status pill · chevron); all evidence is hidden until the user
clicks. This spec flips the default: **a tool call is open and legible while it runs, closes with
a takeaway, and settles into a one-line receipt**. Same DNA throughout — Plus Jakarta Sans,
near-black `#0d0d0e`, violet `#7c7dff`, the `otto-elevated` surface. No new visual language.

## Principles

1. **Show the evidence, not the plumbing.** The user sees the terminal output, the screenshot,
   the chart — never raw JSON input unless they dig for it.
2. **Every finished card states a takeaway.** "exit 0" is a status; "indexer reading 212 MB/s
   during the hitch" is information. Done-cards get one plain-language line.
3. **Attention follows activity.** Running work is expanded and animated; finished work compacts.
   At any moment the answer to "what is Otto doing right now?" is one glance away (Now strip).
4. **Failures explain themselves.** An error card keeps its reason inline forever and says what
   Otto does next.
5. **Action class drives the chrome.** Reversible = violet, one-click approve. Destructive =
   amber, no one-click run. Irreversible = red, typed confirmation.

## Token additions

`tailwind.config.ts` → `theme.extend.colors`:

```ts
term: '#0a0a0c',   // terminal body, darker than bg so it reads as a screen
warn: '#f5a04b',   // destructive approvals, cautions
good: '#3cdc82',   // reversible badge, verdict accents (use sparingly; violet stays "done")
```

`index.css` helpers (join the existing `otto-*` family):

```css
.otto-hairline      /* 2px running-progress bar under a card header; shimmer sweep, violet */
.otto-receipt       /* one-line settled row: rgba(23,24,26,.5) bg, border rgba(42,43,46,.6), radius 8px */
.otto-live-tail     /* max-height 132px, flex-end justify, top fade mask for streaming stdout */
```

All animation honors `prefers-reduced-motion` (shimmer, caret, pings → static).

## Type scale (inside cards)

| Role | Size | Face |
|---|---|---|
| Card title | 12.5px / 600 | Jakarta |
| Group prefix ("Shell", "Screen") | 12.5px / 500, `text-muted` | Jakarta |
| Mono summary (command, path) | 11px | JetBrains Mono |
| Terminal body | 11px / 1.65 | JetBrains Mono |
| Footer / meta | 10.5px, `text-muted` | Jakarta (values in Mono) |
| Status pill | 9.5px / 600 uppercase | Jakarta |
| Timestamps | 10px, `#5f6167` | JetBrains Mono |

Radii: card 10px, receipt 8px, embedded media/terminal 7–8px. Card padding: header 9×12,
media inset 12px.

---

## 1. Card shell — `ToolCallCard.tsx` → lifecycle rework

Header anatomy (unchanged silhouette, richer content):

```
[icon chip 24px] [Group · Plain-language title]        [timestamp] [status pill]
                 [mono summary — command/path/target]
```

- Title is what Otto *did*, not the tool name: "Checked what's hitting the disk", not "Bash".
  Source: extend `describeTool()`/`summarizeInput()` in `shared/tool-presenters.ts` with a
  per-call `headline` (falls back to current label).
- Timestamp: wall-clock `HH:MM:SS` once done; ticking elapsed (`0:41`) while running.

**Lifecycle state machine** (replaces the single `open` boolean):

```
queued → running (EXPANDED, hairline shimmer, elapsed ticks)
       → done    (EXPANDED, takeaway footer)  --settle-->  receipt (one line)
       → error   (EXPANDED, reason inline)    --settle-->  receipt (reason kept inline)
```

- Settle trigger: the turn's assistant text completes OR 30 s after `done`, whichever first.
  Never mid-scroll-view (don't collapse under the cursor).
- Click a receipt → re-expands to the full card. `aria-expanded` as today.
- Low-signal tools (`Read`, `Glob`, `memory_*`, knowledge reads) skip the expanded phase and
  render as receipts immediately — keep list from `describeTool` groups, behind a
  `quiet: true` flag on the descriptor.
- Error receipts always keep the one-line reason ("✗ exit 1 · no matches").

**Receipt anatomy:**

```
[mini icon 16px] [Group] [mono summary] ......... [✓/✗] [takeaway or exit·time] [expand]
```

**Timeline spine:** consecutive tool blocks in `Message.tsx` (the `elements` array) are wrapped
in an activity group: 26px left rail, 1px vertical line (violet→border gradient), 7px dot per
card (violet = expanded card, `#3f4046` = receipt). Encodes "this was one investigation", which
is real sequence information.

## 2. Terminal — `tool-cards/TerminalCard.tsx`

Already has `command`, `stdout`, `stderr`, `exitCode`, `durationMs`, `streaming` + caret +
autoscroll. Deltas:

- Body background `term` (not `bg/80`), top border, `$` prompt line as today.
- **Running:** `otto-hairline` under the card header; live tail via `.otto-live-tail`
  (last ~8 lines, top fade); blinking caret (exists); footer left = "streaming", right = Stop
  button (wire to existing process-kill IPC used by `ProcessCard`).
- **Done:** footer row replaces the current `↳ exited 0` line:
  `exit N (mono, accent/danger) · duration · line count | takeaway | Copy output`.
  - Takeaway: one sentence, ≤ 90 chars. Provided by the agent alongside the result
    (SDK metadata) — renderer treats it as optional and hides the slot when absent.
- **Fold rule:** when stdout > 12 lines, keep the first line, fold the quiet middle behind a
  dashed `— N quiet lines hidden —` row (click to unfold), always keep highlighted + last 4
  lines. "Highlighted" = lines matched by the presenter's finding heuristics (e.g. the row that
  produced the takeaway); red-tint highlight `rgba(239,68,68,.09)` + `#ff8f8f` text.
- **Error:** stderr in `#ff8f8f`; below it a **Why row** (danger-tinted panel):
  *why it failed + what Otto does next*. Text comes from the agent's next reasoning step when
  available; falls back to stderr classification (`command not found → suggests package`).

## 3. Screen & computer use — `tool-cards/ImageCard.tsx`, `ClickCard`, `TypedCard`, `KeyCapsCard`

- **Capturing state:** placeholder panel (186–300px) with scan-sweep gradient, monitor icon,
  caption "Grabbing monitor 2 — nothing leaves this machine".
- **Done:** thumbnail (exists, keep zoom + right-click copy) plus:
  - Meta row: `Monitor N · WxH · size · kept 20 min` (retention comes from image-cache TTL —
    surface the real value, don't hardcode).
  - **Click reticle:** when a click follows a capture in the same turn, `Message.tsx` merges the
    `click` view into the preceding `image` view (`markers: [{x, y, label}]`). ImageCard renders
    a 24px ring + ping + `click · x, y` tag at scaled coordinates. ClickCard alone (no capture
    to anchor to) keeps its current row form.
  - **Action note:** violet-tinted row under the thumb: what the click did
    ("Clicked the indexer tray icon to check its status").
- **Typed/keys:** `TypedCard` text in a `term`-bg box; `KeyCapsCard` keycaps (11px mono, 6px
  radius, 2px bottom border) — both followed by the same action-note row.
- **Settled:** N captures in one step collapse to a film-strip receipt:
  `Screen · 3 captures · 1 click [thumb thumb thumb] ✓ review all` → expands to a gallery.

## 4. Observe — new `ResultView` kind

```ts
| { kind: 'observe'; label: string; unit: string; threshold?: number; startedAt: number;
    endedAt?: number; series: number[]; events: Array<{ t: number; text: string; level: 'info'|'alert' }>;
    verdict?: { ok: boolean; text: string } }
```

New `tool-cards/ObserveCard.tsx`:

- **Watching:** hairline shimmer; sparkline SVG (violet 1.4px stroke, violet→transparent area
  fill, dashed baseline at threshold, red 2.6px dots on alert points); below, up to 3 latest
  event rows (`HH:MM:SS · text`), older ones behind "N more · show all".
- **Done:** shimmer off; **verdict row** (violet-tinted): `✓ Resolved — …` or `✗ Still occurring
  — …`. A watch never just ends; it concludes.
- **Before/after:** when the watch brackets an applied fix, draw the fix moment as a dashed
  vertical line + faint fill on the after-region, `before / fix applied HH:MM` labels (9px mono).
- Long-running observes stay as cards when settled *if* they carry the verdict for the task;
  otherwise receipt: `Observe · frame times · 6m · ✓ 0 spikes`.

## 5. Approvals — `ApprovalCard.tsx`

Anatomy: header (shield chip · "Wants to <verb phrase>" · action-class badge) → exact command
in a `term` box → blast-radius note ("what changes, what doesn't, how to undo") → buttons.

Per action class (classes already exist on every tool):

| Class | Badge | Chrome | Primary action |
|---|---|---|---|
| reversible | `good` outline pill | violet border + 3px violet glow ring | **Approve & run** (violet gradient) + `⌘⏎` |
| destructive | `warn` pill | amber border + glow | **Review the N items** — approval gated behind seeing the list |
| irreversible | danger pill | red border | Approve requires typing a confirmation word |

Approved actions settle to a receipt with attribution: `✓ approved by you · 0.8s`.

## 6. Now strip — new `NowStrip.tsx` (chat window, above the command bar)

One-line answer to "what's happening right now". Sits between the message list and composer
(not in `StatusFooter`, which keeps model/session/mode).

- **Active:** violet-tinted pill row: pulsing dot · `2 running — watching frame times (4m 12s) ·
  inotifywait (0:41)` · `step 3 of 4` · **Pause all**. Names + elapsed come from the same
  process registry that feeds `ProcessCard`, plus in-flight tool calls.
- **Idle:** neutral border, gray dot, `All quiet — nothing running` · `session 14:02 – 14:14`.
- Clicking a named item scrolls to its card.

## 7. Plan checklist — `tool-cards/TasksCard.tsx`

Add per-row right-aligned completion timestamps (`14:03:12`, mono 10.5px) and `running · 4m 12s`
on the in-progress row. Tick styles: done = violet-filled ring ✓; in-progress = ring with
pulsing center dot; pending = gray ring, muted text.

## 8. Outcome card — new, end-of-task

Rendered when a task the user asked for concludes (agent emits a structured outcome; render only
when present — never synthesize in the renderer):

```
[medal chip] Title — one line, what got fixed
             12 minutes · 9 tool calls · 1 approval · nothing else changed
[Cause] [Fix (mono)] [Verified]          ← 3 fact tiles
[↩ Undo anytime: <command>        Copy]  ← only when the fix is reversible
[💡 Saved to machine notes: <quirk>]     ← only when knowledge file was updated
```

Violet-ring emphasis (same treatment as pending approval — the two "look at me" moments).
Data: `{ title, stats, facts: {cause, fix, verified}, undoCommand?, learnedNote? }` from the
main-process reflection/knowledge flow.

---

## Plumbing deltas (main process)

1. **Streamed stdout for running Bash:** `terminal` view already models `streaming`; emit
   incremental stdout over the existing partial-message IPC so running cards fill live
   (ProcessCard's channel is the model).
2. **Takeaway + Why rows:** carried as optional strings on the tool-result payload; agent-side
   prompt addition, renderer-side optional slots.
3. **Click→capture merge:** presenter-level join in `Message.tsx` block assembly (adjacent
   `image` + `click` blocks in one turn).
4. **Observe events:** observation tool emits `{series, events}` snapshots on an interval;
   throttle re-render to ≤ 1 fps.
5. **Outcome/learned payloads:** emitted by reflection + knowledge writer when they run.

## Implementation phases

- **P1 — renderer only, no protocol changes:** card-shell lifecycle (expand-while-running,
  settle-to-receipt, quiet tools), TerminalCard footer/fold/live-tail, ImageCard capturing state
  + meta, TasksCard timestamps, timeline spine, NowStrip (from existing process registry),
  approval action-class chrome. Tests ride `ToolCallCard.test.tsx` / `Message.test.tsx` patterns.
- **P2 — protocol:** streamed stdout, takeaway/why strings, click→capture markers.
- **P3 — new surfaces:** `observe` view kind + ObserveCard, outcome card, film-strip gallery.

Vitest note: run with `--maxWorkers=2` (machine-wide rule); never while packaging (ABI flip).
