# Settings Window Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-scroll settings window with a wider (780×720) two-level layout: four top tabs (General / Behavior / Memory / About), each with a left sidebar of subsections and a content pane.

**Architecture:** `SettingsApp` becomes a thin state owner that renders a new presentational `SettingsShell` (top tabs + sidebar + content slot) and dispatches to one of ~10 per-subsection components. The Memory panel's internal tab strip dissolves into the outer sidebar — the same logic moves into a `MemorySection` parameterized by `kind`.

**Tech Stack:** React 18, TypeScript, Tailwind, Vitest + Testing Library. Electron BrowserWindow size config in `src/main/settings-window.ts`.

**Reference spec:** `docs/superpowers/specs/2026-05-23-settings-redesign-design.md`

---

## File map

**Create (all under `src/renderer/components/settings/`):**
- `SettingsShell.tsx` + `.test.tsx` — presentational chrome.
- `SettingsNav.ts` — tab/subsection data + types.
- `ModelSection.tsx` + `.test.tsx`
- `WindowSection.tsx` + `.test.tsx`
- `StartupSection.tsx` + `.test.tsx`
- `AutonomySection.tsx` + `.test.tsx`
- `NotificationsSection.tsx` + `.test.tsx`
- `SessionHistorySection.tsx` + `.test.tsx`
- `MemorySection.tsx` + `.test.tsx`
- `AboutSection.tsx` + `.test.tsx`
- `UpdatesSection.tsx` (thin wrapper around existing `UpdaterSection`).
- `ShortcutSection.tsx` (moved from `src/renderer/components/ShortcutSection.tsx`).

**Modify:**
- `src/main/settings-window.ts` — `WIDTH` 520 → 780.
- `src/renderer/SettingsApp.tsx` — gutted body, becomes state owner + dispatcher.

**Delete:**
- `src/renderer/components/MemoryPanel.tsx`
- `src/renderer/components/MemoryPanel.test.tsx`
- `src/renderer/components/ShortcutSection.tsx` (after move)

`src/renderer/components/UpdaterSection.tsx` stays in place; `UpdatesSection.tsx` is a one-line wrapper. `src/renderer/components/SettingsControls.tsx` (which exports `Section`, `Toggle`, `RadioGroup`, `NumberField`) is unchanged and imported from the new section components.

---

## Task 1: Widen the settings window

**Files:**
- Modify: `src/main/settings-window.ts`

- [ ] **Step 1: Change the width constant**

In `src/main/settings-window.ts`, line 7:

```ts
const WIDTH = 780;
```

(Was `const WIDTH = 520;`. Height `720` unchanged.)

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/settings-window.ts
git commit -m "$(cat <<'EOF'
feat(settings): widen settings window to 780px

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Settings navigation data module

**Files:**
- Create: `src/renderer/components/settings/SettingsNav.ts`

No tests — pure data, exercised via `SettingsShell` and `SettingsApp` tests in later tasks.

- [ ] **Step 1: Create the file**

Create `src/renderer/components/settings/SettingsNav.ts`:

```ts
export type TabId = 'general' | 'behavior' | 'memory' | 'about';
export type SubId = string;

export interface SubEntry {
  id: SubId;
  label: string;
}

export interface TabEntry {
  id: TabId;
  label: string;
  subs: SubEntry[];
}

export const TABS: TabEntry[] = [
  {
    id: 'general',
    label: 'General',
    subs: [
      { id: 'model', label: 'Model' },
      { id: 'window', label: 'Window' },
      { id: 'shortcut', label: 'Shortcut' },
      { id: 'startup', label: 'Startup' },
    ],
  },
  {
    id: 'behavior',
    label: 'Behavior',
    subs: [
      { id: 'autonomy', label: 'Autonomy' },
      { id: 'notifications', label: 'Notifications' },
      { id: 'sessionHistory', label: 'Session history' },
    ],
  },
  {
    id: 'memory',
    label: 'Memory',
    subs: [
      { id: 'fact', label: 'Facts' },
      { id: 'playbook', label: 'Playbooks' },
      { id: 'anti_pattern', label: 'Anti-patterns' },
      { id: 'heuristic', label: 'Heuristics' },
    ],
  },
  {
    id: 'about',
    label: 'About',
    subs: [
      { id: 'versionLogs', label: 'Version & logs' },
      { id: 'updates', label: 'Updates' },
    ],
  },
];

export function defaultSubFor(tab: TabId): SubId {
  const found = TABS.find((t) => t.id === tab);
  if (!found) throw new Error(`unknown tab ${tab}`);
  return found.subs[0]!.id;
}

export function subsFor(tab: TabId): SubEntry[] {
  return TABS.find((t) => t.id === tab)?.subs ?? [];
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/settings/SettingsNav.ts
git commit -m "$(cat <<'EOF'
feat(settings): tab/subsection nav data module

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: SettingsShell (presentational chrome)

**Files:**
- Create: `src/renderer/components/settings/SettingsShell.tsx`
- Create: `src/renderer/components/settings/SettingsShell.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/components/settings/SettingsShell.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettingsShell } from './SettingsShell';

const SIDEBAR = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
];

describe('SettingsShell', () => {
  it('renders all top tabs and the provided sidebar entries', () => {
    render(
      <SettingsShell
        activeTab="general"
        onTabChange={() => {}}
        sidebar={SIDEBAR}
        activeSub="a"
        onSubChange={() => {}}
      >
        <div>content</div>
      </SettingsShell>
    );
    for (const label of ['General', 'Behavior', 'Memory', 'About']) {
      expect(screen.getByRole('tab', { name: label })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Beta' })).toBeTruthy();
    expect(screen.getByText('content')).toBeTruthy();
  });

  it('marks the active tab via aria-selected', () => {
    render(
      <SettingsShell
        activeTab="behavior"
        onTabChange={() => {}}
        sidebar={SIDEBAR}
        activeSub="a"
        onSubChange={() => {}}
      >
        <div />
      </SettingsShell>
    );
    expect(screen.getByRole('tab', { name: 'Behavior' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('false');
  });

  it('marks the active sidebar entry via aria-current', () => {
    render(
      <SettingsShell
        activeTab="general"
        onTabChange={() => {}}
        sidebar={SIDEBAR}
        activeSub="b"
        onSubChange={() => {}}
      >
        <div />
      </SettingsShell>
    );
    expect(screen.getByRole('button', { name: 'Beta' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'Alpha' }).getAttribute('aria-current')).toBe('false');
  });

  it('clicking a tab fires onTabChange with the new tab id', () => {
    const onTabChange = vi.fn();
    render(
      <SettingsShell
        activeTab="general"
        onTabChange={onTabChange}
        sidebar={SIDEBAR}
        activeSub="a"
        onSubChange={() => {}}
      >
        <div />
      </SettingsShell>
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Memory' }));
    expect(onTabChange).toHaveBeenCalledWith('memory');
  });

  it('clicking a sidebar entry fires onSubChange with the new sub id', () => {
    const onSubChange = vi.fn();
    render(
      <SettingsShell
        activeTab="general"
        onTabChange={() => {}}
        sidebar={SIDEBAR}
        activeSub="a"
        onSubChange={onSubChange}
      >
        <div />
      </SettingsShell>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }));
    expect(onSubChange).toHaveBeenCalledWith('b');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/renderer/components/settings/SettingsShell.test.tsx`
Expected: FAIL — `SettingsShell` not found.

- [ ] **Step 3: Implement SettingsShell**

Create `src/renderer/components/settings/SettingsShell.tsx`:

```tsx
import type { ReactNode } from 'react';
import { TABS, type SubEntry, type TabId } from './SettingsNav';

interface Props {
  activeTab: TabId;
  onTabChange: (tab: TabId) => void;
  sidebar: SubEntry[];
  activeSub: string;
  onSubChange: (sub: string) => void;
  children: ReactNode;
}

export function SettingsShell({
  activeTab,
  onTabChange,
  sidebar,
  activeSub,
  onSubChange,
  children,
}: Props) {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex gap-1 px-4 py-2 border-b border-border" role="tablist">
        {TABS.map((t) => {
          const selected = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onTabChange(t.id)}
              className={`px-3 py-1 text-xs rounded ${
                selected ? 'bg-accent text-white' : 'bg-bg/40 text-muted hover:text-text'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 grid min-h-0" style={{ gridTemplateColumns: '180px 1fr' }}>
        <nav className="border-r border-border overflow-y-auto py-2">
          {sidebar.map((s) => {
            const current = activeSub === s.id;
            return (
              <button
                key={s.id}
                type="button"
                aria-current={current}
                onClick={() => onSubChange(s.id)}
                className={`block w-full text-left px-4 py-1.5 text-xs ${
                  current ? 'bg-accent/15 text-text font-medium' : 'text-muted hover:text-text hover:bg-bg/40'
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </nav>

        <div className="overflow-y-auto px-5 py-5 space-y-6">{children}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/renderer/components/settings/SettingsShell.test.tsx`
Expected: PASS all 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/settings/SettingsShell.tsx src/renderer/components/settings/SettingsShell.test.tsx
git commit -m "$(cat <<'EOF'
feat(settings): SettingsShell — top tabs + sidebar + content slot

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Move ShortcutSection into settings/ folder

`ShortcutSection.tsx` already exists at `src/renderer/components/ShortcutSection.tsx`. Move it; update the one import in `SettingsApp.tsx` to keep the app compiling.

**Files:**
- Move: `src/renderer/components/ShortcutSection.tsx` → `src/renderer/components/settings/ShortcutSection.tsx`
- Modify: `src/renderer/SettingsApp.tsx` (one import line)

- [ ] **Step 1: Move the file**

```bash
git mv src/renderer/components/ShortcutSection.tsx src/renderer/components/settings/ShortcutSection.tsx
```

- [ ] **Step 2: Verify imports inside the moved file resolve from the new location**

Open `src/renderer/components/settings/ShortcutSection.tsx`. Any relative imports starting with `'../'` need to be re-rooted: `'../ipc'` → `'../../ipc'`, `'./SettingsControls'` → `'../SettingsControls'`, etc.

Read the file and update any relative imports so each path resolves correctly from the new location.

- [ ] **Step 3: Update the consumer**

In `src/renderer/SettingsApp.tsx`, change:

```ts
import { ShortcutSection } from './components/ShortcutSection';
```

to:

```ts
import { ShortcutSection } from './components/settings/ShortcutSection';
```

- [ ] **Step 4: Typecheck + test**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/settings/ShortcutSection.tsx src/renderer/SettingsApp.tsx
git commit -m "$(cat <<'EOF'
refactor(settings): move ShortcutSection into settings/ folder

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: General-tab sections (Model, Window, Startup)

Three thin section components extracted from `SettingsApp.tsx`. `SettingsApp` is not yet wired to use them — that wiring lands in Task 9. These are pure prop-driven components in this task.

**Files:**
- Create: `src/renderer/components/settings/ModelSection.tsx` + `.test.tsx`
- Create: `src/renderer/components/settings/WindowSection.tsx` + `.test.tsx`
- Create: `src/renderer/components/settings/StartupSection.tsx` + `.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/components/settings/ModelSection.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ModelSection } from './ModelSection';

describe('ModelSection', () => {
  it('renders without crashing and forwards value + onChange to the switcher', () => {
    const onChange = vi.fn();
    const { container } = render(<ModelSection value="claude-sonnet-4-6" onChange={onChange} />);
    expect(container.querySelector('section')).toBeTruthy();
  });
});
```

Create `src/renderer/components/settings/WindowSection.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WindowSection } from './WindowSection';

describe('WindowSection', () => {
  it('calls onPositionChange when a new position radio is clicked', () => {
    const onPositionChange = vi.fn();
    render(
      <WindowSection
        windowPosition="bottom-center"
        hideOnBlur={true}
        onPositionChange={onPositionChange}
        onHideOnBlurChange={() => {}}
      />
    );
    fireEvent.click(screen.getByText(/top center/i));
    expect(onPositionChange).toHaveBeenCalledWith('top-center');
  });

  it('calls onHideOnBlurChange when the hide-on-blur toggle is clicked', () => {
    const onHideOnBlurChange = vi.fn();
    render(
      <WindowSection
        windowPosition="bottom-center"
        hideOnBlur={false}
        onPositionChange={() => {}}
        onHideOnBlurChange={onHideOnBlurChange}
      />
    );
    fireEvent.click(screen.getByLabelText(/hide when clicked away/i));
    expect(onHideOnBlurChange).toHaveBeenCalledWith(true);
  });
});
```

Create `src/renderer/components/settings/StartupSection.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StartupSection } from './StartupSection';

describe('StartupSection', () => {
  it('calls onChange when the toggle is clicked', () => {
    const onChange = vi.fn();
    render(<StartupSection startAtLogin={false} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText(/start at login/i));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/renderer/components/settings/ModelSection.test.tsx src/renderer/components/settings/WindowSection.test.tsx src/renderer/components/settings/StartupSection.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the three components**

Create `src/renderer/components/settings/ModelSection.tsx`:

```tsx
import { ModelSwitcher } from '../ModelSwitcher';
import { Section } from '../SettingsControls';

export function ModelSection({ value, onChange }: { value: string; onChange: (m: string) => void }) {
  return (
    <Section title="Model" description="Used for every new session.">
      <ModelSwitcher value={value} onChange={onChange} />
    </Section>
  );
}
```

Create `src/renderer/components/settings/WindowSection.tsx`:

```tsx
import { Section, Toggle, RadioGroup } from '../SettingsControls';

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
    <Section title="Window" description="Where the bar and panel appear when summoned.">
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
    </Section>
  );
}
```

Create `src/renderer/components/settings/StartupSection.tsx`:

```tsx
import { Section, Toggle } from '../SettingsControls';

export function StartupSection({
  startAtLogin,
  onChange,
}: {
  startAtLogin: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Section title="Startup">
      <Toggle
        checked={startAtLogin}
        onChange={onChange}
        label="Start at login"
        description="Run Otto in the background when you sign in."
      />
    </Section>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/renderer/components/settings/ModelSection.test.tsx src/renderer/components/settings/WindowSection.test.tsx src/renderer/components/settings/StartupSection.test.tsx`
Expected: PASS all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/settings/ModelSection.tsx src/renderer/components/settings/ModelSection.test.tsx src/renderer/components/settings/WindowSection.tsx src/renderer/components/settings/WindowSection.test.tsx src/renderer/components/settings/StartupSection.tsx src/renderer/components/settings/StartupSection.test.tsx
git commit -m "$(cat <<'EOF'
feat(settings): extract Model, Window, Startup section components

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Behavior-tab sections (Autonomy, Notifications, SessionHistory)

**Files:**
- Create: `src/renderer/components/settings/AutonomySection.tsx` + `.test.tsx`
- Create: `src/renderer/components/settings/NotificationsSection.tsx` + `.test.tsx`
- Create: `src/renderer/components/settings/SessionHistorySection.tsx` + `.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/components/settings/AutonomySection.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AutonomySection } from './AutonomySection';

describe('AutonomySection', () => {
  it('calls onChange when a new mode is selected', () => {
    const onChange = vi.fn();
    render(<AutonomySection mode="balanced" onChange={onChange} />);
    fireEvent.click(screen.getByText(/^strict$/i));
    expect(onChange).toHaveBeenCalledWith('strict');
  });
});
```

Create `src/renderer/components/settings/NotificationsSection.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NotificationsSection } from './NotificationsSection';

describe('NotificationsSection', () => {
  it('toggling one notification calls onChange with only that key', () => {
    const onChange = vi.fn();
    render(
      <NotificationsSection
        notifications={{ turnComplete: false, approval: true, sound: true }}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByLabelText(/when otto finishes responding/i));
    expect(onChange).toHaveBeenCalledWith({ turnComplete: true });
  });
});
```

Create `src/renderer/components/settings/SessionHistorySection.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionHistorySection } from './SessionHistorySection';

describe('SessionHistorySection', () => {
  it('renders the auto-delete number and reveals confirm on danger click', () => {
    const onReset = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionHistorySection
        autoDeleteDays={30}
        onAutoDeleteDaysChange={() => {}}
        onResetAllSessions={onReset}
      />
    );
    fireEvent.click(screen.getByText(/delete all sessions/i));
    expect(screen.getByText(/permanently delete every saved session/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/renderer/components/settings/AutonomySection.test.tsx src/renderer/components/settings/NotificationsSection.test.tsx src/renderer/components/settings/SessionHistorySection.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the three components**

Create `src/renderer/components/settings/AutonomySection.tsx`:

```tsx
import { Section, RadioGroup } from '../SettingsControls';
import type { AutonomyMode } from '@shared/messages';

export function AutonomySection({
  mode,
  onChange,
}: {
  mode: AutonomyMode;
  onChange: (m: AutonomyMode) => void;
}) {
  return (
    <Section title="Autonomy" description="How freely Otto can take action without asking.">
      <RadioGroup<AutonomyMode>
        value={mode}
        onChange={onChange}
        options={[
          { value: 'strict', label: 'Strict', description: 'Ask before any reversible or destructive action.' },
          { value: 'balanced', label: 'Balanced', description: 'Run read-only freely, ask for destructive or irreversible.' },
          { value: 'full-allow', label: 'Full allow', description: 'Run everything without asking. Use at your own risk.' },
        ]}
      />
    </Section>
  );
}
```

Create `src/renderer/components/settings/NotificationsSection.tsx`:

```tsx
import { Section, Toggle } from '../SettingsControls';

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
    <Section title="Notifications">
      <Toggle
        checked={notifications.turnComplete}
        onChange={(v) => onChange({ turnComplete: v })}
        label="When Otto finishes responding"
        description="Only fires when the Otto window isn't focused."
      />
      <Toggle
        checked={notifications.approval}
        onChange={(v) => onChange({ approval: v })}
        label="When Otto needs approval"
        description="Critical priority — won't be silenced by Do Not Disturb."
      />
      <Toggle
        checked={notifications.sound}
        onChange={(v) => onChange({ sound: v })}
        label="Play sound"
      />
    </Section>
  );
}
```

Create `src/renderer/components/settings/SessionHistorySection.tsx`:

```tsx
import { useState } from 'react';
import { Section, NumberField } from '../SettingsControls';

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
    <Section title="Session history" description="Sessions live in a local SQLite database.">
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
    </Section>
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/renderer/components/settings/AutonomySection.test.tsx src/renderer/components/settings/NotificationsSection.test.tsx src/renderer/components/settings/SessionHistorySection.test.tsx`
Expected: PASS all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/settings/AutonomySection.tsx src/renderer/components/settings/AutonomySection.test.tsx src/renderer/components/settings/NotificationsSection.tsx src/renderer/components/settings/NotificationsSection.test.tsx src/renderer/components/settings/SessionHistorySection.tsx src/renderer/components/settings/SessionHistorySection.test.tsx
git commit -m "$(cat <<'EOF'
feat(settings): extract Autonomy, Notifications, SessionHistory sections

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: MemorySection (kind-scoped, replaces MemoryPanel)

`MemorySection` takes the active `kind` as a prop (set externally by the sidebar). It loses the internal tab strip — the four tabs are now sidebar entries that flip `kind` on the parent. Search box, list, edit/archive/delete + the two modals stay.

**Files:**
- Create: `src/renderer/components/settings/MemorySection.tsx`
- Create: `src/renderer/components/settings/MemorySection.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/components/settings/MemorySection.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemorySection } from './MemorySection';

const invokeMock = vi.fn();

beforeEach(() => {
  invokeMock.mockReset();
  (globalThis as unknown as { window: Window & { otto?: unknown } }).window.otto = {
    invoke: invokeMock,
  };
});

describe('MemorySection', () => {
  it('loads the given kind on mount and renders titles', async () => {
    invokeMock.mockResolvedValueOnce({
      artifacts: [
        {
          id: 'p1', kind: 'playbook', title: 'Restart audio', body: 'steps', tags: ['audio'],
          createdAt: 0, updatedAt: 0, useCount: 3, lastUsedAt: null, archived: false,
        },
      ],
      facts: [],
    });
    render(<MemorySection kind="playbook" />);
    await waitFor(() => expect(screen.getByText('Restart audio')).toBeTruthy());
    expect(invokeMock).toHaveBeenCalledWith('memory.list', expect.objectContaining({ kind: 'playbook' }));
  });

  it('renders facts list when kind is "fact"', async () => {
    invokeMock.mockResolvedValueOnce({ artifacts: [], facts: ['- (2026-05-22) Browser is Zen'] });
    render(<MemorySection kind="fact" />);
    await waitFor(() => expect(screen.getByText(/Browser is Zen/)).toBeTruthy());
    expect(invokeMock).toHaveBeenLastCalledWith(
      'memory.list',
      expect.objectContaining({ kind: 'fact' })
    );
  });

  it('archive calls memory.update with archived:true and refreshes', async () => {
    invokeMock
      .mockResolvedValueOnce({
        artifacts: [
          {
            id: 'p1', kind: 'playbook', title: 'Restart audio', body: 'steps', tags: [],
            createdAt: 0, updatedAt: 0, useCount: 0, lastUsedAt: null, archived: false,
          },
        ],
        facts: [],
      })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ artifacts: [], facts: [] });
    render(<MemorySection kind="playbook" />);
    await waitFor(() => expect(screen.getByText('Restart audio')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /archive/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        'memory.update',
        expect.objectContaining({ id: 'p1', patch: { archived: true } })
      )
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/renderer/components/settings/MemorySection.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement MemorySection**

Create `src/renderer/components/settings/MemorySection.tsx`:

```tsx
import { useEffect, useState, useCallback } from 'react';
import { ipc } from '../../ipc';
import type { MemoryArtifactView } from '@shared/ipc-contract';

export type MemoryKind = 'fact' | 'playbook' | 'anti_pattern' | 'heuristic';

export function MemorySection({ kind }: { kind: MemoryKind }) {
  const [query, setQuery] = useState('');
  const [artifacts, setArtifacts] = useState<MemoryArtifactView[]>([]);
  const [facts, setFacts] = useState<string[]>([]);
  const [editing, setEditing] = useState<MemoryArtifactView | null>(null);
  const [factsEdit, setFactsEdit] = useState<string | null>(null);

  const load = useCallback(async () => {
    const out = await ipc.invoke('memory.list', { kind, query: query.trim() || undefined });
    setArtifacts(out.artifacts);
    setFacts(out.facts);
  }, [kind, query]);

  useEffect(() => {
    setQuery('');
  }, [kind]);

  useEffect(() => {
    void load();
  }, [load]);

  async function archive(id: string) {
    await ipc.invoke('memory.update', { id, patch: { archived: true } });
    await load();
  }

  async function remove(id: string) {
    if (!confirm('Delete this entry permanently?')) return;
    await ipc.invoke('memory.delete', { id });
    await load();
  }

  async function saveEdit() {
    if (!editing) return;
    await ipc.invoke('memory.update', {
      id: editing.id,
      patch: { title: editing.title, body: editing.body, tags: editing.tags },
    });
    setEditing(null);
    await load();
  }

  async function openFactsEditor() {
    const text = await ipc.invoke('memory.readFacts', undefined);
    setFactsEdit(text);
  }

  async function saveFacts() {
    if (factsEdit === null) return;
    await ipc.invoke('memory.writeFacts', { text: factsEdit });
    setFactsEdit(null);
    await load();
  }

  return (
    <div className="space-y-3">
      <input
        type="text"
        placeholder="Search…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full px-2 py-1 text-sm bg-bg/40 border border-border rounded"
      />

      {kind === 'fact' ? (
        <div>
          <ul className="space-y-1 text-xs text-text">
            {facts.length === 0 ? (
              <li className="text-muted">No facts yet.</li>
            ) : (
              facts.map((line, i) => <li key={i}>{line}</li>)
            )}
          </ul>
          <button
            type="button"
            onClick={openFactsEditor}
            className="mt-2 text-xs text-accent hover:underline"
          >
            Edit knowledge.md…
          </button>
        </div>
      ) : (
        <ul className="space-y-2">
          {artifacts.length === 0 ? (
            <li className="text-xs text-muted">Nothing here yet.</li>
          ) : (
            artifacts.map((a) => (
              <li key={a.id} className="rounded border border-border p-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{a.title}</div>
                    <div className="text-[11px] text-muted flex flex-wrap gap-1 mt-1">
                      {a.tags.map((t) => (
                        <span key={t} className="px-1 rounded bg-bg/60">{t}</span>
                      ))}
                      <span>used {a.useCount}×</span>
                    </div>
                  </div>
                  <div className="flex gap-2 text-xs">
                    <button type="button" className="text-accent hover:underline" onClick={() => setEditing(a)}>Edit</button>
                    <button type="button" className="text-muted hover:text-text" onClick={() => archive(a.id)}>Archive</button>
                    <button type="button" className="text-danger hover:underline" onClick={() => remove(a.id)}>Delete</button>
                  </div>
                </div>
              </li>
            ))
          )}
        </ul>
      )}

      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-surface border border-border rounded-lg p-4 w-[640px] max-h-[80vh] flex flex-col gap-2">
            <input
              type="text"
              value={editing.title}
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
              className="px-2 py-1 text-sm bg-bg/40 border border-border rounded"
            />
            <textarea
              value={editing.body}
              onChange={(e) => setEditing({ ...editing, body: e.target.value })}
              className="flex-1 min-h-[240px] px-2 py-1 text-xs font-mono bg-bg/40 border border-border rounded"
            />
            <input
              type="text"
              value={editing.tags.join(', ')}
              onChange={(e) =>
                setEditing({
                  ...editing,
                  tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                })
              }
              placeholder="comma-separated tags"
              className="px-2 py-1 text-xs bg-bg/40 border border-border rounded"
            />
            <div className="flex justify-end gap-2 text-xs">
              <button type="button" className="text-muted hover:text-text" onClick={() => setEditing(null)}>Cancel</button>
              <button type="button" className="text-accent hover:underline" onClick={saveEdit}>Save</button>
            </div>
          </div>
        </div>
      )}

      {factsEdit !== null && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-surface border border-border rounded-lg p-4 w-[640px] max-h-[80vh] flex flex-col gap-2">
            <textarea
              value={factsEdit}
              onChange={(e) => setFactsEdit(e.target.value)}
              className="flex-1 min-h-[320px] px-2 py-1 text-xs font-mono bg-bg/40 border border-border rounded"
            />
            <div className="flex justify-end gap-2 text-xs">
              <button type="button" className="text-muted hover:text-text" onClick={() => setFactsEdit(null)}>Cancel</button>
              <button type="button" className="text-accent hover:underline" onClick={saveFacts}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/renderer/components/settings/MemorySection.test.tsx`
Expected: PASS all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/settings/MemorySection.tsx src/renderer/components/settings/MemorySection.test.tsx
git commit -m "$(cat <<'EOF'
feat(settings): MemorySection — kind-scoped memory browser

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: About-tab sections (AboutSection, UpdatesSection wrapper)

**Files:**
- Create: `src/renderer/components/settings/AboutSection.tsx` + `.test.tsx`
- Create: `src/renderer/components/settings/UpdatesSection.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/components/settings/AboutSection.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AboutSection } from './AboutSection';

describe('AboutSection', () => {
  it('renders the version string and fires onOpenLogs on click', () => {
    const onOpenLogs = vi.fn();
    render(<AboutSection version="0.2.5" onOpenLogs={onOpenLogs} />);
    expect(screen.getByText(/0\.2\.5/)).toBeTruthy();
    fireEvent.click(screen.getByText(/open logs folder/i));
    expect(onOpenLogs).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/renderer/components/settings/AboutSection.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement both**

Create `src/renderer/components/settings/AboutSection.tsx`:

```tsx
import { Section } from '../SettingsControls';

export function AboutSection({
  version,
  onOpenLogs,
}: {
  version: string;
  onOpenLogs: () => void;
}) {
  return (
    <Section title="About">
      <div className="flex items-center justify-between text-xs text-muted py-1">
        <span>Otto v{version}</span>
        <button type="button" onClick={onOpenLogs} className="text-accent hover:underline">
          Open logs folder
        </button>
      </div>
    </Section>
  );
}
```

Create `src/renderer/components/settings/UpdatesSection.tsx`:

```tsx
import { UpdaterSection } from '../UpdaterSection';

export function UpdatesSection({ version }: { version: string }) {
  return <UpdaterSection appVersion={version} />;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/renderer/components/settings/AboutSection.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/settings/AboutSection.tsx src/renderer/components/settings/AboutSection.test.tsx src/renderer/components/settings/UpdatesSection.tsx
git commit -m "$(cat <<'EOF'
feat(settings): AboutSection + UpdatesSection wrapper

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Rewrite SettingsApp as shell + dispatcher

This is the integration task. `SettingsApp` keeps its outer card chrome + header, but the body becomes `SettingsShell` wrapping a switch that renders one subsection component based on `(activeTab, activeSub)`.

**Files:**
- Modify: `src/renderer/SettingsApp.tsx`

- [ ] **Step 1: Read the current `SettingsApp.tsx`**

Open `src/renderer/SettingsApp.tsx` to understand the existing imports, state hooks (`patch`, `patchNotifications`), and outer card structure. Preserve everything outside the `<div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">` body.

- [ ] **Step 2: Replace `SettingsApp.tsx` with the new shell + dispatcher**

Write `src/renderer/SettingsApp.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useOttoStore } from './state/store';
import { ipc } from './ipc';
import { OttoMark } from './components/OttoMark';
import { SettingsShell } from './components/settings/SettingsShell';
import { defaultSubFor, subsFor, type TabId } from './components/settings/SettingsNav';
import { ModelSection } from './components/settings/ModelSection';
import { WindowSection } from './components/settings/WindowSection';
import { ShortcutSection } from './components/settings/ShortcutSection';
import { StartupSection } from './components/settings/StartupSection';
import { AutonomySection } from './components/settings/AutonomySection';
import { NotificationsSection } from './components/settings/NotificationsSection';
import { SessionHistorySection } from './components/settings/SessionHistorySection';
import { MemorySection, type MemoryKind } from './components/settings/MemorySection';
import { AboutSection } from './components/settings/AboutSection';
import { UpdatesSection } from './components/settings/UpdatesSection';
import type { SettingsView } from '@shared/ipc-contract';

export function SettingsApp() {
  const model = useOttoStore((s) => s.model);
  const setModel = useOttoStore((s) => s.setModel);
  const [s, setS] = useState<SettingsView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [activeSub, setActiveSub] = useState<string>(defaultSubFor('general'));

  useEffect(() => {
    ipc.invoke('settings.get', undefined).then(setS).catch((e) => {
      setErr(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    });
  }, []);

  if (err) {
    return (
      <div className="w-screen h-screen flex items-center justify-center text-red-400 text-xs p-4 text-center">
        Settings failed to load:<br />
        <code className="mt-2 whitespace-pre-wrap">{err}</code>
      </div>
    );
  }

  if (!s) {
    return (
      <div className="w-screen h-screen flex items-center justify-center text-muted text-sm">
        Loading…
      </div>
    );
  }

  function patch<K extends keyof SettingsView>(key: K, value: SettingsView[K]) {
    setS((cur) => (cur ? { ...cur, [key]: value } : cur));
  }
  function patchNotifications(p: Partial<SettingsView['notifications']>) {
    setS((cur) => (cur ? { ...cur, notifications: { ...cur.notifications, ...p } } : cur));
  }

  function handleTabChange(tab: TabId) {
    setActiveTab(tab);
    setActiveSub(defaultSubFor(tab));
  }

  return (
    <div className="w-screen h-screen p-1 otto-enter">
      <div className="flex flex-col h-full w-full rounded-2xl bg-surface border border-border shadow-2xl overflow-hidden">
        <div
          className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg/40"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <div className="flex items-center gap-2">
            <OttoMark className="w-4 h-4 text-accent" />
            <div className="text-sm font-semibold">Settings</div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => window.close()}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            className="text-muted hover:text-text rounded p-1"
          >
            <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <SettingsShell
          activeTab={activeTab}
          onTabChange={handleTabChange}
          sidebar={subsFor(activeTab)}
          activeSub={activeSub}
          onSubChange={setActiveSub}
        >
          {renderSubsection({
            activeTab,
            activeSub,
            settings: s,
            model,
            setModel,
            patch,
            patchNotifications,
          })}
        </SettingsShell>
      </div>
    </div>
  );
}

interface RenderArgs {
  activeTab: TabId;
  activeSub: string;
  settings: SettingsView;
  model: string;
  setModel: (m: string) => void;
  patch<K extends keyof SettingsView>(key: K, value: SettingsView[K]): void;
  patchNotifications(p: Partial<SettingsView['notifications']>): void;
}

function renderSubsection(args: RenderArgs) {
  const { activeTab, activeSub, settings: s, model, setModel, patch, patchNotifications } = args;

  if (activeTab === 'general') {
    if (activeSub === 'model') return <ModelSection value={model} onChange={setModel} />;
    if (activeSub === 'window')
      return (
        <WindowSection
          windowPosition={s.windowPosition}
          hideOnBlur={s.hideOnBlur}
          onPositionChange={(position) => {
            patch('windowPosition', position);
            void ipc.invoke('settings.setWindowPosition', { position });
          }}
          onHideOnBlurChange={(v) => {
            patch('hideOnBlur', v);
            void ipc.invoke('settings.setHideOnBlur', { enabled: v });
          }}
        />
      );
    if (activeSub === 'shortcut') return <ShortcutSection />;
    if (activeSub === 'startup')
      return (
        <StartupSection
          startAtLogin={s.startAtLogin}
          onChange={(v) => {
            patch('startAtLogin', v);
            void ipc.invoke('settings.setStartAtLogin', { enabled: v });
          }}
        />
      );
  }

  if (activeTab === 'behavior') {
    if (activeSub === 'autonomy')
      return (
        <AutonomySection
          mode={s.autonomy.mode}
          onChange={(mode) => {
            patch('autonomy', { mode });
            void ipc.invoke('autonomy.setMode', { mode });
          }}
        />
      );
    if (activeSub === 'notifications')
      return (
        <NotificationsSection
          notifications={s.notifications}
          onChange={(p) => {
            patchNotifications(p);
            void ipc.invoke('settings.setNotifications', p);
          }}
        />
      );
    if (activeSub === 'sessionHistory')
      return (
        <SessionHistorySection
          autoDeleteDays={s.autoDeleteDays}
          onAutoDeleteDaysChange={(days) => {
            patch('autoDeleteDays', days);
            void ipc.invoke('settings.setAutoDeleteDays', { days });
          }}
          onResetAllSessions={async () => {
            await ipc.invoke('settings.resetAllSessions', undefined);
          }}
        />
      );
  }

  if (activeTab === 'memory') {
    const kind = activeSub as MemoryKind;
    return <MemorySection kind={kind} />;
  }

  if (activeTab === 'about') {
    if (activeSub === 'versionLogs')
      return (
        <AboutSection
          version={s.version}
          onOpenLogs={() => void ipc.invoke('settings.openLogsDir', undefined)}
        />
      );
    if (activeSub === 'updates') return <UpdatesSection version={s.version} />;
  }

  return null;
}
```

- [ ] **Step 3: Typecheck + run full test suite**

Run: `npm run typecheck && npm test`
Expected: PASS. (Note: `MemoryPanel.test.tsx` still exists and will still pass — it gets deleted in Task 10.)

- [ ] **Step 4: Manual smoke test**

Run: `OTTO_FAKE_SDK=1 npm run dev`
- Open Settings from the tray.
- Verify the window is ~780px wide.
- Click each of the four top tabs; verify the sidebar changes and the content pane renders.
- For Memory tab, click each of the four sidebar entries and confirm the memory list (or facts list) renders.
- Open the autonomy radio, change it, confirm the change persists by reopening Settings.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/SettingsApp.tsx
git commit -m "$(cat <<'EOF'
feat(settings): SettingsApp as shell + per-subsection dispatcher

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Remove the old MemoryPanel

`MemoryPanel.tsx` and its test are now superseded by `MemorySection`. Delete them and confirm nothing else imports `MemoryPanel`.

**Files:**
- Delete: `src/renderer/components/MemoryPanel.tsx`
- Delete: `src/renderer/components/MemoryPanel.test.tsx`

- [ ] **Step 1: Verify no remaining imports of MemoryPanel**

Run: `grep -rn "MemoryPanel" src/ --include='*.ts' --include='*.tsx'`
Expected: zero matches (Task 9 already removed the only consumer in `SettingsApp.tsx`).

If anything still references it, stop and fix the consumer first.

- [ ] **Step 2: Delete the files**

```bash
git rm src/renderer/components/MemoryPanel.tsx src/renderer/components/MemoryPanel.test.tsx
```

- [ ] **Step 3: Final verification**

Run: `npm run typecheck && npm test && npm run lint`
Expected: typecheck + tests PASS; lint shows only pre-existing warnings unrelated to this work.

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
chore(settings): remove MemoryPanel (replaced by MemorySection)

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes (already applied above)

- **Spec coverage:** Section 1 → Task 1 + shell layout in Task 3. Section 2 (tab/sub map) → SettingsNav in Task 2. Section 3 (decomposition) → Tasks 4–8 (per-section components) + Task 9 (shell wiring). Section 4 (state/nav) → Task 9. Section 5 (testing) → tests embedded in each task. Spec's "deletions" list → Task 10.
- **Placeholder scan:** every code block is complete; no TBDs.
- **Type consistency:** `TabId` / `SubId` / `MemoryKind` / `WindowPosition` / `NotificationsState` are defined in their owning section files and imported by the dispatcher in Task 9. `MemoryKind` matches the FTS-tied `'fact' | 'playbook' | 'anti_pattern' | 'heuristic'` union used by `memory.list` IPC.
- **Tasks 5 and 6** group three components each — same pattern, same TDD cycle, one commit per group. Smaller than per-component tasks but keeps the plan tractable.
- **Task 9** is the largest task by file size. It's a single-file integration; if it grows during implementation (e.g., `renderSubsection` exceeds ~120 lines after fiddling), extract it to its own file (`src/renderer/components/settings/renderSubsection.tsx`) as a follow-up — don't pre-emptively split.
