# Settings Window Redesign — Design

**Date:** 2026-05-23
**Status:** Draft for implementation

## Goal

Replace the current single-scroll settings window with a two-level navigation: four top tabs, each with a left sidebar of subsections and a content pane. Wider window (780×720, still fixed). Per-subsection components so each settings area is small and independently testable.

## Non-goals

- Resizable settings window.
- Remembering last-viewed subsection across window reopens.
- Keyboard nav beyond standard tab focus.
- URL hash routing / deep-linkable subsections.
- Changing any settings behavior, IPC contract, or persisted data shape.

## Section 1 — Window + shell

- `src/main/settings-window.ts` — change `WIDTH = 520` to `WIDTH = 780`. Height (`720`) and the rest of the `BrowserWindow` config (frameless, transparent, non-resizable) unchanged.
- The outer `SettingsApp` card structure (rounded `bg-surface` shell with draggable header containing the OttoMark + title + close button) is preserved verbatim — only the body changes.
- The body becomes:
  - A new horizontal **top-tabs row** directly under the header. Four pill buttons: General · Behavior · Memory · About. Active tab uses the accent color background; inactive tabs use `text-muted bg-bg/40 hover:text-text`. Matches the existing radio-group button style.
  - Below the tabs: a **2-column grid** — sidebar `180px`, content `1fr`, divided by a 1px `border-border` line. Each pane scrolls independently when content overflows.

## Section 2 — Tab + subsection map

**General**
- Model
- Window (combines current position radio + hideOnBlur toggle)
- Shortcut (the existing `ShortcutSection`)
- Startup (the current System → Start at login toggle, renamed)

**Behavior**
- Autonomy
- Notifications
- Session history (auto-delete days + "Delete all sessions" danger button)

**Memory**
- Facts
- Playbooks
- Anti-patterns
- Heuristics

The Memory tab's sidebar entries replace `MemoryPanel`'s current internal tab strip. The kind picker moves up into the outer sidebar; what used to be a tabbed panel becomes a kind-scoped view (search box, list, edit/archive/delete + the existing modals).

**About**
- Version & logs (current About section: version string + "Open logs folder" link)
- Updates (the existing `UpdaterSection`)

Total: 4 top tabs, 12 subsections. Default landing: General → Model.

## Section 3 — Component decomposition

### New shell

- `src/renderer/SettingsApp.tsx` — owns `SettingsView` state, `activeTab` + `activeSub`. Renders the header (unchanged), passes `activeTab` / `activeSub` plus the selection callbacks into `SettingsShell`, and renders the right subsection component in the content slot via a switch on `(activeTab, activeSub)`. No inline subsection JSX.
- `src/renderer/components/settings/SettingsShell.tsx` — pure presentational. Props: `{ activeTab, onTabChange, sidebar: Array<{ id, label }>, activeSub, onSubChange, children }`. Renders the top-tabs row, sidebar, content slot. Stateless.
- `src/renderer/components/settings/SettingsNav.ts` — pure data + types:
  ```ts
  export type TabId = 'general' | 'behavior' | 'memory' | 'about';
  export type SubId = string;
  export interface SubEntry { id: SubId; label: string }
  export interface TabEntry { id: TabId; label: string; subs: SubEntry[] }
  export const TABS: TabEntry[] = [/* … */];
  export function defaultSubFor(tab: TabId): SubId { /* first sub of tab */ }
  ```

### New per-subsection components (under `src/renderer/components/settings/`)

- `ModelSection.tsx` — props: `{ value: string; onChange: (m: string) => void }`. Wraps existing `ModelSwitcher`.
- `WindowSection.tsx` — props: `{ windowPosition; hideOnBlur; onPositionChange; onHideOnBlurChange }`. Holds the position radio + hideOnBlur toggle (current Window section body).
- `ShortcutSection.tsx` — already exists at `src/renderer/components/ShortcutSection.tsx`. Move to `src/renderer/components/settings/ShortcutSection.tsx` and update the one import in `SettingsApp.tsx`.
- `StartupSection.tsx` — props: `{ startAtLogin; onChange }`. Single toggle.
- `AutonomySection.tsx` — props: `{ mode; onChange }`. The autonomy radio group body.
- `NotificationsSection.tsx` — props: `{ notifications; onChange }`. Three toggles.
- `SessionHistorySection.tsx` — props: `{ autoDeleteDays; onAutoDeleteDaysChange; onResetAllSessions }`. NumberField + DangerButton.
- `MemorySection.tsx` — props: `{ kind: 'fact' | 'playbook' | 'anti_pattern' | 'heuristic' }`. Replaces the current `MemoryPanel.tsx`. Renders search box, list (or facts list), Edit/Archive/Delete actions, the editing modal, and the facts-editor modal. Loads via `memory.list` whenever `kind` or `query` changes.
- `AboutSection.tsx` — props: `{ version: string; onOpenLogs: () => void }`.
- `UpdatesSection.tsx` — wraps the existing `UpdaterSection` so the file naming is consistent within the settings folder. Takes the same `appVersion` prop.

### Deletions

- `src/renderer/components/MemoryPanel.tsx` — logic moves into `MemorySection`.
- `src/renderer/components/MemoryPanel.test.tsx` — assertions port to `MemorySection.test.tsx`.

### Imports moved

`SettingsApp.tsx` no longer imports `MemoryPanel`, `UpdaterSection`, `ShortcutSection` directly — those go via the new settings folder.

## Section 4 — State, navigation, persistence

**State owned by `SettingsApp`:**

```ts
const [activeTab, setActiveTab] = useState<TabId>('general');
const [activeSub, setActiveSub] = useState<SubId>(defaultSubFor('general')); // 'model'
const [s, setS] = useState<SettingsView | null>(null);
```

**Navigation rules:**

- Clicking a top tab → set `activeTab`, reset `activeSub` to that tab's default first subsection.
- Clicking a sidebar entry → set `activeSub`.
- Selections are in-memory only; settings always opens on General → Model.

**Keyboard:**

- `Esc` closes the window (existing behavior at the window level — no change).
- Tab/Shift-Tab cycles focus through interactive controls in normal DOM order.
- No bespoke arrow-key nav for tabs/sidebar in v1; standard focus rings are sufficient.

**Content rendering:** a switch in `SettingsApp` on `${activeTab}/${activeSub}` returns the right subsection component, fed only the slice of `SettingsView` and setter callbacks it needs.

## Section 5 — Testing

- `SettingsShell.test.tsx` — renders chrome with given tabs/sidebar; clicking a top tab fires `onTabChange`; clicking a sidebar entry fires `onSubChange`; the active tab and active sub get a visually-distinguishing class (`aria-selected="true"` or equivalent).
- `SettingsApp.test.tsx` — extend the existing test (if any) or create new. Mount with a mocked `settings.get` payload; assert default landing is General → Model; clicking the Behavior tab switches the content to Autonomy; clicking Memory → Playbooks renders the playbooks list (with a mocked `memory.list` response).
- `MemorySection.test.tsx` — port the three existing `MemoryPanel.test.tsx` assertions (load default kind, list rendering, archive flow) so coverage isn't lost. The "switches to Facts tab" test becomes "renders facts when kind='fact'".
- Per-subsection smoke tests for the thin wrappers (`ModelSection`, `StartupSection`, `AboutSection`): one render + one interaction asserting the correct `ipc.invoke` channel is called.
- No snapshot tests. No new E2E.

## Files added / changed

**New:**
- `src/renderer/components/settings/SettingsShell.tsx`
- `src/renderer/components/settings/SettingsShell.test.tsx`
- `src/renderer/components/settings/SettingsNav.ts`
- `src/renderer/components/settings/ModelSection.tsx` (+ test)
- `src/renderer/components/settings/WindowSection.tsx` (+ test)
- `src/renderer/components/settings/StartupSection.tsx` (+ test)
- `src/renderer/components/settings/AutonomySection.tsx` (+ test)
- `src/renderer/components/settings/NotificationsSection.tsx` (+ test)
- `src/renderer/components/settings/SessionHistorySection.tsx` (+ test)
- `src/renderer/components/settings/MemorySection.tsx`
- `src/renderer/components/settings/MemorySection.test.tsx`
- `src/renderer/components/settings/AboutSection.tsx` (+ test)
- `src/renderer/components/settings/UpdatesSection.tsx`
- `src/renderer/components/settings/ShortcutSection.tsx` (moved)

**Changed:**
- `src/main/settings-window.ts` — `WIDTH` 520 → 780.
- `src/renderer/SettingsApp.tsx` — gutted body; now thin shell + state owner + switch dispatcher.
- `src/renderer/SettingsApp.test.tsx` (if it exists) — updated assertions.

**Deleted:**
- `src/renderer/components/MemoryPanel.tsx`
- `src/renderer/components/MemoryPanel.test.tsx`
- `src/renderer/components/ShortcutSection.tsx` (moved into settings/)
- `src/renderer/components/UpdaterSection.tsx` is NOT deleted — only re-exported via `UpdatesSection.tsx` wrapper to avoid a sprawling rename. (If touching it feels low-risk during implementation, the wrapper can be skipped and `UpdaterSection` used directly.)

## Open questions deferred to implementation

- Whether the About tab's two-subsection sidebar feels right or should collapse — defer to dogfooding after first build.
- Exact pill-button vs underlined-tab visual for the top-tabs row — pick whichever matches the existing component vocabulary best when implementing.
