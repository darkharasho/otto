# UI Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish Otto's existing chat-app UI so it feels crafted and modern, keeping the same layout, the near-black/violet DNA, and Plus Jakarta Sans.

**Architecture:** Refine-in-place. First centralize new style values (Tailwind tokens + a few `index.css` component helpers), then apply them per existing component. No new components, no layout changes, no font change. The title bar is the one surface that goes *flatter* (no wash, no halo, ghost controls); every other surface gains subtle depth.

**Tech Stack:** React 18 + TypeScript, Tailwind CSS, Vitest + Testing Library, electron-vite. Spec: `docs/superpowers/specs/2026-06-03-ui-refresh-design.md`.

---

## Important notes for the implementer

- **This is a styling refresh.** Pure CSS/className changes don't support meaningful TDD, so most tasks use the **existing component test suite as a regression guard** plus **visual verification by running the app** — not new failing tests. Where a task changes structure a test asserts on, the step says exactly which assertion to update.
- **Do not change the font.** Plus Jakarta Sans stays everywhere; JetBrains Mono only for existing monospace bits. This is a hard user constraint.
- **Preserve semantic mode colors.** The autonomy mode encodes meaning by color today: `strict` = red/danger, `balanced` = amber, `full-allow` = emerald/green. Keep those hues; only refine the *shape* of the badge/pill. Do NOT recolor mode indicators violet.
- **Commands** (respect the repo's 2-fork vitest cap):
  - Typecheck: `pnpm typecheck`
  - Lint: `pnpm lint`
  - Test one file: `pnpm exec vitest run <path> --pool=forks --poolOptions.forks.maxForks=2`
  - Run the app to verify visually: `pnpm dev`

## File structure / what each task touches

| Task | Files | Responsibility |
|------|-------|----------------|
| 1 | `tailwind.config.ts`, `src/renderer/index.css` | Shared tokens + helper classes (single source of truth) |
| 2 | `src/renderer/components/CommandBar.tsx` | Command bar elevation, send chip, mark halo, states |
| 3 | `src/renderer/components/Message.tsx`, `index.css` (`.md`) | User bubble, Otto label halo, body type |
| 4 | `src/renderer/components/ToolCallCard.tsx` | Elevated card, gradient icon tile, status pill |
| 5 | `src/renderer/components/ApprovalCard.tsx` | Action-class tag pill, gradient Approve, inset cmd |
| 6 | `src/renderer/components/ConversationSidebar.tsx` | Light alignment (search/new already exist) |
| 7 | `src/renderer/components/ModeBadge.tsx`, `StatusFooter.tsx` | Refined pills, semantic mode colors kept |
| 8 | `src/renderer/components/settings/SettingsShell.tsx` | Tab pills + subnav active bar |
| 9 | `src/renderer/components/SettingsControls.tsx` | Toggle gradient + RadioGroup active depth |
| 10 | `src/renderer/components/ChatTitlebar.tsx` | FLAT GHOST title bar |
| 11 | `src/renderer-remote/*` | Mirror treatments (secondary) |

---

## Task 1: Style foundation (tokens + helpers)

**Files:**
- Modify: `tailwind.config.ts`
- Modify: `src/renderer/index.css`

- [ ] **Step 1: Add the gradient-partner accent token**

In `tailwind.config.ts`, extend `theme.extend.colors` (keep all existing keys), adding one new color:

```ts
colors: {
  bg: '#0d0d0e',
  surface: '#17181a',
  border: '#2a2b2e',
  text: '#e9eaec',
  muted: '#8b8d92',
  accent: '#7c7dff',
  accent2: '#6e6fff',
  danger: '#ef4444',
},
```

- [ ] **Step 2: Add reusable component helpers to `index.css`**

Append these classes to `src/renderer/index.css` (after the existing `.otto-scrollbar` block). They centralize the polish so it's tunable in one place:

```css
/* ===== UI refresh helpers ===== */
/* Elevated surface: subtle gradient + inner top-highlight + soft shadow. */
.otto-elevated {
  background: linear-gradient(180deg, #1a1b1f, #161619);
  border: 1px solid #292a30;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04), 0 14px 30px -16px rgba(0, 0, 0, 0.7);
}
/* Violet gradient action button (send / primary). */
.otto-send {
  background: linear-gradient(135deg, #8889ff, #6e6fff);
  box-shadow: 0 3px 10px rgba(110, 111, 255, 0.45);
  color: #fff;
}
/* Soft accent pill (status / mode chips). */
.otto-accent-pill {
  background: rgba(124, 125, 255, 0.12);
  border: 1px solid rgba(124, 125, 255, 0.30);
  color: #cdcdff;
}
/* Radial violet halo placed behind the Otto mark on anchor surfaces. */
.otto-mark-halo { position: relative; display: inline-flex; align-items: center; }
.otto-mark-halo::after {
  content: ''; position: absolute; inset: -6px; border-radius: 9999px;
  background: radial-gradient(circle, rgba(124, 125, 255, 0.22), transparent 70%);
  pointer-events: none;
}
```

- [ ] **Step 3: Verify build + types**

Run: `pnpm typecheck`
Expected: PASS (no type errors).

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tailwind.config.ts src/renderer/index.css
git commit -m "feat(ui): add refresh style tokens and helper classes"
```

---

## Task 2: Command bar

**Files:**
- Modify: `src/renderer/components/CommandBar.tsx`
- Test: `src/renderer/components/CommandBar.test.tsx` (regression guard)

- [ ] **Step 1: Run the existing test first (baseline green)**

Run: `pnpm exec vitest run src/renderer/components/CommandBar.test.tsx --pool=forks --poolOptions.forks.maxForks=2`
Expected: PASS. If anything fails before you start, stop and investigate.

- [ ] **Step 2: Elevate the form surface**

In `CommandBar.tsx`, the root `<form>` className array (around lines 186–194), change the non-busy/non-private base from `'bg-surface border-border'` to use the elevated helper and 14px radius. Replace `rounded-2xl border shadow-2xl` with `rounded-[14px]`, and in the state branch replace the idle string:

```tsx
className={[
  'relative flex items-center gap-3 px-4 py-3 rounded-[14px] transition-colors',
  isPrivate ? 'focus-within:border-[#7c7dff]/70' : 'focus-within:border-accent/70',
  busy
    ? 'otto-elevated border-accent/60 ring-1 ring-accent/40'
    : isPrivate
      ? 'otto-elevated border-[#7c7dff]/60 ring-1 ring-[#7c7dff]/30'
      : 'otto-elevated',
].join(' ')}
```

(The `otto-elevated` helper supplies background/border/shadow; the per-state classes layer the accent border/ring on top.)

- [ ] **Step 3: Add the mark halo (idle only)**

Wrap the existing `<OttoMark>` span (around lines 197–211). Add `otto-mark-halo` to the wrapping `<span>` className only when not busy and not private (keep the existing `otto-halo` welcome behavior as-is — that is a separate effect). Concretely, append `otto-mark-halo` to the class list in the non-busy, non-private, non-welcome case:

```tsx
className={[
  'relative flex items-center justify-center w-5 h-5 shrink-0',
  busy ? 'text-accent animate-pulse'
       : isPrivate ? 'text-[#7c7dff]'
       : welcome ? 'text-accent'
       : 'text-muted otto-mark-halo',
].join(' ')}
```

- [ ] **Step 4: Make the send button a gradient chip**

In the submit-button branch (around lines 333–343), replace `bg-accent/90 hover:bg-accent text-white shadow` with the helper:

```tsx
className="otto-send flex items-center justify-center w-6 h-6 rounded-md hover:brightness-110 transition"
```

- [ ] **Step 5: Run the test to confirm no regression**

Run: `pnpm exec vitest run src/renderer/components/CommandBar.test.tsx --pool=forks --poolOptions.forks.maxForks=2`
Expected: PASS. If a class-string assertion fails, update it in the test to match the new class (behavior is unchanged).

- [ ] **Step 6: Visual verify**

Run: `pnpm dev`. Confirm idle / typing (send chip) / working (shimmer + ring) / private (lock) / attachment states all look right.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/CommandBar.tsx src/renderer/components/CommandBar.test.tsx
git commit -m "feat(ui): refine command bar — elevation, send chip, mark halo"
```

---

## Task 3: Chat messages

**Files:**
- Modify: `src/renderer/components/Message.tsx`
- Modify: `src/renderer/index.css` (`.md` body leading)
- Test: `src/renderer/components/Message.test.tsx` (regression guard)

- [ ] **Step 1: Baseline test green**

Run: `pnpm exec vitest run src/renderer/components/Message.test.tsx --pool=forks --poolOptions.forks.maxForks=2`
Expected: PASS.

- [ ] **Step 2: Refine the user bubble**

In `Message.tsx`, the user branch (around line 130), replace the bubble className:

```tsx
<div className="max-w-[80%] rounded-2xl rounded-br-md px-4 py-2 text-sm text-text
  bg-gradient-to-b from-accent/[0.18] to-accent/[0.12] border border-accent/30
  shadow-[0_2px_10px_-4px_rgba(110,111,255,0.35)]">
```

- [ ] **Step 3: Add halo to the "Otto" label mark**

In the assistant branch (around lines 162–165), wrap the mark with the halo helper:

```tsx
<div className="flex items-center gap-1.5 mb-1 text-xs font-medium text-muted">
  <span className="otto-mark-halo"><OttoMark className="w-3.5 h-3.5 text-accent" /></span>
  <span>Otto</span>
</div>
```

- [ ] **Step 4: Calm the body leading**

In `index.css`, the `.md p` rule already sets margins. Add one line to the `MarkdownBlock` wrapper: change `className="md text-sm leading-relaxed"` (Message.tsx line ~84) to `className="md text-sm leading-[1.6]"`.

- [ ] **Step 5: Test + visual**

Run: `pnpm exec vitest run src/renderer/components/Message.test.tsx --pool=forks --poolOptions.forks.maxForks=2`
Expected: PASS (update any bubble class-string assertion if present).
Then `pnpm dev`: confirm a user message + an Otto reply read well.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/Message.tsx src/renderer/index.css src/renderer/components/Message.test.tsx
git commit -m "feat(ui): refine chat bubbles and Otto label"
```

---

## Task 4: Tool cards

**Files:**
- Modify: `src/renderer/components/ToolCallCard.tsx`
- Test: `src/renderer/components/ToolCallCard.test.tsx` (regression guard)

- [ ] **Step 1: Baseline test green**

Run: `pnpm exec vitest run src/renderer/components/ToolCallCard.test.tsx --pool=forks --poolOptions.forks.maxForks=2`
Expected: PASS.

- [ ] **Step 2: Elevate the card shell**

In `ToolCallCard.tsx` (around line 56), replace `rounded-lg border border-border bg-bg/40` with `rounded-[10px] otto-elevated`.

- [ ] **Step 3: Gradient icon tile**

In the icon span (around line 64), replace `bg-accent/10 text-accent` with:

```tsx
className="w-6 h-6 rounded-md bg-gradient-to-br from-accent/30 to-accent2/20 text-[#b9b9ff] flex items-center justify-center flex-shrink-0"
```

- [ ] **Step 4: Status becomes a pill**

The status block (around lines 79–81) currently renders `<StatusGlyph>` + uppercase text inline. Wrap the glyph + label in a pill whose color follows status. Replace:

```tsx
<span className="flex items-center gap-2 flex-shrink-0">
  <span className={[
    'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide',
    status === 'error'
      ? 'bg-danger/15 text-danger border border-danger/30'
      : status === 'running'
        ? 'bg-white/[0.04] text-muted border border-border'
        : 'otto-accent-pill',
  ].join(' ')}>
    <StatusGlyph status={status} justFinished={justFinished} />
    {status}
  </span>
  <svg /* chevron unchanged */ />
</span>
```

Keep the existing chevron `<svg>` exactly as-is after the pill.

- [ ] **Step 5: Test + visual**

Run: `pnpm exec vitest run src/renderer/components/ToolCallCard.test.tsx --pool=forks --poolOptions.forks.maxForks=2`
Expected: PASS (update any class assertion on the status text/container).
Then `pnpm dev`: trigger a tool call; confirm running → done pill transition and an errored card.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/ToolCallCard.tsx src/renderer/components/ToolCallCard.test.tsx
git commit -m "feat(ui): refine tool cards — elevation, gradient icon, status pill"
```

---

## Task 5: Approval card

**Files:**
- Modify: `src/renderer/components/ApprovalCard.tsx`

**Note:** this card has THREE actions — Approve / Approve for session / Deny — and an `actionClass` (read/reversible/destructive/irreversible). Keep all three buttons.

- [ ] **Step 1: Color the action-class tag by severity**

Add a helper above the return (after `const decided = …`):

```tsx
const tagClass: Record<string, string> = {
  read: 'bg-white/[0.05] text-muted border border-border',
  reversible: 'bg-amber-500/15 text-amber-300 border border-amber-500/40',
  destructive: 'bg-danger/15 text-danger border border-danger/40',
  irreversible: 'bg-danger/20 text-danger border border-danger/50',
};
const tag = tagClass[block.actionClass] ?? tagClass.read;
```

- [ ] **Step 2: Elevate the card + restyle the tag**

Replace the root `<div>` (line 28) with `className="my-2 rounded-[11px] border border-accent/40 bg-gradient-to-b from-accent/[0.08] to-accent/[0.02] p-3 text-sm shadow-[0_0_24px_-8px_rgba(124,125,255,0.4)]"`.

In the header (lines 31–34), replace the `actionClass` span with the pill:

```tsx
<span className={`ml-2 inline-block text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-md ${tag}`}>
  {block.actionClass}
</span>
```

- [ ] **Step 3: Primary gradient Approve, quiet others**

Replace the three button classNames (keep `onClick`, `disabled`, labels):

```tsx
// Approve
className="otto-send px-3 py-1 text-xs rounded-md hover:brightness-110 disabled:opacity-50"
// Approve for session
className="px-3 py-1 text-xs rounded-md border border-accent/60 text-accent hover:bg-accent/10 disabled:opacity-50"
// Deny
className="px-3 py-1 text-xs rounded-md border border-border text-muted hover:text-danger hover:border-danger/50 disabled:opacity-50"
```

(Note: `otto-send` sets `color:#fff`; remove the old `text-bg`.)

- [ ] **Step 4: Verify**

Run: `pnpm typecheck` → PASS. `pnpm lint` → PASS.
Then `pnpm dev`: trigger an approval (e.g. a reversible shell command in balanced mode); confirm tag color, gradient Approve, and the decided state still render.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/ApprovalCard.tsx
git commit -m "feat(ui): refine approval card — severity tag, gradient approve"
```

---

## Task 6: Conversation sidebar (light alignment)

**Files:**
- Modify: `src/renderer/components/ConversationSidebarItem.tsx`

**Note:** the sidebar already has a search field, a gradient "New conversation" button, and a strong active-row treatment. Do NOT add those. Only align values to the system and add an errored-dot glow.

- [ ] **Step 1: Add a soft glow to the errored status dot**

In `ConversationSidebarItem.tsx`, the running/errored dot (around lines 49–54) already glows for `running`. Confirm the `errored` case keeps `boxShadow: '0 0 6px #e25555'` (it does). No change needed if present; if missing, add it. This step is a verification, not a rewrite.

- [ ] **Step 2: Verify nothing regressed**

Run: `pnpm typecheck` → PASS. `pnpm lint` → PASS.
`pnpm dev`: confirm active row, running pulse, errored glow, hover state.

- [ ] **Step 3: Commit (only if a change was made)**

```bash
git add src/renderer/components/ConversationSidebarItem.tsx
git commit -m "chore(ui): align sidebar item status glow with refresh"
```

If no change was needed, skip the commit and note it in the task tracker.

---

## Task 7: Mode badge + status footer

**Files:**
- Modify: `src/renderer/components/ModeBadge.tsx`
- Modify: `src/renderer/components/StatusFooter.tsx`
- Test: `src/renderer/components/ModeBadge.test.tsx` (regression guard)

**Keep semantic mode colors** (strict=danger, balanced=amber, full-allow=emerald). Refine the pill shape only.

- [ ] **Step 1: Baseline test green**

Run: `pnpm exec vitest run src/renderer/components/ModeBadge.test.tsx --pool=forks --poolOptions.forks.maxForks=2`
Expected: PASS.

- [ ] **Step 2: Refine the badge trigger to a rounded pill**

In `ModeBadge.tsx`, the trigger button (lines 42–46): change `rounded border border-border bg-bg/60` to `rounded-full border border-border bg-white/[0.04]` and keep the colored dot + label. The dot color (`DOT_BY_MODE`) is unchanged — this preserves the semantic hue.

- [ ] **Step 3: Refine the footer model badge**

In `StatusFooter.tsx`, the model badge span (line 24): change `rounded bg-bg/60 border border-border` to `rounded-md bg-white/[0.04] border border-border`. Leave the private lock pill (already accent-styled) and `ModeBadge` as-is.

- [ ] **Step 4: Test + visual**

Run: `pnpm exec vitest run src/renderer/components/ModeBadge.test.tsx --pool=forks --poolOptions.forks.maxForks=2`
Expected: PASS (update class assertions if present).
`pnpm dev`: confirm the footer reads cleanly and the mode dropdown still opens/sets mode.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/ModeBadge.tsx src/renderer/components/StatusFooter.tsx src/renderer/components/ModeBadge.test.tsx
git commit -m "feat(ui): refine mode badge and footer pills"
```

---

## Task 8: Settings shell (tabs + subnav)

**Files:**
- Modify: `src/renderer/components/settings/SettingsShell.tsx`
- Test: `src/renderer/components/settings/SettingsShell.test.tsx` (regression guard)

- [ ] **Step 1: Baseline test green**

Run: `pnpm exec vitest run src/renderer/components/settings/SettingsShell.test.tsx --pool=forks --poolOptions.forks.maxForks=2`
Expected: PASS.

- [ ] **Step 2: Replace heavy solid-accent active tab with an accent-soft pill**

In `SettingsShell.tsx`, the tab button className (lines 33–35): replace the selected branch `bg-accent text-white` with `otto-accent-pill` and add an inset ring; keep inactive as ghost:

```tsx
className={`px-3 py-1 text-[13px] font-medium rounded-md ${
  selected
    ? 'otto-accent-pill shadow-[inset_0_0_0_1px_rgba(124,125,255,0.3)]'
    : 'bg-transparent text-muted hover:text-text'
}`}
```

- [ ] **Step 3: Give the subnav active item an accent left-bar**

In the subnav button (lines 53–55), replace the current branch with a left-bar treatment consistent with the conversation sidebar:

```tsx
className={`relative block w-full text-left px-4 py-1.5 text-[13px] ${
  current
    ? 'text-text font-medium bg-gradient-to-r from-accent/[0.14] to-transparent'
    : 'text-muted hover:text-text hover:bg-bg/40'
}`}
```

And inside the button, before `{s.label}`, add the bar (only when current):

```tsx
{current && <span className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent" />}
{s.label}
```

- [ ] **Step 4: Test + visual**

Run: `pnpm exec vitest run src/renderer/components/settings/SettingsShell.test.tsx --pool=forks --poolOptions.forks.maxForks=2`
Expected: PASS (update active-tab class assertions if present).
`pnpm dev` → open Settings: confirm tab + subnav active states.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/settings/SettingsShell.tsx src/renderer/components/settings/SettingsShell.test.tsx
git commit -m "feat(ui): refine settings tabs and subnav"
```

---

## Task 9: Settings controls (shared primitives)

**Files:**
- Modify: `src/renderer/components/SettingsControls.tsx`

These primitives (`Toggle`, `RadioGroup`) are reused across every settings section, so restyling them here propagates everywhere (including the Autonomy `RadioGroup`).

- [ ] **Step 1: Gradient-on toggle**

In `SettingsControls.tsx`, the `Toggle` track (lines 56–61): replace the checked branch `bg-accent border-accent` with the gradient + glow:

```tsx
checked
  ? 'border-accent shadow-[0_2px_8px_-2px_rgba(110,111,255,0.6)] [background:linear-gradient(135deg,#8889ff,#6e6fff)]'
  : 'bg-bg/60 border-border hover:border-accent/60',
```

- [ ] **Step 2: Add subtle depth to the active RadioGroup option**

In `RadioGroup` (lines 97–100), replace the active branch `bg-accent/10 text-text` with:

```tsx
active
  ? 'bg-gradient-to-r from-accent/[0.14] to-accent/[0.04] text-text shadow-[inset_0_0_14px_rgba(124,125,255,0.08)]'
  : 'text-text hover:bg-bg/60',
```

Keep the existing left-bar `<span>` (lines 102–104) as-is.

- [ ] **Step 3: Verify**

Run: `pnpm typecheck` → PASS. `pnpm lint` → PASS.
Run all settings tests: `pnpm exec vitest run src/renderer/components/settings --pool=forks --poolOptions.forks.maxForks=2` → PASS (update class assertions if any).
`pnpm dev` → toggle a switch and pick an autonomy mode; confirm the on-gradient and active option depth.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/SettingsControls.tsx
git commit -m "feat(ui): refine settings toggle and radio controls"
```

---

## Task 10: Title bar — FLAT GHOST

**Files:**
- Modify: `src/renderer/components/ChatTitlebar.tsx`

This is the one surface that goes flatter, not deeper: no violet wash, no halo, ghost window controls.

- [ ] **Step 1: Flatten the bar background**

In `ChatTitlebar.tsx`, the root `<div>` style (lines 50–53): replace the gradient `background` with a flat surface and keep the hairline border:

```tsx
style={{
  background: '#0e0e10',
  borderBottom: '1px solid rgba(255,255,255,0.05)',
}}
```

- [ ] **Step 2: Ghost the window control buttons**

Both window buttons (minimize lines 107–115, maximize 116–128) currently have a raised `style={{ background:'#15161a', border:'1px solid #2a2b2e' }}`. Remove that inline `style` from both and change their className to ghost:

```tsx
className="w-[26px] h-[26px] rounded-[7px] flex items-center justify-center text-[#9598a0] transition-colors hover:text-white hover:bg-white/[0.06]"
```

- [ ] **Step 3: Leave mark, title, LIVE/PRIVATE pills, hints as-is**

Do not add a halo here. The mark stays `text-[#7c7dff]` with no wrapper. Keep the LIVE/PRIVATE pills and keyboard hints exactly as they are.

- [ ] **Step 4: Verify**

Run: `pnpm typecheck` → PASS. `pnpm lint` → PASS.
`pnpm dev`: confirm the flat bar, hover-only window buttons, and that LIVE/PRIVATE pills still appear.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/ChatTitlebar.tsx
git commit -m "feat(ui): flatten title bar — ghost controls, no wash"
```

---

## Task 11: Remote / PWA mirror (secondary)

**Files:**
- Modify: `src/renderer-remote/chat.tsx`, `src/renderer-remote/approval-card.tsx`, `src/renderer-remote/tool-result-renderer.tsx`, `src/renderer-remote/index.css` (as applicable)

The remote UI mirrors several desktop components. Apply the equivalent treatments for consistency. This is lower priority — desktop must land first and can ship independently.

- [ ] **Step 1: Add the same helper classes to the remote stylesheet**

Copy the `.otto-elevated`, `.otto-send`, `.otto-accent-pill`, `.otto-mark-halo` blocks from Task 1 into `src/renderer-remote/index.css` (the remote bundle has its own CSS entry).

- [ ] **Step 2: Apply elevation + send chip + status pill in the remote chat/approval/tool components**

Mirror Tasks 2/4/5 className changes in `src/renderer-remote/chat.tsx`, `approval-card.tsx`, and `tool-result-renderer.tsx`. Keep the remote layout unchanged.

- [ ] **Step 3: Verify**

Run: `pnpm typecheck` → PASS. `pnpm lint` → PASS.
Run the PWA build if practical: `pnpm build:pwa` → succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/renderer-remote
git commit -m "feat(ui): mirror refresh treatments in remote UI"
```

---

## Final verification

- [ ] **Run the full test suite:** `pnpm test` → all PASS (the repo caps vitest at 2 forks).
- [ ] **Typecheck + lint clean:** `pnpm typecheck && pnpm lint`.
- [ ] **Visual sweep in `pnpm dev`:** command bar (idle/working/queued/private/attachment), a chat exchange, running→done→errored tool cards, an approval prompt (reversible + destructive tags), the sidebar (active/running/errored), each settings section (tabs, subnav, toggle, radio), and the flat title bar.
- [ ] **Confirm the font is unchanged** — Plus Jakarta Sans everywhere; mono only where it already was.
