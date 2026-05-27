# New Conversation System — Phase 1 (Manual + Idle Timeout) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user start a new conversation manually (`/n ␣` prefix, header button, hotkey) and have Otto automatically start a fresh conversation when the current one has been totally idle (no user or assistant activity) for longer than a configurable threshold.

**Architecture:** A new main-process module `ConversationPolicy` tracks `lastActivityAt` and answers "should the next submit start fresh?" It subscribes to `SessionManager` events for assistant activity and is consulted by a new IPC channel `session.ensureForSubmit` that the renderer calls instead of caching its own session id. Manual triggers (prefix + hotkey + button) all funnel through the renderer's existing `handleNewSession`. Settings file is bumped from v3 to v4 with a `newConversation.idleTimeoutMinutes` field.

**Tech Stack:** TypeScript, Electron (main + renderer), Vitest, React.

**Spec:** `docs/superpowers/specs/2026-05-27-new-conversation-system-design.md`

---

## File Structure

**Create:**
- `src/main/agent/conversation-policy.ts` — pure decision module (no IO)
- `src/main/agent/conversation-policy.test.ts`
- `src/shared/manual-prefix.ts` — pure parser for `/n ` prefix at start of buffer
- `src/shared/manual-prefix.test.ts`

**Modify:**
- `src/main/autonomy/settings.ts` — add v4 schema with `newConversation.idleTimeoutMinutes`, migration from v3
- `src/main/autonomy/settings.test.ts` — add migration and getter/setter tests
- `src/shared/ipc-contract.ts` — add `session.ensureForSubmit` channel, new settings field in `SettingsView`, new setter channel
- `src/main/ipc/handlers.ts` — register `session.ensureForSubmit`, settings setter, wire `ConversationPolicy`
- `src/main/agent/session.ts` — expose a hook so the policy can record assistant activity, and a no-resume `startFresh()` helper used by `ensureForSubmit`
- `src/main/index.ts` — instantiate `ConversationPolicy`, wire to settings and `SessionManager`
- `src/renderer/App.tsx` — `ensureSession` calls `session.ensureForSubmit`; route prefix-detection to `handleNewSession`; register global "new conversation" shortcut
- `src/renderer/components/CommandBar.tsx` — detect `/n ` prefix on submit, call a new `onNewConversation` callback
- `src/renderer/components/CommandBar.test.tsx` — cover prefix detection
- `src/renderer/components/Chat.tsx` (or wherever the message list renders) — render "New conversation" divider when a session boundary appears
- `src/renderer/SettingsApp.tsx` — add "Conversations" section with idle-timeout input
- `src/renderer/ipc.ts` — typed wrappers if needed

---

## Task 1: ConversationPolicy module

**Files:**
- Create: `src/main/agent/conversation-policy.ts`
- Test: `src/main/agent/conversation-policy.test.ts`

- [ ] **Step 1: Write the failing test**

`src/main/agent/conversation-policy.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { ConversationPolicy } from './conversation-policy';

function makePolicy(opts: { now: number; idleMinutes: number }) {
  let current = opts.now;
  const policy = new ConversationPolicy({
    now: () => current,
    getIdleTimeoutMinutes: () => opts.idleMinutes,
  });
  return {
    policy,
    advance(ms: number) {
      current += ms;
    },
  };
}

describe('ConversationPolicy', () => {
  it('does not request fresh when timeout is disabled (0)', () => {
    const { policy, advance } = makePolicy({ now: 1000, idleMinutes: 0 });
    advance(10 * 60 * 60 * 1000);
    expect(policy.shouldStartFresh()).toBe(false);
  });

  it('requests fresh when elapsed exceeds timeout', () => {
    const { policy, advance } = makePolicy({ now: 0, idleMinutes: 60 });
    advance(61 * 60 * 1000);
    expect(policy.shouldStartFresh()).toBe(true);
  });

  it('does not request fresh when elapsed is at or below timeout', () => {
    const { policy, advance } = makePolicy({ now: 0, idleMinutes: 60 });
    advance(60 * 60 * 1000);
    expect(policy.shouldStartFresh()).toBe(false);
  });

  it('recordActivity resets the elapsed counter', () => {
    const { policy, advance } = makePolicy({ now: 0, idleMinutes: 60 });
    advance(59 * 60 * 1000);
    policy.recordActivity();
    advance(59 * 60 * 1000);
    expect(policy.shouldStartFresh()).toBe(false);
  });

  it('shouldStartFresh is idempotent (does not record activity itself)', () => {
    const { policy, advance } = makePolicy({ now: 0, idleMinutes: 60 });
    advance(61 * 60 * 1000);
    expect(policy.shouldStartFresh()).toBe(true);
    expect(policy.shouldStartFresh()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/main/agent/conversation-policy.test.ts`
Expected: FAIL — `Cannot find module './conversation-policy'`.

- [ ] **Step 3: Write the implementation**

`src/main/agent/conversation-policy.ts`:

```ts
export interface ConversationPolicyDeps {
  now(): number;
  getIdleTimeoutMinutes(): number;
}

export class ConversationPolicy {
  private lastActivityAt: number;

  constructor(private readonly deps: ConversationPolicyDeps) {
    this.lastActivityAt = deps.now();
  }

  recordActivity(): void {
    this.lastActivityAt = this.deps.now();
  }

  shouldStartFresh(): boolean {
    const minutes = this.deps.getIdleTimeoutMinutes();
    if (!Number.isFinite(minutes) || minutes <= 0) return false;
    return this.deps.now() - this.lastActivityAt > minutes * 60_000;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/main/agent/conversation-policy.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/conversation-policy.ts src/main/agent/conversation-policy.test.ts
git commit -m "feat(agent): add ConversationPolicy for idle-timeout new conversations"
```

---

## Task 2: Manual prefix parser

**Files:**
- Create: `src/shared/manual-prefix.ts`
- Test: `src/shared/manual-prefix.test.ts`

- [ ] **Step 1: Write the failing test**

`src/shared/manual-prefix.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseNewConversationPrefix, NEW_CONVERSATION_PREFIX } from './manual-prefix';

describe('parseNewConversationPrefix', () => {
  it('exports the literal prefix "/n "', () => {
    expect(NEW_CONVERSATION_PREFIX).toBe('/n ');
  });

  it('returns null when buffer does not start with the prefix', () => {
    expect(parseNewConversationPrefix('hello')).toBeNull();
    expect(parseNewConversationPrefix('say /n now')).toBeNull();
    expect(parseNewConversationPrefix('/notice this')).toBeNull();
  });

  it('returns empty remainder when buffer is exactly the prefix', () => {
    expect(parseNewConversationPrefix('/n ')).toEqual({ remainder: '' });
  });

  it('returns the trailing text as remainder', () => {
    expect(parseNewConversationPrefix('/n hello world')).toEqual({
      remainder: 'hello world',
    });
  });

  it('preserves leading whitespace inside the remainder beyond the single separator space', () => {
    expect(parseNewConversationPrefix('/n  extra')).toEqual({ remainder: ' extra' });
  });

  it('does not match "/n" without a trailing space', () => {
    expect(parseNewConversationPrefix('/n')).toBeNull();
    expect(parseNewConversationPrefix('/nhello')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/shared/manual-prefix.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/shared/manual-prefix.ts`:

```ts
export const NEW_CONVERSATION_PREFIX = '/n ';

export interface ParsedNewConversationPrefix {
  remainder: string;
}

export function parseNewConversationPrefix(
  buffer: string,
): ParsedNewConversationPrefix | null {
  if (!buffer.startsWith(NEW_CONVERSATION_PREFIX)) return null;
  return { remainder: buffer.slice(NEW_CONVERSATION_PREFIX.length) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/shared/manual-prefix.test.ts`
Expected: PASS — all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/shared/manual-prefix.ts src/shared/manual-prefix.test.ts
git commit -m "feat(shared): add /n new-conversation prefix parser"
```

---

## Task 3: Settings — add `newConversation.idleTimeoutMinutes` (v4 migration)

**Files:**
- Modify: `src/main/autonomy/settings.ts`
- Modify: `src/main/autonomy/settings.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/autonomy/settings.test.ts`:

```ts
describe('Settings — newConversation', () => {
  it('defaults idleTimeoutMinutes to 60 on fresh install', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-settings-nc-'));
    const s = new Settings(path.join(dir, 'settings.json'));
    await s.load();
    expect(s.getNewConversationIdleTimeoutMinutes()).toBe(60);
  });

  it('migrates a v3 file by adding the default idleTimeoutMinutes=60', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-settings-nc-'));
    const file = path.join(dir, 'settings.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 3,
        autonomy: { mode: 'balanced' },
        notifications: { turnComplete: true, approval: true, sound: false },
        startAtLogin: false,
        windowPosition: 'bottom-center',
        displayTarget: 'cursor',
        autoDeleteDays: 0,
        hideOnBlur: false,
      }),
    );
    const s = new Settings(file);
    await s.load();
    expect(s.getNewConversationIdleTimeoutMinutes()).toBe(60);
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(raw.version).toBe(4);
    expect(raw.newConversation).toEqual({ idleTimeoutMinutes: 60 });
  });

  it('setNewConversationIdleTimeoutMinutes persists and rejects negatives', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-settings-nc-'));
    const s = new Settings(path.join(dir, 'settings.json'));
    await s.load();
    await s.setNewConversationIdleTimeoutMinutes(120);
    expect(s.getNewConversationIdleTimeoutMinutes()).toBe(120);
    await expect(s.setNewConversationIdleTimeoutMinutes(-1)).rejects.toThrow();
  });

  it('accepts 0 to disable idle-based new conversations', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'otto-settings-nc-'));
    const s = new Settings(path.join(dir, 'settings.json'));
    await s.load();
    await s.setNewConversationIdleTimeoutMinutes(0);
    expect(s.getNewConversationIdleTimeoutMinutes()).toBe(0);
  });
});
```

(If the existing test file does not already import `fs`, `os`, `path`, copy the imports from the top of the file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/main/autonomy/settings.test.ts`
Expected: FAIL — `getNewConversationIdleTimeoutMinutes is not a function` and `version expected 4`.

- [ ] **Step 3: Update the implementation**

Modify `src/main/autonomy/settings.ts`:

a) Bump version:
```ts
const CURRENT_VERSION = 4;
```

b) Add to `SettingsSnapshot`:
```ts
export interface NewConversationPrefs {
  idleTimeoutMinutes: number; // 0 disables
}

export interface SettingsSnapshot {
  autonomy: { mode: AutonomyMode };
  notifications: NotificationPrefs;
  startAtLogin: boolean;
  windowPosition: WindowPosition;
  displayTarget: DisplayTarget;
  autoDeleteDays: number;
  hideOnBlur: boolean;
  newConversation: NewConversationPrefs;
}
```

c) Add v4 file interface:
```ts
interface SettingsFileV4 extends SettingsSnapshot {
  version: 4;
}
type SettingsFile = SettingsFileV1 | SettingsFileV2 | SettingsFileV3 | SettingsFileV4;
```

d) Add default:
```ts
const DEFAULTS: SettingsSnapshot = {
  autonomy: { mode: DEFAULT_MODE },
  notifications: { turnComplete: true, approval: true, sound: false },
  startAtLogin: false,
  windowPosition: 'bottom-center',
  displayTarget: 'cursor',
  autoDeleteDays: 0,
  hideOnBlur: false,
  newConversation: { idleTimeoutMinutes: 60 },
};
```

e) Add getter, setter, snapshot field:
```ts
getNewConversationIdleTimeoutMinutes(): number {
  return this.state.newConversation.idleTimeoutMinutes;
}

async setNewConversationIdleTimeoutMinutes(minutes: number): Promise<void> {
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`invalid idleTimeoutMinutes: ${minutes}`);
  }
  this.state.newConversation = { idleTimeoutMinutes: Math.floor(minutes) };
  await this.persist();
}
```

Update `snapshot()` to include:
```ts
newConversation: { ...this.state.newConversation },
```

f) Update `applyParsed`: change the `version === 2 || version === 3 || version === CURRENT_VERSION` branch to also accept v3 and v4, and read `newConversation` with a default:

```ts
if (version === 2 || version === 3 || version === CURRENT_VERSION) {
  const o = obj as Omit<SettingsFileV2, 'version'> &
    Partial<Omit<SettingsFileV4, 'version'>>;
  const m = o.autonomy?.mode;
  if (!m || !VALID_MODES.includes(m)) return false;
  const idle = o.newConversation?.idleTimeoutMinutes;
  this.state = {
    autonomy: { mode: m },
    notifications: {
      turnComplete: o.notifications?.turnComplete !== false,
      approval: o.notifications?.approval !== false,
      sound: !!o.notifications?.sound,
    },
    startAtLogin: !!o.startAtLogin,
    windowPosition: VALID_POSITIONS.includes(o.windowPosition as WindowPosition)
      ? o.windowPosition
      : DEFAULTS.windowPosition,
    displayTarget: VALID_DISPLAY_TARGETS.includes(o.displayTarget as DisplayTarget)
      ? (o.displayTarget as DisplayTarget)
      : DEFAULTS.displayTarget,
    autoDeleteDays:
      Number.isFinite(o.autoDeleteDays) && o.autoDeleteDays >= 0
        ? Math.floor(o.autoDeleteDays)
        : DEFAULTS.autoDeleteDays,
    hideOnBlur: typeof o.hideOnBlur === 'boolean' ? o.hideOnBlur : DEFAULTS.hideOnBlur,
    newConversation: {
      idleTimeoutMinutes:
        Number.isFinite(idle) && (idle as number) >= 0
          ? Math.floor(idle as number)
          : DEFAULTS.newConversation.idleTimeoutMinutes,
    },
  };
  return version === CURRENT_VERSION ? 'ok' : 'migrated';
}
```

Also extend the v1 migration to populate the new default (it already spreads `DEFAULTS`, so no change required).

g) Update `writeFile` to write a v4 payload:
```ts
const payload: SettingsFileV4 = { version: CURRENT_VERSION, ...this.snapshot() };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/main/autonomy/settings.test.ts`
Expected: PASS — both existing and the 4 new tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/autonomy/settings.ts src/main/autonomy/settings.test.ts
git commit -m "feat(settings): add newConversation.idleTimeoutMinutes with v4 migration"
```

---

## Task 4: IPC contract — `session.ensureForSubmit` + settings setter

**Files:**
- Modify: `src/shared/ipc-contract.ts`

- [ ] **Step 1: Add to `SettingsView`**

In `src/shared/ipc-contract.ts`, extend `SettingsView`:

```ts
export interface SettingsView {
  autonomy: { mode: AutonomyMode };
  notifications: { turnComplete: boolean; approval: boolean; sound: boolean };
  startAtLogin: boolean;
  windowPosition: 'bottom-center' | 'top-center';
  displayTarget: 'cursor' | 'primary';
  autoDeleteDays: number;
  hideOnBlur: boolean;
  newConversation: { idleTimeoutMinutes: number };
  version: string;
}
```

- [ ] **Step 2: Add new argument and result types**

```ts
export interface SessionEnsureForSubmitArgs {
  current: string | null;
  model?: string;
}

export interface SessionEnsureForSubmitResult {
  sessionId: string;
  isNew: boolean;
  reason: 'reused' | 'idle-timeout' | 'manual' | 'no-session';
}
```

`reason: 'manual'` is reserved for a future explicit caller; the IPC always returns `'reused'`, `'idle-timeout'`, or `'no-session'` from this channel. Manual triggers continue to use the existing `session.start` channel.

- [ ] **Step 3: Add to `IpcRequest`**

Add these two entries inside the `IpcRequest` union:

```ts
| {
    channel: 'session.ensureForSubmit';
    args: SessionEnsureForSubmitArgs;
    result: SessionEnsureForSubmitResult;
  }
| {
    channel: 'settings.setNewConversationIdleTimeoutMinutes';
    args: { minutes: number };
    result: void;
  }
```

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: FAIL with errors in `handlers.ts`, `App.tsx`, and `SettingsApp.tsx` consumers of `SettingsView` that don't yet supply `newConversation`. These are fixed in later tasks.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc-contract.ts
git commit -m "feat(ipc): add session.ensureForSubmit and newConversation settings setter"
```

---

## Task 5: Wire `ConversationPolicy` in main + emit assistant activity

**Files:**
- Modify: `src/main/agent/session.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc/handlers.ts`
- Test: `src/main/agent/session.test.ts` (extend existing)

- [ ] **Step 1: Add an activity listener hook to `SessionManager`**

In `src/main/agent/session.ts`, alongside the other listener arrays:

```ts
private readonly activityListeners: Array<() => void> = [];

onActivityListener(cb: () => void): void {
  this.activityListeners.push(cb);
}

private notifyActivity(): void {
  for (const cb of this.activityListeners) cb();
}
```

Then call `this.notifyActivity()` in the `emit()` wrapper, OR (cleaner) inside the `consumeStream` loop on each of: `text-delta`, `tool-call-start`, `tool-call-result`, `message-end`, `message-cancelled`, `session-id`. Pick the inside-loop approach so user-message echoes routed through `emit` from `send()` do not double-fire (they're recorded by step 3 below).

- [ ] **Step 2: Write a test for the activity listener**

Add to `src/main/agent/session.test.ts` (matching the test file's existing setup style):

```ts
it('notifies activity listeners on assistant stream events', async () => {
  // existing test harness pattern: build a SessionManager with a fake SDK.
  const ticks: number[] = [];
  manager.onActivityListener(() => ticks.push(Date.now()));
  await manager.start({});
  // drive the fake SDK to emit a text-delta and a message-end
  fakeSdk.pushEvent({ type: 'text-delta', text: 'hi' });
  fakeSdk.pushEvent({ type: 'message-end' });
  await fakeSdk.flush();
  expect(ticks.length).toBeGreaterThanOrEqual(2);
});
```

(Adapt to match how the existing `session.test.ts` constructs its fake SDK and drives events — see the top of that file for the harness.)

- [ ] **Step 3: Run the new test to verify it fails, then passes after wiring**

Run: `pnpm vitest run src/main/agent/session.test.ts`
Expected: FAIL → wire up → PASS.

- [ ] **Step 4: Instantiate `ConversationPolicy` in `src/main/index.ts`**

After `settings.load()` and after `sessions` (`SessionManager`) is created:

```ts
import { ConversationPolicy } from './agent/conversation-policy';

const conversationPolicy = new ConversationPolicy({
  now: () => Date.now(),
  getIdleTimeoutMinutes: () => settings.getNewConversationIdleTimeoutMinutes(),
});

sessions.onActivityListener(() => conversationPolicy.recordActivity());
```

Then pass `conversationPolicy` to `registerIpcHandlers({ ..., conversationPolicy })`.

- [ ] **Step 5: Register `session.ensureForSubmit` handler**

In `src/main/ipc/handlers.ts`, extend the `deps` interface and `registerIpcHandlers` arg with `conversationPolicy: ConversationPolicy`. Add:

```ts
ipcMain.handle(
  'session.ensureForSubmit',
  async (
    _e,
    args: SessionEnsureForSubmitArgs,
  ): Promise<SessionEnsureForSubmitResult> => {
    const current = args.current ?? sessions.getActiveSessionId();
    if (!current) {
      const { sessionId } = await sessions.start({ model: args.model });
      conversationPolicy.recordActivity();
      return { sessionId, isNew: true, reason: 'no-session' };
    }
    if (conversationPolicy.shouldStartFresh()) {
      const { sessionId } = await sessions.start({ model: args.model });
      conversationPolicy.recordActivity();
      return { sessionId, isNew: true, reason: 'idle-timeout' };
    }
    conversationPolicy.recordActivity();
    return { sessionId: current, isNew: false, reason: 'reused' };
  },
);
```

Also register the new settings setter:

```ts
ipcMain.handle(
  'settings.setNewConversationIdleTimeoutMinutes',
  async (_e, args: { minutes: number }): Promise<void> => {
    await settings.setNewConversationIdleTimeoutMinutes(args.minutes);
  },
);
```

And update the `settings.get` handler so the returned `SettingsView` includes `newConversation: { idleTimeoutMinutes: settings.getNewConversationIdleTimeoutMinutes() }`.

(If `SessionManager.getActiveSessionId()` does not yet exist as a public method, add it — it already has the private `activeSessionId` field per `session.ts:76`.)

- [ ] **Step 6: Run typecheck and full test suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS for everything wired so far. Renderer-side mismatches will still exist; address them in the next task.

- [ ] **Step 7: Commit**

```bash
git add src/main/agent/session.ts src/main/agent/session.test.ts src/main/index.ts src/main/ipc/handlers.ts
git commit -m "feat(agent): wire ConversationPolicy and session.ensureForSubmit"
```

---

## Task 6: Renderer — use `ensureForSubmit` and surface manual prefix

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/components/CommandBar.tsx`
- Modify: `src/renderer/components/CommandBar.test.tsx`

- [ ] **Step 1: Test prefix-trigger in CommandBar**

Add to `src/renderer/components/CommandBar.test.tsx`:

```ts
it('routes "/n " submit through onNewConversation with empty text', async () => {
  const onSubmit = vi.fn();
  const onNewConversation = vi.fn();
  render(
    <CommandBar
      onSubmit={onSubmit}
      ensureSession={noopEnsure}
      onNewConversation={onNewConversation}
    />,
  );
  const input = screen.getByRole('textbox');
  await userEvent.type(input, '/n ');
  await userEvent.keyboard('{Enter}');
  expect(onNewConversation).toHaveBeenCalledWith({ text: '', attachments: [] });
  expect(onSubmit).not.toHaveBeenCalled();
});

it('routes "/n do thing" through onNewConversation with the remainder', async () => {
  const onSubmit = vi.fn();
  const onNewConversation = vi.fn();
  render(
    <CommandBar
      onSubmit={onSubmit}
      ensureSession={noopEnsure}
      onNewConversation={onNewConversation}
    />,
  );
  const input = screen.getByRole('textbox');
  await userEvent.type(input, '/n do thing');
  await userEvent.keyboard('{Enter}');
  expect(onNewConversation).toHaveBeenCalledWith({
    text: 'do thing',
    attachments: [],
  });
  expect(onSubmit).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/renderer/components/CommandBar.test.tsx`
Expected: FAIL — `onNewConversation` prop unknown.

- [ ] **Step 3: Add the prop and wire prefix detection**

In `src/renderer/components/CommandBar.tsx`:

a) Import:
```ts
import { parseNewConversationPrefix } from '@shared/manual-prefix';
```

b) Add to `Props`:
```ts
onNewConversation?(args: { text: string; attachments: ImageRef[] }): void;
```

c) Destructure in component args.

d) In `handleSubmit`, BEFORE the existing trim/length check, branch on the raw `value`:

```ts
function handleSubmit(e: FormEvent) {
  e.preventDefault();
  const parsed = parseNewConversationPrefix(value);
  if (parsed && onNewConversation) {
    const remainder = parsed.remainder.trimEnd();
    onNewConversation({ text: remainder, attachments });
    setValue('');
    setAttachments([]);
    setSendTick((n) => n + 1);
    inputRef.current?.focus();
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 && attachments.length === 0) return;
  onSubmit({ text: trimmed, attachments });
  setValue('');
  setAttachments([]);
  setSendTick((n) => n + 1);
  inputRef.current?.focus();
}
```

- [ ] **Step 4: Run CommandBar tests**

Run: `pnpm vitest run src/renderer/components/CommandBar.test.tsx`
Expected: PASS — new and existing tests green.

- [ ] **Step 5: Update `App.tsx` `ensureSession` to call `session.ensureForSubmit`**

Replace the `ensureSession` callback body with:

```ts
const ensureSession = useCallback(async (): Promise<string> => {
  if (inFlightSessionStart.current) return inFlightSessionStart.current;
  const p = ipc
    .invoke('session.ensureForSubmit', {
      current: activeSession?.id ?? null,
      model,
    })
    .then(({ sessionId, isNew }) => {
      if (isNew) beginSession(sessionId);
      inFlightSessionStart.current = null;
      return sessionId;
    });
  inFlightSessionStart.current = p;
  return p;
}, [activeSession, beginSession, model]);
```

- [ ] **Step 6: Pass `onNewConversation` from `App.tsx` to `CommandBar`**

Wire `onNewConversation` to a handler that:
1. Calls the existing `handleNewSession()` to create a fresh session.
2. If `text.length > 0` (or `attachments.length > 0`), then submits it on the new session via the existing send pipeline.

```ts
const handleNewConversation = useCallback(
  async ({ text, attachments }: { text: string; attachments: ImageRef[] }) => {
    const { sessionId } = await ipc.invoke('session.start', { model });
    beginSession(sessionId);
    setWindowMode('panel');
    void ipc.invoke('window.setMode', { mode: 'panel' });
    if (text.length > 0 || attachments.length > 0) {
      appendUserMessage(crypto.randomUUID(), text, attachments);
      await ipc.invoke('session.send', { sessionId, text, attachments });
      void ipc.invoke('session.list', undefined).then(setSessions);
    }
  },
  [beginSession, setWindowMode, setSessions, appendUserMessage, model],
);
```

Pass `onNewConversation={handleNewConversation}` to `<CommandBar />`.

- [ ] **Step 7: Add a global "new conversation" shortcut handler in App.tsx**

```ts
useEffect(() => {
  function onKey(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
      e.preventDefault();
      void handleNewConversation({ text: '', attachments: [] });
    }
  }
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}, [handleNewConversation]);
```

- [ ] **Step 8: Run full renderer test suite + typecheck**

Run: `pnpm vitest run && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/components/CommandBar.tsx src/renderer/components/CommandBar.test.tsx src/renderer/App.tsx
git commit -m "feat(renderer): wire /n prefix, ensureForSubmit, and Cmd+Shift+N shortcut"
```

---

## Task 7: New-conversation divider in the chat view

**Files:**
- Modify: the message-list component (find it via `grep -rn "messages.map" src/renderer/components` — likely `Chat.tsx` or similar)
- Test: matching test file

- [ ] **Step 1: Identify the list component**

Run: `pnpm exec grep -rn "messages.map\|message.id" src/renderer/components`. The component rendering the active session's `messages` array is the target.

- [ ] **Step 2: Write a failing test**

In the matching `.test.tsx`, mount the component with two adjacent messages whose `sessionId` differs, and assert a divider with text matching `/New conversation/` appears between them. If `sessionId` isn't tracked per message in the message-list shape, instead test that when the component receives a fresh `sessionId` (different from the previous render's), it renders the divider at the top of the new session's messages.

(If the existing store/message types do not expose per-session boundary information to the list, add a small `boundaries: { messageId: string; startedAt: number }[]` field to the renderer store and append to it inside `beginSession`. Keep this change minimal — one array, one append on `beginSession`.)

Test sketch:

```tsx
it('renders a "New conversation" divider above messages from a new session', () => {
  render(
    <MessageList
      messages={[m1FromSessionA, m1FromSessionB]}
      boundaries={[{ beforeMessageId: m1FromSessionB.id, startedAt: 1717000000000 }]}
    />,
  );
  expect(screen.getByText(/New conversation/)).toBeInTheDocument();
});
```

- [ ] **Step 3: Run to verify fail**

Run: `pnpm vitest run <matching test file>`
Expected: FAIL.

- [ ] **Step 4: Implement**

In the message-list render loop, when iterating messages, if a `boundaries` entry's `beforeMessageId` equals the current `message.id`, render:

```tsx
<div className="otto-conv-divider" role="separator">
  <span>New conversation · {formatTime(boundary.startedAt)}</span>
</div>
```

Add a minimal CSS rule for `.otto-conv-divider` (faint horizontal rule, centered label). Reuse existing token classes from the codebase where possible.

- [ ] **Step 5: Wire boundary tracking in the store**

In `src/renderer/state/store.ts` (or wherever `beginSession` lives), append a `{ beforeMessageId: <next-incoming-message-id> }` entry on `beginSession`. Simplest implementation: record `pendingBoundary = true` on `beginSession`, and on the next `appendUserMessage` (or first inbound assistant message), pop it and create the boundary referencing that message id.

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(renderer): show 'New conversation' divider on session boundary"
```

---

## Task 8: Settings UI — Conversations section

**Files:**
- Modify: `src/renderer/SettingsApp.tsx`

- [ ] **Step 1: Add the section**

In `SettingsApp.tsx`, alongside the existing settings sections, add:

```tsx
<section>
  <h2>Conversations</h2>
  <label>
    Start a new conversation after this many minutes of total inactivity:
    <input
      type="number"
      min={0}
      step={1}
      value={idleMinutes}
      onChange={(e) => setIdleMinutes(Number(e.target.value))}
      onBlur={() =>
        void ipc.invoke('settings.setNewConversationIdleTimeoutMinutes', {
          minutes: idleMinutes,
        })
      }
    />
  </label>
  <p className="hint">0 disables automatic new conversations.</p>
</section>
```

Initialize `idleMinutes` from the `settings.get` result's `newConversation.idleTimeoutMinutes`.

- [ ] **Step 2: Manual verify**

Run: `pnpm dev` and open Settings. Confirm the field is present, edits persist across app restart, and value 0 disables the feature.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/SettingsApp.tsx
git commit -m "feat(settings-ui): add Conversations section with idle-timeout field"
```

---

## Task 9: Manual smoke test

- [ ] **Step 1: Run the app**

Run: `pnpm dev`

- [ ] **Step 2: Verify manual prefix**

In an existing conversation, type `/n hello`, press Enter. Expect: a divider appears, "hello" is sent as the first message of a new conversation, the previous conversation remains in the history list.

- [ ] **Step 3: Verify the header/hotkey path**

Press `Cmd/Ctrl+Shift+N` (or click the "+" / new-conversation button if present in the header). Expect: a new conversation is started with an empty input, divider visible.

- [ ] **Step 4: Verify idle timeout — short window**

In Settings, set idle timeout to `1` minute. Send a message, wait 70 seconds (no user OR assistant activity), then send another message. Expect: the second message is in a fresh conversation, divider visible.

- [ ] **Step 5: Verify long-running assistant activity does NOT trigger the timeout**

Set idle timeout to `1` minute. Ask Otto to do something that emits tool-call-result events for ~90 seconds (a screen-watch loop, a shell that tails output, etc.). After it finishes, send a follow-up. Expect: the follow-up stays in the SAME conversation — no divider, because assistant activity reset the timer.

- [ ] **Step 6: Verify disabled mode**

Set idle timeout to `0`. Wait several minutes. Send a message. Expect: SAME conversation; no divider.

- [ ] **Step 7: Mark complete**

If all six checks pass, the feature is ready for review. Note any deviations and report back before claiming done — per `superpowers:verification-before-completion`, evidence before assertions.

---

## Out of Scope (Phase 2 — separate plan)

Topic-shift detection (D) is **not** included here. It will get its own brainstorm → spec → plan cycle after this ships. The `ConversationPolicy` module is intentionally small and side-effect-free so phase 2 can extend it (additional `decide()` signals, embedding similarity input) without rework.
