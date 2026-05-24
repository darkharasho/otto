# Settings Typography & Row Rhythm — Design

**Date:** 2026-05-23
**Status:** Draft for implementation

## Goal

Fix the inverted heading hierarchy and flat row rhythm in the redesigned settings window. Subsection titles should clearly outrank the field labels under them; each setting should read as its own row, not part of a paragraph.

## Non-goals

- New colors, fonts, or design tokens.
- Layout changes (top tabs + sidebar + content grid stay).
- New behavior — purely presentational.
- Snapshot tests.

## Section 1 — Type scale

| Element | Current | New |
|---|---|---|
| Subsection page header (top of content pane) | n/a (`Section` title duplicates sidebar) | `text-base font-semibold text-text` (16px / 600) |
| Subsection description (under page header) | `text-[11px] text-muted` | `text-xs text-muted` (12px) |
| Field label (Toggle / Radio option label) | `text-sm` (14px / 400) | `text-sm font-medium` (14px / 500) |
| Field description (under a field) | `text-[11px] text-muted` | `text-[11px] text-muted leading-snug` |
| Sidebar entry | `text-xs` (12px) | `text-[13px]`; active = `font-medium text-text`, idle = `text-muted` |
| Top tab | `text-xs` (12px) | `text-[13px] font-medium` |
| About row text / version string / etc. | `text-xs text-muted` | unchanged |

All four weights (400/500/600/700) ship in the existing Plus Jakarta Sans bundle — no new font load.

## Section 2 — `SubsectionPage` replaces `Section`

**New component** at `src/renderer/components/settings/SubsectionPage.tsx`:

```ts
interface Props {
  title: string;
  description?: string;
  children: ReactNode;
}
```

Renders, in order:

1. `<h2>` with `text-base font-semibold text-text` (the title).
2. If `description` provided: `<p>` with `text-xs text-muted mt-1`.
3. `<hr>` (or a `<div>` with `border-b border-border mt-3 mb-4`).
4. Children.

**Migration:** every per-section component (`ModelSection`, `WindowSection`, `ShortcutSection`, `StartupSection`, `AutonomySection`, `NotificationsSection`, `SessionHistorySection`, `AboutSection`) stops importing `Section` from `../SettingsControls` and instead wraps its body in `<SubsectionPage title="…" description="…">`. The title/description literals move from the old `Section title=` / `description=` props into `SubsectionPage`.

**`MemorySection`** gets a `<SubsectionPage>` wrapper too. Its title varies by `kind` prop:
- `'fact'` → "Facts"
- `'playbook'` → "Playbooks"
- `'anti_pattern'` → "Anti-patterns"
- `'heuristic'` → "Heuristics"

No description for any Memory subsection in v1.

**`UpdatesSection`** is a thin wrapper around `UpdaterSection`, which uses `Section` internally. Leave that alone — `UpdaterSection` is not in the per-section refactor scope. Its visual mismatch (an old-style `Section` heading) is acceptable for v1; a follow-up can swap its internal `Section` for `SubsectionPage` later.

**Cleanup:** after the migration, grep for remaining `Section` consumers in the renderer. If `Section` is now used only by `UpdaterSection.tsx`, leave the export in `SettingsControls.tsx` in place. If it has no consumers, delete the `Section` export in the same task.

## Section 3 — Row rhythm + control updates

Two changes inside `src/renderer/components/SettingsControls.tsx`.

### `Toggle`

- Outer label `py-1.5` → `py-3`.
- Label text span: add `font-medium` (already `text-sm`).
- Add a `divided?: boolean` prop (default `false`). When `true`, append `border-b border-border/40 last:border-b-0` to the container. Callers set `divided` only when 2+ toggles sit in a row.

### `RadioGroup`

- Each option's outer label: `py-1.5` → `py-2.5`.
- Each option's label text span: add `font-medium`.
- No `divided` prop — radio options already group visually via the indicator dot.

### `NumberField`

- No change.

### `SettingsShell` (`src/renderer/components/settings/SettingsShell.tsx`)

- Top tab button class: `text-xs` → `text-[13px] font-medium`.
- Sidebar entry button class: `text-xs` → `text-[13px]`. Active branch: `bg-accent/15 text-text font-medium` (already had font-medium — keep). Idle branch: `text-muted hover:text-text hover:bg-bg/40` (unchanged).

### `NotificationsSection`

Pass `divided` to each `Toggle` in the section (it's the only place with 3 stacked toggles).

`WindowSection` has only one toggle (hideOnBlur) — don't add `divided` there.

## Section 4 — Testing

- **New:** `src/renderer/components/settings/SubsectionPage.test.tsx` — three assertions:
  1. Always renders the title text.
  2. Renders the description text when `description` provided.
  3. Does NOT render a description paragraph when `description` is undefined.
  4. Renders children below the header.
- **No snapshot tests.**
- **Existing per-section tests** (`ModelSection`, `WindowSection`, `StartupSection`, `AutonomySection`, `NotificationsSection`, `SessionHistorySection`, `MemorySection`, `AboutSection`, `SettingsShell`) should keep passing unchanged. They assert IPC behavior and label text, not class names. After each section is migrated, run its test to verify.
- If any existing test happens to assert on the old class strings (it shouldn't, based on review), update that single assertion in the same task that migrated the section.

## Files added / changed

**New:**
- `src/renderer/components/settings/SubsectionPage.tsx`
- `src/renderer/components/settings/SubsectionPage.test.tsx`

**Modified:**
- `src/renderer/components/SettingsControls.tsx` — `Toggle` (py-3, font-medium, divided prop), `RadioGroup` (py-2.5, font-medium).
- `src/renderer/components/settings/SettingsShell.tsx` — sidebar + tab type sizes/weights.
- `src/renderer/components/settings/ModelSection.tsx`
- `src/renderer/components/settings/WindowSection.tsx`
- `src/renderer/components/settings/ShortcutSection.tsx`
- `src/renderer/components/settings/StartupSection.tsx`
- `src/renderer/components/settings/AutonomySection.tsx`
- `src/renderer/components/settings/NotificationsSection.tsx` (also: pass `divided` to its toggles)
- `src/renderer/components/settings/SessionHistorySection.tsx`
- `src/renderer/components/settings/MemorySection.tsx` (wrap with kind-derived `SubsectionPage` title)
- `src/renderer/components/settings/AboutSection.tsx`

**Possibly deleted (depends on grep):**
- `Section` export in `src/renderer/components/SettingsControls.tsx`, if and only if `UpdaterSection.tsx` no longer uses it. Otherwise keep.

## Open questions deferred to implementation

- Whether to upgrade `UpdaterSection.tsx` to use `SubsectionPage` (will look visually mismatched against the rest of the About tab otherwise). Defer to dogfooding; the wrapper task `UpdatesSection` can take this up if it bugs us.
