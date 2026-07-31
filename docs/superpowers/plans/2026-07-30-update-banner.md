# Auto-Update Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show an in-app "restart to update" banner when an update has been downloaded, and auto-download updates in the background when one is found.

**Architecture:** The updater backend (electron-updater state machine in `src/main/updater/index.ts`, IPC bridge `ipc.updater.*`) already exists and is untouched except for one integration-layer policy change: `src/main/ipc/updater.ts` triggers `download()` automatically on the `available` state. A new self-contained renderer component `UpdateBanner` subscribes to updater state via the existing bridge and renders only in the `downloaded` state, mounted in the panel footer and chat composer.

**Tech Stack:** Electron, React 18, TypeScript, Tailwind (token classes: `bg-surface`, `text-text`, `text-muted`, `bg-accent`, `border-accent`), Vitest + @testing-library/react (jsdom).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-30-update-banner-design.md` (Option A, approved).
- Run tests with `npm test` — the repo's `vitest.config.ts` already caps at 2 workers; do not raise parallelism.
- Verify with `npm run typecheck` and `npm run lint` before each commit.
- localStorage dismissal key is exactly `otto.update-dismissed`.
- Banner copy is exactly: `Otto v{version} is ready.` with buttons `Restart to update` and `Later`.
- End every commit message with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: UpdateBanner component

**Files:**
- Create: `src/renderer/components/UpdateBanner.tsx`
- Test: `src/renderer/components/UpdateBanner.test.tsx`

**Interfaces:**
- Consumes: `UpdaterBridge` and `UpdaterState` from `@shared/ipc-contract` (both already exist — `UpdaterBridge` has `status(): Promise<UpdaterState>`, `install(): Promise<void>`, `onStateChange(cb): () => void`); `ipc` from `src/renderer/ipc.ts` (has `ipc.updater: UpdaterBridge`).
- Produces: `export function UpdateBanner(props: { updater?: UpdaterBridge; className?: string }): JSX.Element | null` — `updater` defaults to `ipc.updater` (tests inject a fake); `className` is appended to the root element's classes (Task 2's chat mount passes `className="mb-2"`).

- [ ] **Step 1: Write the failing test**

Create `src/renderer/components/UpdateBanner.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdateBanner } from './UpdateBanner';
import type { UpdaterBridge, UpdaterState } from '@shared/ipc-contract';

function fakeUpdater(initial: UpdaterState) {
  let listener: ((s: UpdaterState) => void) | null = null;
  const bridge: UpdaterBridge = {
    status: vi.fn(async () => initial),
    check: vi.fn(async () => initial),
    download: vi.fn(async () => initial),
    install: vi.fn(async () => undefined),
    onStateChange: vi.fn((cb: (s: UpdaterState) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
  };
  return { bridge, emit: (s: UpdaterState) => act(() => listener?.(s)) };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  localStorage.clear();
});

describe('UpdateBanner', () => {
  it.each<UpdaterState>([
    { kind: 'idle' },
    { kind: 'checking' },
    { kind: 'up-to-date' },
    { kind: 'available', version: '0.15.0' },
    { kind: 'downloading', version: '0.15.0', percent: 40 },
    { kind: 'error', message: 'boom' },
  ])('renders nothing for state $kind', async (state) => {
    const { bridge } = fakeUpdater(state);
    const { container } = render(<UpdateBanner updater={bridge} />);
    await flush();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows version and actions when an update is downloaded', async () => {
    const { bridge } = fakeUpdater({ kind: 'downloaded', version: '0.15.0' });
    render(<UpdateBanner updater={bridge} />);
    expect(await screen.findByText('Otto v0.15.0 is ready.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /restart to update/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /later/i })).toBeInTheDocument();
  });

  it('appears when a live state change reports downloaded', async () => {
    const { bridge, emit } = fakeUpdater({ kind: 'idle' });
    const { container } = render(<UpdateBanner updater={bridge} />);
    await flush();
    expect(container).toBeEmptyDOMElement();
    emit({ kind: 'downloaded', version: '0.15.0' });
    expect(await screen.findByText('Otto v0.15.0 is ready.')).toBeInTheDocument();
  });

  it('calls install when Restart to update is clicked', async () => {
    const { bridge } = fakeUpdater({ kind: 'downloaded', version: '0.15.0' });
    render(<UpdateBanner updater={bridge} />);
    await userEvent.click(await screen.findByRole('button', { name: /restart to update/i }));
    expect(bridge.install).toHaveBeenCalledTimes(1);
  });

  it('Later hides the banner and persists the dismissal for that version', async () => {
    const { bridge } = fakeUpdater({ kind: 'downloaded', version: '0.15.0' });
    const { container, unmount } = render(<UpdateBanner updater={bridge} />);
    await userEvent.click(await screen.findByRole('button', { name: /later/i }));
    expect(container).toBeEmptyDOMElement();
    expect(localStorage.getItem('otto.update-dismissed')).toBe('0.15.0');
    unmount();
    // A fresh mount (new window) stays hidden for the dismissed version.
    const second = render(<UpdateBanner updater={fakeUpdater({ kind: 'downloaded', version: '0.15.0' }).bridge} />);
    await flush();
    expect(second.container).toBeEmptyDOMElement();
  });

  it('shows the banner for a newer version despite an older dismissal', async () => {
    localStorage.setItem('otto.update-dismissed', '0.15.0');
    const { bridge } = fakeUpdater({ kind: 'downloaded', version: '0.16.0' });
    render(<UpdateBanner updater={bridge} />);
    expect(await screen.findByText('Otto v0.16.0 is ready.')).toBeInTheDocument();
  });

  it('appends className to the root element', async () => {
    const { bridge } = fakeUpdater({ kind: 'downloaded', version: '0.15.0' });
    render(<UpdateBanner updater={bridge} className="mb-2" />);
    expect((await screen.findByRole('status')).className).toContain('mb-2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/renderer/components/UpdateBanner.test.tsx`
Expected: FAIL — cannot resolve `./UpdateBanner`.

- [ ] **Step 3: Write the implementation**

Create `src/renderer/components/UpdateBanner.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { ipc } from '../ipc';
import type { UpdaterBridge, UpdaterState } from '@shared/ipc-contract';

const DISMISS_KEY = 'otto.update-dismissed';

/**
 * Slim strip shown when an update has been downloaded and is waiting for a
 * restart. Downloads happen automatically in the main process, and a
 * dismissed update still installs on the next quit, so this is the only
 * update decision the user is ever asked to make.
 */
export function UpdateBanner({
  updater = ipc.updater,
  className,
}: {
  updater?: UpdaterBridge;
  className?: string;
}) {
  const [state, setState] = useState<UpdaterState>({ kind: 'idle' });
  const [dismissed, setDismissed] = useState<string | null>(() =>
    localStorage.getItem(DISMISS_KEY),
  );

  useEffect(() => {
    void updater.status().then(setState);
    return updater.onStateChange(setState);
  }, [updater]);

  if (state.kind !== 'downloaded' || state.version === dismissed) return null;

  return (
    <div
      role="status"
      aria-label="Update ready"
      className={`flex items-center justify-between gap-3 px-3 py-2 rounded-xl border border-accent/40 bg-surface/80 text-xs ${className ?? ''}`}
    >
      <div className="text-sm text-text">Otto v{state.version} is ready.</div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void updater.install()}
          className="px-2.5 py-1 rounded bg-accent text-white text-xs font-medium hover:bg-accent/90 transition-colors"
        >
          Restart to update
        </button>
        <button
          type="button"
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, state.version);
            setDismissed(state.version);
          }}
          className="px-2 py-1 text-xs text-muted hover:text-text transition-colors"
        >
          Later
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/renderer/components/UpdateBanner.test.tsx`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add src/renderer/components/UpdateBanner.tsx src/renderer/components/UpdateBanner.test.tsx
git commit -m "feat: UpdateBanner component for downloaded updates

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Mount the banner in panel and chat windows

**Files:**
- Modify: `src/renderer/App.tsx` (panel footer, around line 500)
- Modify: `src/renderer/components/ChatWindow.tsx` (composer area, around line 150)

**Interfaces:**
- Consumes: `UpdateBanner` from Task 1 — `<UpdateBanner />` and `<UpdateBanner className="mb-2" />`. No props other than `className` are passed in production mounts.
- Produces: nothing new.

- [ ] **Step 1: Mount in the panel footer in App.tsx**

Add the import alongside the other component imports:

```tsx
import { UpdateBanner } from './components/UpdateBanner';
```

In the panel-mode return (the `footer=` prop of `<Panel>`), add the banner as the first child of the existing stack, above `<CommandBar>`:

```tsx
        footer={
          <div className="flex flex-col gap-2">
            <UpdateBanner />
            <CommandBar
```

The stack's `gap-2` provides spacing only when the banner actually renders.

- [ ] **Step 2: Mount in the chat composer in ChatWindow.tsx**

Add the import alongside the other component imports:

```tsx
import { UpdateBanner } from './UpdateBanner';
```

In the composer container (`<div className="px-4 py-3" style={{ borderTop: ... }}>`), add the banner directly above `<CommandBar>`:

```tsx
          <div className="px-4 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
            <UpdateBanner className="mb-2" />
            <CommandBar
```

`className="mb-2"` puts the gap on the banner itself, so nothing is rendered (and no stray margin) when there's no update.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass; no test asserts on these mounts, so this verifies compilation and no regressions.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/App.tsx src/renderer/components/ChatWindow.tsx
git commit -m "feat: mount UpdateBanner in panel footer and chat composer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Auto-download on available; drop the redundant notification

**Files:**
- Modify: `src/main/ipc/updater.ts:8-42`
- Modify: `src/main/notifier.ts:101-115`

**Interfaces:**
- Consumes: `UpdaterApi` from `src/main/updater/index.ts` (`download(): Promise<void>` is a no-op unless state is `available`/`error` — unchanged).
- Produces: `UpdateNotifier` interface in `src/main/ipc/updater.ts` shrinks to `{ notifyUpdateReady(version: string, onClick: () => void): void }`. `Notifier` (`src/main/notifier.ts`) loses its `notifyUpdateAvailable` method; `notifyUpdateReady` is unchanged. `src/main/index.ts` needs no edit (it passes the whole `Notifier` instance, which still satisfies the narrowed interface).

- [ ] **Step 1: Change the state-change policy in src/main/ipc/updater.ts**

Replace the `UpdateNotifier` interface:

```ts
interface UpdateNotifier {
  notifyUpdateReady(version: string, onClick: () => void): void;
}
```

Replace the `onStateChange` callback inside `createUpdater({...})`:

```ts
    onStateChange: (state) => {
      for (const w of getWindows()) {
        if (!w.isDestroyed()) w.webContents.send('updater:state', state);
      }
      // Updates install on quit regardless, so there is no decision for the
      // user to make at the "available" stage — just fetch it.
      if (state.kind === 'available') {
        void api!.download();
      }
      if (notifier && state.kind === 'downloaded') {
        notifier.notifyUpdateReady(state.version, () => api!.install());
      }
    },
```

- [ ] **Step 2: Remove Notifier.notifyUpdateAvailable in src/main/notifier.ts**

Delete the whole `notifyUpdateAvailable(version: string, onClick: () => void): void { ... }` method (lines 101-115). Keep `notifyUpdateReady` exactly as is.

- [ ] **Step 3: Verify nothing else references the removed method**

Run: `grep -rn notifyUpdateAvailable src/`
Expected: no matches.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass (`src/main/updater/index.test.ts` is untouched by design).

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/updater.ts src/main/notifier.ts
git commit -m "feat: auto-download updates when available

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
