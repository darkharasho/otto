# Settings Typography & Row Rhythm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a working heading hierarchy and row rhythm in the redesigned settings window — subsection titles outrank field labels, stacked toggles get clear row dividers, and the sidebar/tab text bumps from 12px to 13px.

**Architecture:** A new `SubsectionPage` component replaces the inline `Section` wrapper in every per-section component; it renders the subsection title as a real heading at the top of the content pane with a divider below. Existing `Toggle` and `RadioGroup` primitives get small padding + weight bumps and a new `divided` prop on `Toggle` for stacked-toggle row separation.

**Tech Stack:** React 18, Tailwind, Plus Jakarta Sans (already loaded), Vitest + Testing Library.

**Reference spec:** `docs/superpowers/specs/2026-05-23-settings-typography-design.md`

---

## File map

**Create:**
- `src/renderer/components/settings/SubsectionPage.tsx`
- `src/renderer/components/settings/SubsectionPage.test.tsx`

**Modify:**
- `src/renderer/components/SettingsControls.tsx` — `Toggle` (py-3, font-medium label, new `divided` prop), `RadioGroup` (py-2.5).
- `src/renderer/components/settings/SettingsShell.tsx` — text-xs → text-[13px] on tabs + sidebar; tabs add `font-medium`.
- `src/renderer/components/settings/ModelSection.tsx` — swap `Section` → `SubsectionPage`.
- `src/renderer/components/settings/WindowSection.tsx` — swap.
- `src/renderer/components/settings/ShortcutSection.tsx` — swap.
- `src/renderer/components/settings/StartupSection.tsx` — swap.
- `src/renderer/components/settings/AutonomySection.tsx` — swap.
- `src/renderer/components/settings/NotificationsSection.tsx` — swap + pass `divided` to each Toggle.
- `src/renderer/components/settings/SessionHistorySection.tsx` — swap.
- `src/renderer/components/settings/MemorySection.tsx` — wrap with kind-derived `SubsectionPage` title.
- `src/renderer/components/settings/AboutSection.tsx` — swap.

**Possibly removed (depends on grep):**
- `Section` export in `src/renderer/components/SettingsControls.tsx`, if no consumer remains. Tasks 5 covers the grep + decision.

`UpdaterSection.tsx` (the parent of `UpdatesSection.tsx` wrapper) is out of scope — it uses `Section` internally and stays as-is for v1.

---

## Task 1: SubsectionPage component

**Files:**
- Create: `src/renderer/components/settings/SubsectionPage.tsx`
- Create: `src/renderer/components/settings/SubsectionPage.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/components/settings/SubsectionPage.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SubsectionPage } from './SubsectionPage';

describe('SubsectionPage', () => {
  it('always renders the title as a heading', () => {
    render(
      <SubsectionPage title="Notifications">
        <div>body</div>
      </SubsectionPage>
    );
    expect(screen.getByRole('heading', { name: 'Notifications' })).toBeTruthy();
  });

  it('renders the description when provided', () => {
    render(
      <SubsectionPage title="Notifications" description="When Otto alerts you.">
        <div />
      </SubsectionPage>
    );
    expect(screen.getByText('When Otto alerts you.')).toBeTruthy();
  });

  it('does NOT render a description node when omitted', () => {
    const { container } = render(
      <SubsectionPage title="Notifications">
        <div />
      </SubsectionPage>
    );
    expect(container.querySelector('p')).toBeNull();
  });

  it('renders children', () => {
    render(
      <SubsectionPage title="Notifications">
        <div>body content</div>
      </SubsectionPage>
    );
    expect(screen.getByText('body content')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/renderer/components/settings/SubsectionPage.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement SubsectionPage**

Create `src/renderer/components/settings/SubsectionPage.tsx`:

```tsx
import type { ReactNode } from 'react';

interface Props {
  title: string;
  description?: string;
  children: ReactNode;
}

export function SubsectionPage({ title, description, children }: Props) {
  return (
    <section>
      <header>
        <h2 className="text-base font-semibold text-text">{title}</h2>
        {description && <p className="text-xs text-muted mt-1">{description}</p>}
      </header>
      <div className="border-b border-border mt-3 mb-4" />
      <div>{children}</div>
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/renderer/components/settings/SubsectionPage.test.tsx`
Expected: PASS all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/settings/SubsectionPage.tsx src/renderer/components/settings/SubsectionPage.test.tsx
git commit -m "$(cat <<'EOF'
feat(settings): SubsectionPage component with heading + divider

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Toggle + RadioGroup updates

**Files:**
- Modify: `src/renderer/components/SettingsControls.tsx`

- [ ] **Step 1: Update `Toggle` — py-3, font-medium label, divided prop**

In `src/renderer/components/SettingsControls.tsx`, replace the `Toggle` function:

```tsx
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  divided = false,
}: {
  checked: boolean;
  onChange(v: boolean): void;
  label: string;
  description?: string;
  disabled?: boolean;
  divided?: boolean;
}) {
  return (
    <label
      className={[
        'flex items-start gap-3 py-3 cursor-pointer select-none',
        divided ? 'border-b border-border/40 last:border-b-0' : '',
        disabled ? 'opacity-50 cursor-not-allowed' : '',
      ].join(' ')}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={[
          'group/toggle mt-0.5 box-content relative w-[28px] h-[14px] p-[2px] rounded-full',
          'border transition-colors flex-shrink-0',
          checked
            ? 'bg-accent border-accent'
            : 'bg-bg/60 border-border hover:border-accent/60',
        ].join(' ')}
      >
        <span
          aria-hidden
          className={[
            'block w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform duration-150 ease-out',
            checked ? 'translate-x-[14px]' : 'translate-x-0',
          ].join(' ')}
        />
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text leading-tight">{label}</div>
        {description && <div className="text-[11px] text-muted mt-0.5 leading-snug">{description}</div>}
      </div>
    </label>
  );
}
```

Changes from current: `py-1.5` → `py-3`; new `divided` prop in destructuring + class array; label span has `font-medium` added; description span has `leading-snug` added.

- [ ] **Step 2: Update `RadioGroup` option padding**

In the same file, in `RadioGroup`, change the option button's padding:

```tsx
'relative w-full text-left pl-3 pr-2.5 py-2.5 rounded-lg transition-colors',
```

(Was `py-2`. Nothing else in `RadioGroup` changes — `font-medium` is already on `opt.label`.)

- [ ] **Step 3: Run the existing test suite to confirm no breakage**

Run: `npm test`
Expected: PASS — all existing tests should still be green since they assert on label text and IPC calls, not class strings.

If any test fails because it matched on the old `py-1.5` class string, update the assertion in that test file (the test was overly brittle). Don't change behavior.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/SettingsControls.tsx
git commit -m "$(cat <<'EOF'
feat(settings): Toggle row padding + font-medium label + divided prop; RadioGroup padding bump

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: SettingsShell — bump tab + sidebar type sizes

**Files:**
- Modify: `src/renderer/components/settings/SettingsShell.tsx`

- [ ] **Step 1: Update tab button class**

In `src/renderer/components/settings/SettingsShell.tsx`, find the top-tab button. Change its `className` template to:

```tsx
className={`px-3 py-1 text-[13px] font-medium rounded ${
  selected ? 'bg-accent text-white' : 'bg-bg/40 text-muted hover:text-text'
}`}
```

(Was `text-xs`. Added `font-medium`.)

- [ ] **Step 2: Update sidebar entry button class**

In the same file, find the sidebar entry button. Change its `className` template to:

```tsx
className={`block w-full text-left px-4 py-1.5 text-[13px] ${
  current ? 'bg-accent/15 text-text font-medium' : 'text-muted hover:text-text hover:bg-bg/40'
}`}
```

(Was `text-xs`. `font-medium` was already on the `current` branch.)

- [ ] **Step 3: Run the SettingsShell tests**

Run: `npm test -- src/renderer/components/settings/SettingsShell.test.tsx`
Expected: PASS — tests assert on `role`, `aria-selected`, `aria-current`, and text content, not class strings.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/settings/SettingsShell.tsx
git commit -m "$(cat <<'EOF'
feat(settings): bump tab + sidebar to 13px, add font-medium to tabs

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Migrate General + Behavior sections to SubsectionPage

This is mechanical: swap `Section` → `SubsectionPage` in 7 files. Each replacement is identical in API: `Section` and `SubsectionPage` both take `title` + optional `description` + children. Also add `divided` prop to the toggles in `NotificationsSection`.

**Files:**
- Modify: `src/renderer/components/settings/ModelSection.tsx`
- Modify: `src/renderer/components/settings/WindowSection.tsx`
- Modify: `src/renderer/components/settings/ShortcutSection.tsx`
- Modify: `src/renderer/components/settings/StartupSection.tsx`
- Modify: `src/renderer/components/settings/AutonomySection.tsx`
- Modify: `src/renderer/components/settings/NotificationsSection.tsx`
- Modify: `src/renderer/components/settings/SessionHistorySection.tsx`

- [ ] **Step 1: Update `ModelSection.tsx`**

Replace the file contents with:

```tsx
import { ModelSwitcher } from '../ModelSwitcher';
import { SubsectionPage } from './SubsectionPage';

export function ModelSection({ value, onChange }: { value: string; onChange: (m: string) => void }) {
  return (
    <SubsectionPage title="Model" description="Used for every new session.">
      <ModelSwitcher value={value} onChange={onChange} />
    </SubsectionPage>
  );
}
```

- [ ] **Step 2: Update `WindowSection.tsx`**

Replace the file contents with:

```tsx
import { Toggle, RadioGroup } from '../SettingsControls';
import { SubsectionPage } from './SubsectionPage';

export type WindowPosition = 'bottom-center' | 'top-center';

interface Props {
  windowPosition: WindowPosition;
  hideOnBlur: boolean;
  onPositionChange: (p: WindowPosition) => void;
  onHideOnBlurChange: (v: boolean) => void;
}

export function WindowSection({
  windowPosition,
  hideOnBlur,
  onPositionChange,
  onHideOnBlurChange,
}: Props) {
  return (
    <SubsectionPage title="Window" description="Where the bar and panel appear when summoned.">
      <RadioGroup<WindowPosition>
        value={windowPosition}
        onChange={onPositionChange}
        options={[
          { value: 'bottom-center', label: 'Bottom center', description: 'Grows upward as the panel opens.' },
          { value: 'top-center', label: 'Top center', description: 'Grows downward as the panel opens.' },
        ]}
      />
      <Toggle
        checked={hideOnBlur}
        onChange={onHideOnBlurChange}
        label="Hide when clicked away"
        description="When on, clicking outside Otto hides it (like a popover). When off, Otto stays open until you dismiss it with the hotkey."
      />
    </SubsectionPage>
  );
}
```

- [ ] **Step 3: Update `ShortcutSection.tsx`**

Read the current file first (it was moved to `src/renderer/components/settings/ShortcutSection.tsx` in an earlier task). Identify the existing `<Section title="…" description="…">…</Section>` wrapper at its top level. Replace the `Section` import with `SubsectionPage` and the wrapper element name with `SubsectionPage`. Do not change any internal logic. Concretely:

- Change the import line that says `import { Section } from '../SettingsControls';` to `import { SubsectionPage } from './SubsectionPage';`.
- Change every `<Section …>` to `<SubsectionPage …>` and `</Section>` to `</SubsectionPage>`.

If `ShortcutSection.tsx` imports anything besides `Section` from `../SettingsControls`, keep that import minus `Section`.

- [ ] **Step 4: Update `StartupSection.tsx`**

Replace the file contents with:

```tsx
import { Toggle } from '../SettingsControls';
import { SubsectionPage } from './SubsectionPage';

export function StartupSection({
  startAtLogin,
  onChange,
}: {
  startAtLogin: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <SubsectionPage title="Startup">
      <Toggle
        checked={startAtLogin}
        onChange={onChange}
        label="Start at login"
        description="Run Otto in the background when you sign in."
      />
    </SubsectionPage>
  );
}
```

- [ ] **Step 5: Update `AutonomySection.tsx`**

Replace the file contents with:

```tsx
import { RadioGroup } from '../SettingsControls';
import { SubsectionPage } from './SubsectionPage';
import type { AutonomyMode } from '@shared/messages';

export function AutonomySection({
  mode,
  onChange,
}: {
  mode: AutonomyMode;
  onChange: (m: AutonomyMode) => void;
}) {
  return (
    <SubsectionPage title="Autonomy" description="How freely Otto can take action without asking.">
      <RadioGroup<AutonomyMode>
        value={mode}
        onChange={onChange}
        options={[
          { value: 'strict', label: 'Strict', description: 'Ask before any reversible or destructive action.' },
          { value: 'balanced', label: 'Balanced', description: 'Run read-only freely, ask for destructive or irreversible.' },
          { value: 'full-allow', label: 'Full allow', description: 'Run everything without asking. Use at your own risk.' },
        ]}
      />
    </SubsectionPage>
  );
}
```

- [ ] **Step 6: Update `NotificationsSection.tsx` — swap + add `divided` to toggles**

Replace the file contents with:

```tsx
import { Toggle } from '../SettingsControls';
import { SubsectionPage } from './SubsectionPage';

export interface NotificationsState {
  turnComplete: boolean;
  approval: boolean;
  sound: boolean;
}

export function NotificationsSection({
  notifications,
  onChange,
}: {
  notifications: NotificationsState;
  onChange: (patch: Partial<NotificationsState>) => void;
}) {
  return (
    <SubsectionPage title="Notifications">
      <Toggle
        divided
        checked={notifications.turnComplete}
        onChange={(v) => onChange({ turnComplete: v })}
        label="When Otto finishes responding"
        description="Only fires when the Otto window isn't focused."
      />
      <Toggle
        divided
        checked={notifications.approval}
        onChange={(v) => onChange({ approval: v })}
        label="When Otto needs approval"
        description="Critical priority — won't be silenced by Do Not Disturb."
      />
      <Toggle
        divided
        checked={notifications.sound}
        onChange={(v) => onChange({ sound: v })}
        label="Play sound"
      />
    </SubsectionPage>
  );
}
```

- [ ] **Step 7: Update `SessionHistorySection.tsx`**

Replace the file contents with:

```tsx
import { useState } from 'react';
import { NumberField } from '../SettingsControls';
import { SubsectionPage } from './SubsectionPage';

export function SessionHistorySection({
  autoDeleteDays,
  onAutoDeleteDaysChange,
  onResetAllSessions,
}: {
  autoDeleteDays: number;
  onAutoDeleteDaysChange: (days: number) => void;
  onResetAllSessions: () => Promise<void>;
}) {
  return (
    <SubsectionPage title="Session history" description="Sessions live in a local SQLite database.">
      <div className="flex items-center justify-between gap-3 py-1.5">
        <div className="flex-1">
          <div className="text-sm">Auto-delete older than</div>
          <div className="text-[11px] text-muted">0 = keep forever.</div>
        </div>
        <NumberField value={autoDeleteDays} onChange={onAutoDeleteDaysChange} suffix="days" />
      </div>
      <div className="pt-1">
        <DangerButton
          label="Delete all sessions…"
          confirm="Permanently delete every saved session?"
          onConfirm={onResetAllSessions}
        />
      </div>
    </SubsectionPage>
  );
}

function DangerButton({
  label,
  confirm,
  onConfirm,
}: {
  label: string;
  confirm: string;
  onConfirm(): Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <button type="button" onClick={() => setArmed(true)} className="text-xs text-danger hover:underline">
        {label}
      </button>
    );
  }
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted">{confirm}</span>
      <button
        type="button"
        onClick={async () => {
          await onConfirm();
          setArmed(false);
        }}
        className="px-2 py-0.5 rounded bg-danger text-white hover:bg-danger/90"
      >
        Yes
      </button>
      <button type="button" onClick={() => setArmed(false)} className="text-muted hover:text-text">
        Cancel
      </button>
    </div>
  );
}
```

- [ ] **Step 8: Run tests for these sections**

Run:
```bash
npm test -- src/renderer/components/settings/ModelSection.test.tsx src/renderer/components/settings/WindowSection.test.tsx src/renderer/components/settings/StartupSection.test.tsx src/renderer/components/settings/AutonomySection.test.tsx src/renderer/components/settings/NotificationsSection.test.tsx src/renderer/components/settings/SessionHistorySection.test.tsx
```
Expected: PASS — all tests assert on label text and IPC behavior, not on `Section` class names. ShortcutSection has no test today; verify it renders by running `npm run typecheck`.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/components/settings/ModelSection.tsx src/renderer/components/settings/WindowSection.tsx src/renderer/components/settings/ShortcutSection.tsx src/renderer/components/settings/StartupSection.tsx src/renderer/components/settings/AutonomySection.tsx src/renderer/components/settings/NotificationsSection.tsx src/renderer/components/settings/SessionHistorySection.tsx
git commit -m "$(cat <<'EOF'
refactor(settings): migrate General + Behavior sections to SubsectionPage

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Migrate Memory + About; final cleanup

**Files:**
- Modify: `src/renderer/components/settings/MemorySection.tsx`
- Modify: `src/renderer/components/settings/AboutSection.tsx`
- Possibly modify: `src/renderer/components/SettingsControls.tsx` (delete `Section` if unused)

- [ ] **Step 1: Update `AboutSection.tsx`**

Replace the file contents with:

```tsx
import { SubsectionPage } from './SubsectionPage';

export function AboutSection({
  version,
  onOpenLogs,
}: {
  version: string;
  onOpenLogs: () => void;
}) {
  return (
    <SubsectionPage title="About">
      <div className="flex items-center justify-between text-xs text-muted py-1">
        <span>Otto v{version}</span>
        <button type="button" onClick={onOpenLogs} className="text-accent hover:underline">
          Open logs folder
        </button>
      </div>
    </SubsectionPage>
  );
}
```

- [ ] **Step 2: Wrap `MemorySection` with a kind-derived `SubsectionPage` title**

Open `src/renderer/components/settings/MemorySection.tsx`. At the top of the file, after the `MemoryKind` type alias, add:

```tsx
const KIND_LABELS: Record<MemoryKind, string> = {
  fact: 'Facts',
  playbook: 'Playbooks',
  anti_pattern: 'Anti-patterns',
  heuristic: 'Heuristics',
};
```

Add the import at the top:

```tsx
import { SubsectionPage } from './SubsectionPage';
```

Change the return statement so the whole existing JSX tree is wrapped in `<SubsectionPage title={KIND_LABELS[kind]}>` instead of the current `<div className="space-y-3">`. Concretely, replace:

```tsx
return (
  <div className="space-y-3">
    <input
      type="text"
      placeholder="Search…"
      ...
```

with:

```tsx
return (
  <SubsectionPage title={KIND_LABELS[kind]}>
    <div className="space-y-3">
      <input
        type="text"
        placeholder="Search…"
        ...
```

And the matching closing tag at the bottom of the return — change `</div>` to `</div>\n  </SubsectionPage>`. (The inner `<div className="space-y-3">` stays so the body still has its existing vertical rhythm.)

The two `editing` and `factsEdit` modal blocks at the bottom of the return stay inside `SubsectionPage` (they're position: fixed, so it doesn't matter visually where in the tree they live, but keeping them inside the same root keeps React reconciliation simple).

- [ ] **Step 3: Run tests**

Run:
```bash
npm test -- src/renderer/components/settings/AboutSection.test.tsx src/renderer/components/settings/MemorySection.test.tsx
```
Expected: PASS — tests assert on text content and IPC, not on wrappers.

- [ ] **Step 4: Grep for remaining `Section` consumers**

Run:
```bash
grep -rn "import { Section" src/renderer --include='*.ts' --include='*.tsx'
grep -rn "import { .*Section.* } from '../SettingsControls'" src/renderer --include='*.ts' --include='*.tsx'
```

Note which files (if any) still import `Section` from `SettingsControls`.

**Decision:**
- If only `src/renderer/components/UpdaterSection.tsx` still imports `Section`, leave the `Section` export in place (it's still used).
- If NO files import `Section`, delete the `Section` function from `src/renderer/components/SettingsControls.tsx` (lines 3–21 in the current file).

- [ ] **Step 5: If `Section` is unused, delete it**

If step 4 found no consumers, open `src/renderer/components/SettingsControls.tsx` and remove the entire `Section` function (the `export function Section({...}) { return (...); }` block). Leave `Toggle`, `RadioGroup`, `NumberField` and the `import type { ReactNode } from 'react';` line untouched — they're still in use.

If step 4 found `UpdaterSection.tsx` still imports `Section`, skip this step.

- [ ] **Step 6: Final verification**

Run:
```bash
npm run typecheck && npm test && npm run lint
```

All three must be clean (lint may still report the two pre-existing `BUTTON_CODE`/`BUTTON_LOW` warnings in `linux.ts`; those are unrelated).

- [ ] **Step 7: Manual smoke test**

Run: `OTTO_FAKE_SDK=1 npm run dev`
- Open Settings via the tray.
- Click each top tab; confirm the new 13px tab text reads cleanly.
- For each subsection, confirm:
  - A clear subsection title at the top of the content pane (16px semibold).
  - A horizontal divider under the title.
  - Field labels are noticeably bolder than their descriptions.
- For Notifications: confirm the three toggles have subtle dividers between them.
- For Memory tab: confirm the subsection title changes when you click between Facts / Playbooks / Anti-patterns / Heuristics.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/components/settings/MemorySection.tsx src/renderer/components/settings/AboutSection.tsx
# Add SettingsControls.tsx if Section was deleted in Step 5:
git add src/renderer/components/SettingsControls.tsx 2>/dev/null || true
git commit -m "$(cat <<'EOF'
refactor(settings): migrate Memory + About to SubsectionPage; clean up

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes (already applied above)

- **Spec coverage:**
  - Spec §1 (type scale) → Tasks 2 (Toggle/Radio), 3 (Shell tabs/sidebar), and SubsectionPage in Task 1 (page header + description).
  - Spec §2 (SubsectionPage replaces Section) → Task 1 creates the component, Tasks 4–5 migrate every consumer, Task 5 step 4–5 handles the `Section` removal decision.
  - Spec §3 (row rhythm) → Task 2 (Toggle py-3 + divided, Radio py-2.5), Task 4 step 6 (NotificationsSection passes `divided`).
  - Spec §4 (testing) → Task 1 has the 4 SubsectionPage assertions; each migration task re-runs the existing per-section test to verify no regression.
- **Placeholder scan:** every code block is complete.
- **Type consistency:** `SubsectionPage` Props (`title: string; description?: string; children: ReactNode`) is identical between Task 1's definition and every consumer in Tasks 4–5. `divided?: boolean` on `Toggle` is added in Task 2 and consumed in Task 4 step 6. `KIND_LABELS: Record<MemoryKind, string>` is defined inside `MemorySection.tsx` in Task 5; the `MemoryKind` type already exists from the prior Memory work.
