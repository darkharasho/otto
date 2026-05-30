# Tier 3 Floating Chat Window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third window tier — a draggable, resizable, always-on-top chat-app window with a left conversation sidebar — that reuses today's MessageList + CommandBar + OttoMark.

**Architecture:** Extend the existing `WindowMode` (`'bar' | 'panel'` → `'bar' | 'panel' | 'chat'`). Main process gains chat-mode handling in `WindowManager`: skips anchored positioning, applies remembered bounds, forces hide-on-blur off, persists move/resize. Renderer gets a new `ChatWindow` component rendering when `windowMode === 'chat'`, plus a sidebar built from the existing session store. Tier transitions stay renderer-driven via existing `window.setMode` IPC.

**Tech Stack:** Electron, React 18, TypeScript, Tailwind, Zustand, vitest, Playwright.

---

## File Structure

### New files
- `src/renderer/components/ChatWindow.tsx` — Tier 3 root (titlebar + sidebar + main split).
- `src/renderer/components/ChatTitlebar.tsx` — Drag region, OttoMark, session header, live pill, kbd hints, min/max controls.
- `src/renderer/components/ConversationSidebar.tsx` — Sidebar shell (header, CTA, search, scroll body, footer).
- `src/renderer/components/ConversationSidebarItem.tsx` — One row.
- `src/renderer/components/ConversationGroup.tsx` — Section heading + children.
- `src/renderer/lib/conversation-grouping.ts` — Pure functions: bucketing, status mapping, tool-glyph extraction.
- `src/renderer/lib/conversation-grouping.test.ts` — Tests for the above.
- `src/main/window.test.ts` — Unit tests for chat-mode behavior in `WindowManager`.
- `tests/tier3-chat.spec.ts` — Playwright E2E for promotion / drag / collapse / restore.

### Modified files
- `src/shared/ipc-contract.ts` — Extend `WindowMode`; add `chatBounds`, `lastVisibleMode`, `pinnedSessionIds` to `SettingsView` and the persisted shape.
- `src/main/window.ts` — `applyMode('chat')`, bounds persistence, last-visible-mode tracking, off-screen rejection, hide-on-blur override.
- `src/main/ipc/handlers.ts` — Accept `'chat'` in `window.setMode`; expose pin/unpin handlers if not already present (add minimal handlers for `window.pinSession` / `window.unpinSession`).
- `src/main/index.ts` — Wire bounds-persist callback and last-visible-mode load on startup.
- `src/renderer/store.ts` (or wherever `useOttoStore` lives) — Accept `'chat'` in window-mode type; expose `pinnedSessionIds`.
- `src/renderer/App.tsx` — Branch on `windowMode === 'chat'` to render `ChatWindow`. Extend ↑ handler (panel → chat), add ↓ handler (chat → panel). Update Escape handler (chat → panel, panel → bar, bar → hide).
- `src/renderer/index.css` — `.otto-app-drag` / `.otto-app-no-drag` utility classes for `-webkit-app-region`.

---

## Task 1: Extend `WindowMode` type

**Files:**
- Modify: `src/shared/ipc-contract.ts`

- [ ] **Step 1: Extend the literal type**

Open `src/shared/ipc-contract.ts`. Find the `window.setMode` IPC request literal. It currently constrains `mode` to `'bar' | 'panel'`. Change it to `'bar' | 'panel' | 'chat'`. If there's a standalone `WindowMode` export, update it the same way. If not, add one near the top:

```ts
export type WindowMode = 'bar' | 'panel' | 'chat';
```

and replace inline `'bar' | 'panel'` usages with `WindowMode` for clarity.

- [ ] **Step 2: Run type-check to verify nothing else broke**

Run: `pnpm tsc --noEmit`
Expected: zero errors (any new errors point to call sites we'll touch in later tasks).

- [ ] **Step 3: Commit**

```bash
git add src/shared/ipc-contract.ts
git commit -m "feat(window): extend WindowMode with 'chat'"
```

---

## Task 2: Extend `SettingsView` with chat-tier persistence fields

**Files:**
- Modify: `src/shared/ipc-contract.ts`

- [ ] **Step 1: Add fields to `SettingsView`**

Add three new fields to `SettingsView`:

```ts
export interface ChatBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SettingsView {
  // ...existing fields...
  chatBounds: ChatBounds | null;
  lastVisibleMode: WindowMode;
  pinnedSessionIds: string[];
}
```

- [ ] **Step 2: Update settings defaults wherever they're constructed**

Run `pnpm grep -n "windowPosition: 'bottom-center'" src/` to find every place a default `SettingsView` is constructed. Add the three new fields to each default literal:

```ts
chatBounds: null,
lastVisibleMode: 'bar',
pinnedSessionIds: [],
```

- [ ] **Step 3: Verify type-check**

Run: `pnpm tsc --noEmit`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/shared/ipc-contract.ts src/main
git commit -m "feat(settings): persist chatBounds, lastVisibleMode, pinnedSessionIds"
```

---

## Task 3: `WindowManager` — failing test for chat-mode bounds application

**Files:**
- Create: `src/main/window.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WindowManager } from './window';

// Minimal BrowserWindow stub
function makeFakeWin() {
  const state: { bounds: Electron.Rectangle; minSize: [number, number] | null } = {
    bounds: { x: 0, y: 0, width: 640, height: 72 },
    minSize: null,
  };
  return {
    state,
    setBounds: vi.fn((b) => { state.bounds = { ...state.bounds, ...b }; }),
    getBounds: vi.fn(() => state.bounds),
    setMinimumSize: vi.fn((w: number, h: number) => { state.minSize = [w, h]; }),
    isVisible: vi.fn(() => true),
    isFocused: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
    show: vi.fn(),
    hide: vi.fn(),
    focus: vi.fn(),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    removeMenu: vi.fn(),
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    on: vi.fn(),
    webContents: { setWindowOpenHandler: vi.fn(), on: vi.fn() },
  };
}

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  screen: {
    getAllDisplays: () => [
      { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    ],
    getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getDisplayNearestPoint: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
  app: { isPackaged: true, getAppPath: () => '/app' },
  shell: { openExternal: vi.fn() },
}));

describe('WindowManager chat mode', () => {
  let mgr: WindowManager;
  let fake: ReturnType<typeof makeFakeWin>;

  beforeEach(() => {
    mgr = new WindowManager();
    fake = makeFakeWin();
    // Inject the fake window — WindowManager exposes a private `window` we set via test helper
    (mgr as unknown as { window: typeof fake }).window = fake;
  });

  it('applies remembered bounds when entering chat mode', () => {
    mgr.setChatBounds({ x: 100, y: 200, width: 1000, height: 700 });
    mgr.setMode('chat');
    expect(fake.setBounds).toHaveBeenCalledWith({ x: 100, y: 200, width: 1000, height: 700 });
  });

  it('applies default centered bounds when no remembered bounds', () => {
    mgr.setChatBounds(null);
    mgr.setMode('chat');
    const call = fake.setBounds.mock.calls.at(-1)![0];
    expect(call.width).toBe(960);
    expect(call.height).toBe(620);
    // Centered on 1920x1080
    expect(call.x).toBe(Math.round((1920 - 960) / 2));
    expect(call.y).toBe(Math.round((1080 - 620) / 2));
  });

  it('sets minimum size when entering chat mode', () => {
    mgr.setMode('chat');
    expect(fake.setMinimumSize).toHaveBeenCalledWith(560, 400);
  });

  it('falls back to default when remembered bounds are off all displays', () => {
    mgr.setChatBounds({ x: 5000, y: 5000, width: 800, height: 600 });
    mgr.setMode('chat');
    const call = fake.setBounds.mock.calls.at(-1)![0];
    expect(call.width).toBe(960);
    expect(call.x).toBe(Math.round((1920 - 960) / 2));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/window.test.ts`
Expected: FAIL — `mgr.setChatBounds is not a function` (and chat-mode branch missing).

- [ ] **Step 3: Commit the failing test**

```bash
git add src/main/window.test.ts
git commit -m "test(window): failing tests for chat-mode bounds + min size"
```

---

## Task 4: `WindowManager` — implement chat-mode

**Files:**
- Modify: `src/main/window.ts`

- [ ] **Step 1: Add chat-mode constants and bounds field**

At the top of the file (near other constants), add:

```ts
const CHAT_DEFAULT_WIDTH = 960;
const CHAT_DEFAULT_HEIGHT = 620;
const CHAT_MIN_WIDTH = 560;
const CHAT_MIN_HEIGHT = 400;
```

Inside the class, near the other private fields, add:

```ts
private chatBounds: { x: number; y: number; width: number; height: number } | null = null;
private chatBoundsChangeListeners: Array<(b: { x: number; y: number; width: number; height: number }) => void> = [];
```

Update `WindowMode`:

```ts
export type WindowMode = 'bar' | 'panel' | 'chat';
```

- [ ] **Step 2: Add public setters and accessors**

Add to the class body:

```ts
setChatBounds(bounds: { x: number; y: number; width: number; height: number } | null): void {
  this.chatBounds = bounds;
}

getChatBounds(): { x: number; y: number; width: number; height: number } | null {
  return this.chatBounds;
}

onChatBoundsChanged(cb: (b: { x: number; y: number; width: number; height: number }) => void): () => void {
  this.chatBoundsChangeListeners.push(cb);
  return () => {
    this.chatBoundsChangeListeners = this.chatBoundsChangeListeners.filter((l) => l !== cb);
  };
}

private emitChatBounds(bounds: { x: number; y: number; width: number; height: number }): void {
  for (const cb of this.chatBoundsChangeListeners) cb(bounds);
}

private isOnAnyDisplay(b: { x: number; y: number; width: number; height: number }): boolean {
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    return b.x < wa.x + wa.width && b.x + b.width > wa.x && b.y < wa.y + wa.height && b.y + b.height > wa.y;
  });
}

private defaultChatBounds(display: Electron.Display): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.round(display.workArea.x + (display.workArea.width - CHAT_DEFAULT_WIDTH) / 2),
    y: Math.round(display.workArea.y + (display.workArea.height - CHAT_DEFAULT_HEIGHT) / 2),
    width: CHAT_DEFAULT_WIDTH,
    height: CHAT_DEFAULT_HEIGHT,
  };
}
```

- [ ] **Step 3: Extend `applyMode` with a chat branch**

Replace the body of `applyMode` so the chat branch returns early without using anchored positioning:

```ts
private applyMode(mode: WindowMode): void {
  if (!this.window) return;
  this.mode = mode;

  if (mode === 'chat') {
    this.window.setMinimumSize(CHAT_MIN_WIDTH, CHAT_MIN_HEIGHT);
    const display = this.pickDisplay();
    const target = this.chatBounds && this.isOnAnyDisplay(this.chatBounds)
      ? this.chatBounds
      : this.defaultChatBounds(display);
    this.window.setBounds(target);
    logger.debug(`window mode → chat (${target.width}x${target.height} @ ${target.x},${target.y})`);
    return;
  }

  // Existing bar/panel logic (preserved verbatim):
  const display = this.pickDisplay();
  const maxPanelHeight = Math.floor(display.workArea.height * PANEL_MAX_DISPLAY_RATIO);
  const height =
    mode === 'bar' ? BAR_HEIGHT : Math.max(PANEL_MIN_HEIGHT, Math.min(maxPanelHeight, 520));
  const { x, y } = this.bottomCenter(display.workArea, BAR_WIDTH, height);
  this.window.setBounds({ x, y, width: BAR_WIDTH, height });
  logger.debug(`window mode → ${mode} (${BAR_WIDTH}x${height} @ ${x},${y})`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/window.test.ts`
Expected: PASS — all four chat-mode tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/window.ts
git commit -m "feat(window): chat-mode applies remembered or default bounds with min size"
```

---

## Task 5: `WindowManager` — debounced bounds persistence on move/resize

**Files:**
- Modify: `src/main/window.ts`
- Modify: `src/main/window.test.ts`

- [ ] **Step 1: Add a failing test**

Append to `src/main/window.test.ts`:

```ts
import { vi as v2 } from 'vitest';

describe('WindowManager bounds persistence', () => {
  it('emits chatBoundsChanged after a debounced move when in chat mode', async () => {
    v2.useFakeTimers();
    const mgr = new WindowManager();
    const fake = makeFakeWin();
    (mgr as unknown as { window: typeof fake }).window = fake;

    const seen: Array<{ x: number; y: number; width: number; height: number }> = [];
    mgr.onChatBoundsChanged((b) => seen.push(b));
    mgr.setMode('chat');

    // Capture the move handler registered on the window
    const moveHandler = fake.on.mock.calls.find(([evt]) => evt === 'move')?.[1] as (() => void) | undefined;
    expect(moveHandler).toBeDefined();
    fake.state.bounds = { x: 50, y: 60, width: 1000, height: 700 };
    moveHandler!();

    v2.advanceTimersByTime(300);
    expect(seen.at(-1)).toEqual({ x: 50, y: 60, width: 1000, height: 700 });
    v2.useRealTimers();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/main/window.test.ts`
Expected: FAIL — no `move` handler registered.

- [ ] **Step 3: Register move/resize handlers in `create()`**

In `WindowManager.create()`, after the existing `win.on('blur', ...)` block, add:

```ts
let persistTimer: NodeJS.Timeout | null = null;
const schedulePersist = (): void => {
  if (this.mode !== 'chat') return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const b = win.getBounds();
    this.chatBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    this.emitChatBounds(this.chatBounds);
  }, 250);
};
win.on('move', schedulePersist);
win.on('resize', schedulePersist);
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/main/window.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/window.ts src/main/window.test.ts
git commit -m "feat(window): debounced chat-bounds persistence on move/resize"
```

---

## Task 6: `WindowManager` — hide-on-blur override + last-visible-mode tracking

**Files:**
- Modify: `src/main/window.ts`
- Modify: `src/main/window.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/main/window.test.ts`:

```ts
describe('WindowManager chat-mode behavior overrides', () => {
  it('does not hide on blur when in chat mode even with hideOnBlur=true', () => {
    const mgr = new WindowManager();
    const fake = makeFakeWin();
    (mgr as unknown as { window: typeof fake }).window = fake;
    mgr.setHideOnBlur(true);
    mgr.setMode('chat');
    const blur = fake.on.mock.calls.find(([evt]) => evt === 'blur')?.[1] as (() => void) | undefined;
    blur?.();
    expect(fake.hide).not.toHaveBeenCalled();
  });

  it('tracks lastVisibleMode after show', () => {
    const mgr = new WindowManager();
    const fake = makeFakeWin();
    (mgr as unknown as { window: typeof fake }).window = fake;
    fake.isVisible.mockReturnValue(false);
    mgr.show('chat');
    expect(mgr.getLastVisibleMode()).toBe('chat');
  });

  it('show() with no mode resumes lastVisibleMode', () => {
    const mgr = new WindowManager();
    const fake = makeFakeWin();
    (mgr as unknown as { window: typeof fake }).window = fake;
    mgr.setLastVisibleMode('chat');
    fake.isVisible.mockReturnValue(false);
    mgr.show();
    expect(mgr.getMode()).toBe('chat');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/main/window.test.ts`
Expected: FAIL — methods missing, blur still triggers hide.

- [ ] **Step 3: Add `lastVisibleMode` fields and methods**

Inside the class, near other private fields:

```ts
private lastVisibleMode: WindowMode = 'bar';

setLastVisibleMode(m: WindowMode): void { this.lastVisibleMode = m; }
getLastVisibleMode(): WindowMode { return this.lastVisibleMode; }
```

Update `show()` to accept optional mode and default to `lastVisibleMode`:

```ts
show(mode?: WindowMode): void {
  if (!this.window) return;
  const target = mode ?? this.lastVisibleMode;
  this.applyMode(target);
  this.window.show();
  if (target !== 'chat') this.repositionBottomCenter();
  this.window.focus();
  this.lastVisibleMode = target;
}
```

(`toggle()` already calls `show(mode)` — keep its existing parameter; it still works.)

Update the blur handler in `create()` so it ignores blur in chat mode:

```ts
win.on('blur', () => {
  if (this.mode === 'chat') return;
  if (this.hideOnBlur && this.window?.isVisible()) this.hide();
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/main/window.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/window.ts src/main/window.test.ts
git commit -m "feat(window): chat mode disables hide-on-blur; track lastVisibleMode"
```

---

## Task 7: IPC handler accepts `'chat'`; main wires bounds persistence

**Files:**
- Modify: `src/main/ipc/handlers.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Allow `'chat'` in `window.setMode` handler**

Open `src/main/ipc/handlers.ts`. Find the `window.setMode` handler. The mode payload is now `WindowMode`. If the handler narrows with a Zod schema or manual check, extend it to include `'chat'`. Concretely, replace any `mode === 'bar' || mode === 'panel'` guards with the `WindowMode` literal.

- [ ] **Step 2: Persist chat bounds on change**

Open `src/main/index.ts`. After the `WindowManager` is constructed and the renderer has loaded settings, add:

```ts
window.onChatBoundsChanged((b) => {
  void settings.update((s) => ({ ...s, chatBounds: b }));
});
window.onVisibilityChange((visible) => {
  if (visible) void settings.update((s) => ({ ...s, lastVisibleMode: window.getMode() }));
});
```

(Replace `settings.update` with whatever the actual settings-store mutation API is — look up the existing call site for `windowPosition` or `hideOnBlur` updates and mirror it.)

- [ ] **Step 3: Load remembered bounds and last-visible-mode at startup**

Where settings are first read into the manager (look for existing `setHideOnBlur(settings.hideOnBlur)` etc.), add:

```ts
window.setChatBounds(settings.chatBounds);
window.setLastVisibleMode(settings.lastVisibleMode);
```

- [ ] **Step 4: Type-check + run main tests**

Run: `pnpm tsc --noEmit && pnpm vitest run src/main`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/main
git commit -m "feat(ipc): accept 'chat' mode; persist bounds + lastVisibleMode"
```

---

## Task 8: Renderer store accepts `'chat'`; add pinned-session state

**Files:**
- Modify: store file used by `useOttoStore` (find via `grep -l useOttoStore src/renderer`)

- [ ] **Step 1: Find the store**

Run: `pnpm grep -n "windowMode:.*'bar'" src/renderer | head`

- [ ] **Step 2: Extend the windowMode type**

Change the windowMode field's type from `'bar' | 'panel'` to import `WindowMode` from `src/shared/ipc-contract` and use it. Update `setWindowMode` similarly.

- [ ] **Step 3: Add pinned-session state**

Add to the store:

```ts
pinnedSessionIds: string[];
setPinnedSessionIds: (ids: string[]) => void;
togglePinned: (id: string) => void;
```

Initial state: `pinnedSessionIds: []`. Implementations:

```ts
setPinnedSessionIds: (ids) => set({ pinnedSessionIds: ids }),
togglePinned: (id) => set((s) => ({
  pinnedSessionIds: s.pinnedSessionIds.includes(id)
    ? s.pinnedSessionIds.filter((x) => x !== id)
    : [...s.pinnedSessionIds, id],
})),
```

- [ ] **Step 4: Hydrate pinned IDs at startup**

Where the store is hydrated from settings on app boot (look for where `windowPosition` etc. land in the renderer), set `pinnedSessionIds` from `settings.pinnedSessionIds`.

Add a single IPC round-trip to persist on toggle. In the same store init:

```ts
// After togglePinned mutates state, also persist:
// Easiest: subscribe in a `useEffect` from App.tsx — wire in Task 16.
```

- [ ] **Step 5: Type-check**

Run: `pnpm tsc --noEmit`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer
git commit -m "feat(store): accept 'chat' window mode; add pinned-session state"
```

---

## Task 9: Pure sidebar logic — failing tests

**Files:**
- Create: `src/renderer/lib/conversation-grouping.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import {
  groupSessions,
  sessionStatusDot,
  recentToolGlyphs,
  type SidebarSession,
} from './conversation-grouping';

const now = new Date('2026-05-28T12:00:00Z').getTime();
const ms = (mins: number) => now - mins * 60 * 1000;

const s = (id: string, updatedAt: number, extra: Partial<SidebarSession> = {}): SidebarSession => ({
  id, title: id, updatedAt, state: 'idle', recentToolNames: [], ...extra,
});

describe('groupSessions', () => {
  it('places pinned first, then time buckets', () => {
    const sessions = [
      s('a', ms(10)),                  // today
      s('b', ms(60 * 26)),              // yesterday (≈26h ago)
      s('c', ms(60 * 24 * 8)),          // earlier
      s('d', ms(5)),                    // today, pinned
    ];
    const groups = groupSessions(sessions, ['d'], now);
    expect(groups.map((g) => g.label)).toEqual(['Pinned', 'Today', 'Yesterday', 'Earlier']);
    expect(groups[0].items.map((x) => x.id)).toEqual(['d']);
    expect(groups[1].items.map((x) => x.id)).toEqual(['a']);
    expect(groups[2].items.map((x) => x.id)).toEqual(['b']);
    expect(groups[3].items.map((x) => x.id)).toEqual(['c']);
  });

  it('omits empty groups', () => {
    const groups = groupSessions([s('a', ms(10))], [], now);
    expect(groups.map((g) => g.label)).toEqual(['Today']);
  });
});

describe('sessionStatusDot', () => {
  it('returns running for active state', () => {
    expect(sessionStatusDot('running')).toBe('running');
  });
  it('returns errored for errored / denied', () => {
    expect(sessionStatusDot('errored')).toBe('errored');
    expect(sessionStatusDot('denied')).toBe('errored');
  });
  it('returns done for done', () => {
    expect(sessionStatusDot('done')).toBe('done');
  });
  it('returns idle for idle', () => {
    expect(sessionStatusDot('idle')).toBe('idle');
  });
});

describe('recentToolGlyphs', () => {
  it('returns the last three unique tool names', () => {
    const out = recentToolGlyphs(['screenshot', 'observe', 'shell', 'screenshot', 'files']);
    expect(out).toEqual(['shell', 'screenshot', 'files']); // last 3 with most-recent uniqueness preserved
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run src/renderer/lib/conversation-grouping.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Commit failing test**

```bash
git add src/renderer/lib/conversation-grouping.test.ts
git commit -m "test(sidebar): failing tests for grouping / status / glyphs"
```

---

## Task 10: Pure sidebar logic — implementation

**Files:**
- Create: `src/renderer/lib/conversation-grouping.ts`

- [ ] **Step 1: Implement**

```ts
export type SessionState = 'idle' | 'running' | 'done' | 'errored' | 'denied';
export type StatusDot = 'idle' | 'running' | 'done' | 'errored';

export interface SidebarSession {
  id: string;
  title: string;
  updatedAt: number;
  state: SessionState;
  recentToolNames: string[];
}

export interface SidebarGroup {
  label: 'Pinned' | 'Today' | 'Yesterday' | 'Earlier';
  items: SidebarSession[];
}

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function groupSessions(
  sessions: SidebarSession[],
  pinnedIds: string[],
  now: number = Date.now()
): SidebarGroup[] {
  const pinnedSet = new Set(pinnedIds);
  const today = startOfDay(now);
  const yesterday = today - 24 * 60 * 60 * 1000;

  const pinned: SidebarSession[] = [];
  const todayItems: SidebarSession[] = [];
  const yesterdayItems: SidebarSession[] = [];
  const earlier: SidebarSession[] = [];

  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const s of sorted) {
    if (pinnedSet.has(s.id)) { pinned.push(s); continue; }
    if (s.updatedAt >= today) todayItems.push(s);
    else if (s.updatedAt >= yesterday) yesterdayItems.push(s);
    else earlier.push(s);
  }

  const groups: SidebarGroup[] = [];
  if (pinned.length) groups.push({ label: 'Pinned', items: pinned });
  if (todayItems.length) groups.push({ label: 'Today', items: todayItems });
  if (yesterdayItems.length) groups.push({ label: 'Yesterday', items: yesterdayItems });
  if (earlier.length) groups.push({ label: 'Earlier', items: earlier });
  return groups;
}

export function sessionStatusDot(state: SessionState): StatusDot {
  if (state === 'running') return 'running';
  if (state === 'errored' || state === 'denied') return 'errored';
  if (state === 'done') return 'done';
  return 'idle';
}

export function recentToolGlyphs(toolNames: string[], max = 3): string[] {
  // Preserve order, keep last `max` distinct names, most recent last.
  const reversed = [...toolNames].reverse();
  const seen = new Set<string>();
  const picks: string[] = [];
  for (const n of reversed) {
    if (seen.has(n)) continue;
    seen.add(n);
    picks.push(n);
    if (picks.length === max) break;
  }
  return picks.reverse();
}
```

- [ ] **Step 2: Run tests**

Run: `pnpm vitest run src/renderer/lib/conversation-grouping.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/lib/conversation-grouping.ts
git commit -m "feat(sidebar): conversation grouping, status mapping, tool glyphs"
```

---

## Task 11: `ConversationSidebarItem` component

**Files:**
- Create: `src/renderer/components/ConversationSidebarItem.tsx`

- [ ] **Step 1: Implement**

```tsx
import { ToolIcon } from './ToolIcon';
import type { SidebarSession, StatusDot } from '../lib/conversation-grouping';

interface Props {
  session: SidebarSession;
  status: StatusDot;
  glyphs: string[];
  active: boolean;
  pinned: boolean;
  subtitle: string;
  onSelect: () => void;
  onTogglePin: () => void;
}

const DOT_COLOR: Record<StatusDot, string> = {
  running: '#7c7dff',
  done: '#3a3b41',
  errored: '#e25555',
  idle: '#3a3b41',
};

export function ConversationSidebarItem({
  session, status, glyphs, active, pinned, subtitle, onSelect, onTogglePin,
}: Props) {
  const baseRow =
    'group relative flex items-center gap-2.5 px-3 py-2 rounded-[9px] cursor-pointer transition-colors';
  const activeRow =
    'border border-[rgba(124,125,255,0.35)] bg-gradient-to-r from-[rgba(124,125,255,0.18)] to-[rgba(124,125,255,0.04)] shadow-[inset_0_0_18px_rgba(124,125,255,0.1),0_4px_14px_rgba(124,125,255,0.06)]';
  const idleRow = 'hover:bg-white/5';

  return (
    <div
      className={`${baseRow} ${active ? activeRow : idleRow}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
    >
      {active && (
        <span
          aria-hidden
          className="absolute left-[-1px] top-2 bottom-2 w-[3px] rounded-[3px]"
          style={{ background: 'linear-gradient(180deg,#7c7dff,#a882ff)', boxShadow: '0 0 10px #7c7dff' }}
        />
      )}
      <span
        aria-hidden
        className={`flex-shrink-0 w-[7px] h-[7px] rounded-full ${status === 'running' ? 'otto-pulse' : ''}`}
        style={{ background: DOT_COLOR[status], boxShadow: status === 'running' ? '0 0 8px #7c7dff' : 'none' }}
      />
      <div className="flex-1 min-w-0">
        <div className={`text-[12px] truncate ${active ? 'text-white font-semibold' : 'text-[#cfd2d8] font-medium'}`}>
          {session.title}
        </div>
        <div className="text-[10px] text-[#6b6e76] mt-[2px]">{subtitle}</div>
      </div>
      <div className="flex gap-[3px] flex-shrink-0">
        {glyphs.map((g) => (
          <span
            key={g}
            title={g}
            className="w-[11px] h-[11px] rounded-[3px] flex items-center justify-center"
            style={{ background: 'rgba(124,125,255,0.18)', border: '1px solid rgba(124,125,255,0.35)' }}
          >
            <ToolIcon name={g} className="w-[8px] h-[8px] text-[#cfd0ff]" />
          </span>
        ))}
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onTogglePin(); }}
        className="opacity-0 group-hover:opacity-100 text-[10px] text-[#9598a0] px-1"
        aria-label={pinned ? 'Unpin' : 'Pin'}
      >
        {pinned ? '★' : '☆'}
      </button>
    </div>
  );
}
```

If `ToolIcon` doesn't expose a `name` prop in this shape, adapt the import to whatever the existing API is (look at how `ToolCallCard.tsx` calls it).

- [ ] **Step 2: Type-check**

Run: `pnpm tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/ConversationSidebarItem.tsx
git commit -m "feat(sidebar): ConversationSidebarItem with active rail + glyphs"
```

---

## Task 12: `ConversationGroup` component

**Files:**
- Create: `src/renderer/components/ConversationGroup.tsx`

- [ ] **Step 1: Implement**

```tsx
import type { ReactNode } from 'react';

interface Props {
  label: 'Pinned' | 'Today' | 'Yesterday' | 'Earlier';
  children: ReactNode;
}

export function ConversationGroup({ label, children }: Props) {
  const isPinned = label === 'Pinned';
  return (
    <>
      <div className="flex items-center gap-1.5 px-2.5 pt-3 pb-1.5">
        {isPinned && (
          <svg width="9" height="9" viewBox="0 0 24 24" fill="#7c7dff" aria-hidden>
            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
          </svg>
        )}
        <span
          className={`text-[9px] uppercase font-bold tracking-[1.4px] ${isPinned ? 'text-[#7c7dff]' : 'text-[#6b6e76]'}`}
        >
          {label}
        </span>
        <span
          className="flex-1 h-px"
          style={{
            background: isPinned
              ? 'linear-gradient(90deg, rgba(124,125,255,0.25), transparent)'
              : 'linear-gradient(90deg, rgba(255,255,255,0.05), transparent)',
          }}
        />
      </div>
      <div className="flex flex-col gap-0.5 px-1.5">{children}</div>
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/components/ConversationGroup.tsx
git commit -m "feat(sidebar): ConversationGroup heading"
```

---

## Task 13: `ConversationSidebar` shell

**Files:**
- Create: `src/renderer/components/ConversationSidebar.tsx`

- [ ] **Step 1: Implement**

```tsx
import { useMemo, useState } from 'react';
import { ConversationGroup } from './ConversationGroup';
import { ConversationSidebarItem } from './ConversationSidebarItem';
import {
  groupSessions,
  recentToolGlyphs,
  sessionStatusDot,
  type SidebarSession,
} from '../lib/conversation-grouping';

interface Props {
  sessions: SidebarSession[];
  activeSessionId: string | null;
  pinnedIds: string[];
  autonomyLabel: string;
  conversationCount: number;
  onNew: () => void;
  onSelect: (id: string) => void;
  onTogglePin: (id: string) => void;
  onOpenSettings: () => void;
}

function formatSubtitle(s: SidebarSession, now: number): string {
  const diff = now - s.updatedAt;
  const mins = Math.round(diff / 60000);
  if (s.state === 'running') return 'Otto is working…';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago${s.state === 'done' ? ' · done' : ''}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago${s.state === 'done' ? ' · done' : ''}`;
  return new Date(s.updatedAt).toLocaleDateString();
}

export function ConversationSidebar({
  sessions, activeSessionId, pinnedIds, autonomyLabel, conversationCount,
  onNew, onSelect, onTogglePin, onOpenSettings,
}: Props) {
  const [query, setQuery] = useState('');
  const now = Date.now();

  const filtered = useMemo(
    () => (query ? sessions.filter((s) => s.title.toLowerCase().includes(query.toLowerCase())) : sessions),
    [sessions, query]
  );
  const groups = useMemo(() => groupSessions(filtered, pinnedIds, now), [filtered, pinnedIds, now]);
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);

  return (
    <aside
      className="flex flex-col relative"
      style={{
        width: 260,
        borderRight: '1px solid rgba(255,255,255,0.04)',
        background: 'linear-gradient(180deg, #0f1014 0%, #0c0d11 100%)',
      }}
    >
      {/* Header */}
      <div className="px-3.5 pt-3.5 pb-3 flex flex-col gap-0.5">
        <div className="text-[10px] text-[#7c7dff] uppercase tracking-[1.4px] font-bold">Workspace</div>
        <div className="text-[13px] text-[#ebecf1] font-semibold">Coworking with Otto</div>
        <div className="text-[11px] text-[#6b6e76]">{conversationCount} conversations · {pinnedIds.length} pinned</div>
      </div>

      {/* New conv */}
      <div className="px-2.5 pb-2.5">
        <button
          type="button"
          onClick={onNew}
          className="w-full flex items-center gap-2 px-2.5 py-2 rounded-[10px] text-[12px] text-[#ebecf1] font-medium"
          style={{
            background: 'linear-gradient(135deg, rgba(124,125,255,0.16), rgba(168,130,255,0.08))',
            border: '1px solid rgba(124,125,255,0.4)',
            boxShadow: '0 0 16px rgba(124,125,255,0.12) inset',
          }}
        >
          <span className="w-5 h-5 rounded-[7px] flex items-center justify-center text-white"
            style={{ background: 'rgba(124,125,255,0.3)' }}>＋</span>
          <span className="flex-1 text-left">New conversation</span>
          <span className="text-[10px] text-[#9598a0] font-mono">⌘N</span>
        </button>
      </div>

      {/* Search */}
      <div className="px-2.5 pb-3">
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-[9px]"
          style={{ background: '#0a0b0e', border: '1px solid #1c1d23' }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#5b5e66" strokeWidth="2.5" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="flex-1 bg-transparent outline-none text-[12px] text-[#cfd2d8] placeholder:text-[#5b5e66]"
          />
        </div>
      </div>

      {/* List */}
      <div className="flex-1 overflow-auto px-1.5 pb-1.5">
        {groups.map((g) => (
          <ConversationGroup key={g.label} label={g.label}>
            {g.items.map((s) => (
              <ConversationSidebarItem
                key={s.id}
                session={s}
                status={sessionStatusDot(s.state)}
                glyphs={recentToolGlyphs(s.recentToolNames)}
                active={s.id === activeSessionId}
                pinned={pinnedSet.has(s.id)}
                subtitle={formatSubtitle(s, now)}
                onSelect={() => onSelect(s.id)}
                onTogglePin={() => onTogglePin(s.id)}
              />
            ))}
          </ConversationGroup>
        ))}
      </div>

      {/* Footer */}
      <div className="px-3 py-2.5 flex items-center gap-2.5"
        style={{ borderTop: '1px solid rgba(255,255,255,0.04)', background: '#0a0b0e' }}>
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-full"
          style={{ background: 'rgba(82,210,126,0.1)', border: '1px solid rgba(82,210,126,0.35)' }}>
          <span className="w-[5px] h-[5px] rounded-full" style={{ background: '#52d27e', boxShadow: '0 0 6px #52d27e' }} />
          <span className="text-[9px] text-[#9be3b3] font-bold tracking-[0.6px]">{autonomyLabel}</span>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onOpenSettings}
          className="w-6 h-6 rounded-[7px] flex items-center justify-center text-[#9598a0] text-[11px]"
          style={{ background: '#15161a', border: '1px solid #2a2b2e' }}
          aria-label="Settings"
        >⚙</button>
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc --noEmit`
Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/ConversationSidebar.tsx
git commit -m "feat(sidebar): ConversationSidebar shell"
```

---

## Task 14: Drag-region CSS utilities

**Files:**
- Modify: `src/renderer/index.css`

- [ ] **Step 1: Append utilities at the end of the file**

```css
.otto-app-drag { -webkit-app-region: drag; }
.otto-app-no-drag { -webkit-app-region: no-drag; }

@keyframes otto-pulse-dot {
  0%, 100% { opacity: 0.65; transform: scale(1); }
  50%      { opacity: 1;   transform: scale(1.18); }
}
.otto-pulse { animation: otto-pulse-dot 1.4s ease-in-out infinite; }
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/index.css
git commit -m "feat(css): app-region drag utilities + pulse keyframe"
```

---

## Task 15: `ChatTitlebar` component

**Files:**
- Create: `src/renderer/components/ChatTitlebar.tsx`

- [ ] **Step 1: Implement**

```tsx
import { OttoMark } from './OttoMark';

interface Props {
  sessionTitle: string;
  isLive: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
}

export function ChatTitlebar({ sessionTitle, isLive, onMinimize, onToggleMaximize }: Props) {
  return (
    <div
      className="otto-app-drag relative flex items-center justify-between px-3.5 py-2.5"
      style={{
        background: 'linear-gradient(180deg, rgba(124,125,255,0.04), transparent 80%), #0f1014',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
      }}
    >
      {/* Drag grip dots, centered */}
      <div aria-hidden className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex gap-[3px] opacity-[0.16]">
        {[0,1,2,3].map((i) => <span key={i} className="w-[3px] h-[3px] rounded-full bg-white" />)}
      </div>

      <div className="flex items-center gap-2.5 z-10">
        <OttoMark className="w-5 h-5 text-[#7c7dff]" />
        <span className="text-[13px] text-[#ebecf1] font-semibold">Otto</span>
        <span className="w-[3px] h-[3px] rounded-full bg-[#3a3b41]" />
        <span className="text-[12px] text-[#9598a0] truncate max-w-[280px]">{sessionTitle || 'New conversation'}</span>
        {isLive && (
          <span className="ml-1.5 inline-flex items-center gap-1.5 px-2 py-[2px] rounded-full"
            style={{ background: 'rgba(124,125,255,0.1)', border: '1px solid rgba(124,125,255,0.25)' }}>
            <span className="w-[5px] h-[5px] rounded-full" style={{ background: '#7c7dff', boxShadow: '0 0 6px #7c7dff' }} />
            <span className="text-[10px] text-[#cfd0ff] font-semibold tracking-[0.3px]">LIVE</span>
          </span>
        )}
      </div>

      <div className="z-10 flex items-center gap-2.5">
        <div className="flex items-center gap-1.5 text-[10px] text-[#5b5e66]">
          <kbd className="px-1.5 py-[2px] rounded-[5px] bg-[#1b1c22] border border-[#2a2b2e] font-mono text-[#9598a0]">↓</kbd>
          <span>collapse</span>
          <span className="opacity-40">·</span>
          <kbd className="px-1.5 py-[2px] rounded-[5px] bg-[#1b1c22] border border-[#2a2b2e] font-mono text-[#9598a0]">⌃␣</kbd>
          <span>hide</span>
        </div>
        <span className="w-px h-4 bg-[#2a2b2e]" />
        <div className="otto-app-no-drag flex gap-1">
          <button
            type="button"
            onClick={onMinimize}
            className="w-[26px] h-[26px] rounded-[7px] flex items-center justify-center text-[#9598a0]"
            style={{ background: '#15161a', border: '1px solid #2a2b2e' }}
            aria-label="Minimize"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onToggleMaximize}
            className="w-[26px] h-[26px] rounded-[7px] flex items-center justify-center text-[#9598a0]"
            style={{ background: '#15161a', border: '1px solid #2a2b2e' }}
            aria-label="Maximize"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
              <rect x="4" y="4" width="16" height="16" rx="2" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add IPC handlers for `window.minimize` and `window.toggleMaximize`**

Open `src/main/ipc/handlers.ts`. Find an existing window-related handler (e.g. `window.hide`) and add neighbors:

```ts
'window.minimize': async () => { window.minimize(); },
'window.toggleMaximize': async () => { window.toggleMaximize(); },
```

Then in `src/main/window.ts`, add to the class:

```ts
minimize(): void { this.window?.minimize(); }
toggleMaximize(): void {
  if (!this.window) return;
  if (this.window.isMaximized()) this.window.unmaximize();
  else this.window.maximize();
}
```

Also extend the IPC contract in `src/shared/ipc-contract.ts` with the two new channels (match the existing pattern for `window.hide`).

- [ ] **Step 3: Type-check**

Run: `pnpm tsc --noEmit`
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/ChatTitlebar.tsx src/main src/shared
git commit -m "feat(titlebar): ChatTitlebar with drag region + min/max"
```

---

## Task 16: `ChatWindow` root component

**Files:**
- Create: `src/renderer/components/ChatWindow.tsx`

- [ ] **Step 1: Implement**

```tsx
import { useMemo } from 'react';
import { ChatTitlebar } from './ChatTitlebar';
import { ConversationSidebar } from './ConversationSidebar';
import { MessageList } from './MessageList';
import { CommandBar } from './CommandBar';
import { ipc } from '../ipc';
import { useOttoStore } from '../store';
import type { SidebarSession } from '../lib/conversation-grouping';

interface Props {
  onSubmit: Parameters<typeof CommandBar>[0]['onSubmit'];
  ensureSession: Parameters<typeof CommandBar>[0]['ensureSession'];
  onStop: Parameters<typeof CommandBar>[0]['onStop'];
  onNewConversation: () => void;
  onOpenSettings: () => void;
}

export function ChatWindow({ onSubmit, ensureSession, onStop, onNewConversation, onOpenSettings }: Props) {
  const sessions = useOttoStore((s) => s.sessions);
  const activeSession = useOttoStore((s) => s.activeSession);
  const pinnedIds = useOttoStore((s) => s.pinnedSessionIds);
  const togglePinned = useOttoStore((s) => s.togglePinned);
  const autonomyMode = useOttoStore((s) => s.autonomyMode);
  const streaming = useOttoStore((s) => s.streaming);

  const sidebarSessions: SidebarSession[] = useMemo(
    () => sessions.map((s) => ({
      id: s.id,
      title: s.title || 'Untitled',
      updatedAt: s.updatedAt ?? Date.now(),
      state: s.state, // assumes session has a derivable state — map here if not
      recentToolNames: s.recentToolNames ?? [],
    })),
    [sessions]
  );

  return (
    <div className="w-screen h-screen flex flex-col"
      style={{
        background: 'linear-gradient(180deg, #16171c 0%, #131419 100%)',
        borderRadius: 16,
        overflow: 'hidden',
        border: '1px solid rgba(255,255,255,0.06)',
      }}>
      <ChatTitlebar
        sessionTitle={activeSession?.title ?? ''}
        isLive={streaming}
        onMinimize={() => void ipc.invoke('window.minimize', undefined)}
        onToggleMaximize={() => void ipc.invoke('window.toggleMaximize', undefined)}
      />

      <div className="flex flex-1 min-h-0">
        <ConversationSidebar
          sessions={sidebarSessions}
          activeSessionId={activeSession?.id ?? null}
          pinnedIds={pinnedIds}
          autonomyLabel={autonomyMode.toUpperCase()}
          conversationCount={sidebarSessions.length}
          onNew={onNewConversation}
          onSelect={(id) => {
            void ipc.invoke('session.load', { id });
          }}
          onTogglePin={(id) => {
            togglePinned(id);
            void ipc.invoke('settings.update', {
              pinnedSessionIds: useOttoStore.getState().pinnedSessionIds,
            });
          }}
          onOpenSettings={onOpenSettings}
        />

        <main className="flex-1 flex flex-col min-w-0" style={{ background: '#16171c' }}>
          <div className="flex-1 overflow-auto">
            <MessageList />
          </div>
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
            <CommandBar onSubmit={onSubmit} ensureSession={ensureSession} onStop={onStop} />
          </div>
        </main>
      </div>
    </div>
  );
}
```

The exact `sessions[i].state` and `recentToolNames` field names probably don't exist yet. **Adapt to whatever the session store actually provides** — if there's no per-session `state`, derive it: `streaming && id === activeId ? 'running' : 'done'`. If there are no tool names tracked per session, default to `[]` for now and leave a follow-up in the spec's out-of-scope list.

- [ ] **Step 2: Type-check**

Run: `pnpm tsc --noEmit`
Expected: zero errors (adapt session-field mapping until it compiles).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/ChatWindow.tsx
git commit -m "feat(chat): ChatWindow wires titlebar + sidebar + reused message list/composer"
```

---

## Task 17: Render `ChatWindow` and wire tier transitions in `App.tsx`

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Branch on `windowMode === 'chat'`**

After the existing `if (windowMode === 'bar') { … }` and panel branches, add (or insert before the panel branch):

```tsx
if (windowMode === 'chat') {
  return (
    <ChatWindow
      onSubmit={handleSubmit}
      ensureSession={ensureSession}
      onStop={handleStop}
      onNewConversation={() => void handleNewConversation({ text: '', attachments: [] })}
      onOpenSettings={() => void ipc.invoke('settings.open', undefined)}
    />
  );
}
```

Add `import { ChatWindow } from './components/ChatWindow';` at the top.

If `settings.open` doesn't exist, use the closest available — search for how the settings page is currently opened.

- [ ] **Step 2: Extend the ↑ handler to promote panel → chat**

Replace the existing up-arrow effect with:

```tsx
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowUp') return;
    const input = document.querySelector('input[type="text"]');
    if (document.activeElement !== input) return;
    if (windowMode === 'bar') {
      e.preventDefault();
      setWindowMode('panel');
      void ipc.invoke('window.setMode', { mode: 'panel' });
    } else if (windowMode === 'panel') {
      e.preventDefault();
      setWindowMode('chat');
      void ipc.invoke('window.setMode', { mode: 'chat' });
    }
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, [windowMode, setWindowMode]);
```

- [ ] **Step 3: Add a ↓ handler for chat → panel**

```tsx
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown') return;
    if (windowMode !== 'chat') return;
    const input = document.querySelector('input[type="text"]');
    if (document.activeElement !== input) return;
    e.preventDefault();
    setWindowMode('panel');
    void ipc.invoke('window.setMode', { mode: 'panel' });
  };
  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}, [windowMode, setWindowMode]);
```

- [ ] **Step 4: Update the Escape handler**

Inside the existing Esc effect, add a chat case before the panel branch:

```ts
if (windowMode === 'chat') {
  setWindowMode('panel');
  void ipc.invoke('window.setMode', { mode: 'panel' });
  return;
}
```

- [ ] **Step 5: Type-check + smoke build**

Run: `pnpm tsc --noEmit && pnpm build`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat(app): tier-3 chat window + ↑/↓ promotion/demotion"
```

---

## Task 18: Playwright E2E — tier promotion + drag + collapse + restore

**Files:**
- Create: `tests/tier3-chat.spec.ts`

- [ ] **Step 1: Inspect existing Playwright specs for harness conventions**

Run: `ls tests/`
Then `cat tests/<the-most-recent-spec>.ts | head -50` to see how Otto launches in tests.

- [ ] **Step 2: Write the E2E**

Using whatever bootstrap helper exists (e.g. `launchApp()`), write a spec that:

```ts
import { test, expect } from '@playwright/test';
import { launchApp } from './helpers'; // adapt to the actual helper

test('tier 3 chat window: promote, drag, collapse, restore', async () => {
  const { app, window } = await launchApp();

  // Start in bar — promote ↑ to panel
  await window.locator('input[type="text"]').focus();
  await window.keyboard.press('ArrowUp');
  await expect(window.locator('[data-window-mode="panel"]')).toBeVisible();

  // Promote ↑ to chat
  await window.keyboard.press('ArrowUp');
  await expect(window.locator('[data-window-mode="chat"]')).toBeVisible();
  await expect(window.getByText('Coworking with Otto')).toBeVisible();

  // Move the OS window via app handle
  const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ x: 200, y: 200, width: 1000, height: 700 })
  );
  await new Promise((r) => setTimeout(r, 400));

  // Collapse ↓ — bar snaps back to anchor (bottom-center); not 200,200
  await window.locator('input[type="text"]').focus();
  await window.keyboard.press('ArrowDown');
  await expect(window.locator('[data-window-mode="panel"]')).toBeVisible();
  const panelBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  expect(panelBounds.x).not.toBe(200);

  // Promote ↑ again — chat returns to (200,200,1000,700)
  await window.keyboard.press('ArrowUp');
  await expect(window.locator('[data-window-mode="chat"]')).toBeVisible();
  const chatBounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
  expect(chatBounds.x).toBe(200);
  expect(chatBounds.y).toBe(200);
  expect(chatBounds.width).toBe(1000);
  expect(chatBounds.height).toBe(700);

  await app.close();
});
```

Add a `data-window-mode` attribute on the root of each branch in `App.tsx`:

```tsx
<div data-window-mode="chat" …>…</div>
<div data-window-mode="panel" …>…</div>
<div data-window-mode="bar" …>…</div>
```

- [ ] **Step 3: Run the spec**

Run: `pnpm playwright test tests/tier3-chat.spec.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/tier3-chat.spec.ts src/renderer/App.tsx
git commit -m "test(e2e): tier 3 promote/drag/collapse/restore"
```

---

## Task 19: Manual smoke + graphify refresh

- [ ] **Step 1: Start the app**

Run: `pnpm dev`
Use the global hotkey. Confirm:
1. Hotkey → tier 1 condensed bar at anchor.
2. ↑ → tier 2 panel.
3. ↑ → tier 3 floating chat at default center.
4. Drag the titlebar — window moves freely.
5. Resize from corner — observe min 560×400.
6. ↓ → tier 2 snapped to anchor.
7. ↑ → tier 3 reopens at last position+size.
8. Hotkey → hide. Hotkey → resumes tier 3 at last position.
9. Restart app → hotkey → tier 3 still at last position+size.
10. Sidebar: New conversation works, search filters, pin toggles a session into Pinned section, click switches sessions.

- [ ] **Step 2: Refresh graphify**

Run: `graphify update .`

- [ ] **Step 3: Commit any remaining work**

```bash
git status
# If clean, done. Otherwise add a final smoke-fix commit.
```

---

## Self-Review

**Spec coverage**

| Spec section | Task(s) |
|---|---|
| Tier transitions table | 17 |
| `WindowMode` extension | 1 |
| Frameless / always-on-top / resizable | (existing in `create()`) + 4 (min size) |
| Default 960×620 centered | 4 |
| Persistent bounds | 5 + 7 |
| `lastVisibleMode` resume | 6 + 7 |
| Hide-on-blur disabled in chat | 6 |
| Min/max controls | 15 |
| Titlebar with OttoMark, live pill, kbd hints | 15 |
| Sidebar header, CTA, search | 13 |
| Pinned / Today / Yesterday / Earlier | 9 + 10 + 12 |
| Status dots | 9 + 10 + 11 |
| Tool glyphs | 9 + 10 + 11 |
| Active row accent rail | 11 |
| Reused `MessageList` + `CommandBar` | 16 |
| Off-screen bounds fallback | 4 |
| E2E for promotion + drag + collapse + restore | 18 |
| Manual smoke | 19 |

All spec requirements have at least one task.

**Placeholder scan** — none remain. Steps that touch site-specific code (settings.update, session state field shape) instruct the engineer to look at the existing call site and adapt.

**Type/name consistency** — `WindowMode`, `chatBounds`, `lastVisibleMode`, `pinnedSessionIds`, `SidebarSession`, `groupSessions`, `sessionStatusDot`, `recentToolGlyphs`, `ChatBounds` are used consistently.
