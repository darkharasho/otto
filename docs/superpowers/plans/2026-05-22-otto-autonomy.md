# Otto Autonomy / Permission System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the action-class-tagged tool permission system: three autonomy modes (`strict` | `balanced` | `full-allow`), per-tool action class, inline approval cards in the chat panel, mode badge in the status footer, and a per-tool denylist hook. The framework is exercised by two new stub tools (`fake-mutate` destructive, `fake-wipe` irreversible).

**Architecture:** A new `src/main/autonomy/` module owns three units: `policy.ts` (pure matrix), `decision-broker.ts` (session-scoped state + IPC), `settings.ts` (JSON persistence + change emitter). Tool handlers in `sdk-client.ts` consult `broker.decide()` before executing. The renderer learns of pending/decided/denied calls via new IPC events and renders an inline `ApprovalCard`. Mode is global, persisted in `~/.config/otto/settings.json`, mutable at runtime via a `ModeBadge` in the status footer. Spec: `docs/superpowers/specs/2026-05-22-otto-autonomy-design.md`.

**Tech Stack:** TypeScript, Vitest, React + Tailwind, Electron IPC, Node `fs.promises`. No new dependencies.

---

## File Structure

```
src/main/autonomy/
  policy.ts                          # Task 2: pure matrix evaluator
  policy.test.ts
  settings.ts                        # Task 3: JSON persistence + change emitter
  settings.test.ts
  decision-broker.ts                 # Task 4: stateful broker + IPC emitter
  decision-broker.test.ts
src/main/agent/
  tools.ts                           # Task 1: OttoTool gains actionClass + denyPatterns; add fake-mutate, fake-wipe
  sdk-client.ts                      # Task 5: tool handlers consult broker; gated execution
  session.ts                         # Task 6: forward new IPC events; small adjustments
src/main/ipc/
  handlers.ts                        # Task 7: autonomy.* channels
src/main/index.ts                    # Task 8: wire Settings + DecisionBroker into bootstrap
src/shared/
  ipc-contract.ts                    # Task 1: new SessionEvent variants + autonomy channels (extends from Task 1)
  messages.ts                        # Task 1: pending_tool_use + tool_denied content blocks
src/renderer/
  state/store.ts                     # Task 9: reducer for new events; mode state
  state/store.test.ts                # Task 9: reducer tests
  components/ApprovalCard.tsx        # Task 10
  components/ApprovalCard.test.tsx
  components/ModeBadge.tsx           # Task 11
  components/ModeBadge.test.tsx
  components/StatusFooter.tsx        # Task 11: mount ModeBadge
  components/Message.tsx             # Task 10: render new block types
  App.tsx                            # Task 12: load mode on boot, subscribe to mode changes
tests/integration/
  autonomy.spec.ts                   # Task 13: Playwright confirm-flow scenario
```

---

## Task 1: Shared Types — Action Classes, New Content Blocks, IPC Additions

**Files:**
- Modify: `src/shared/messages.ts`
- Modify: `src/shared/ipc-contract.ts`
- Modify: `src/main/agent/tools.ts`

This task only updates type definitions and the `OttoTool` interface — no behavior changes yet. Subsequent tasks rely on these types.

- [ ] **Step 1: Extend `src/shared/messages.ts` with new content block kinds**

Add the new variants to the `ContentBlock` union (keep existing ones):

```ts
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; callId: string; name: string; input: unknown }
  | { type: 'tool_result'; callId: string; result: unknown; isError?: boolean }
  | {
      type: 'pending_tool_use';
      callId: string;
      decisionId: string;
      name: string;
      input: unknown;
      actionClass: 'read' | 'reversible' | 'destructive' | 'irreversible';
      reason: string;
      decision: 'pending' | 'approved' | 'approved-session' | 'denied';
    }
  | { type: 'tool_denied'; callId: string; name: string; input: unknown; reason: string };
```

Also add an `AutonomyMode` type and export it (used by renderer + main):

```ts
export type AutonomyMode = 'strict' | 'balanced' | 'full-allow';
export type ActionClass = 'read' | 'reversible' | 'destructive' | 'irreversible';
```

- [ ] **Step 2: Extend `src/shared/ipc-contract.ts` with autonomy channels and new SessionEvent variants**

Append to imports:

```ts
import type { Message, SessionMeta, AutonomyMode, ActionClass } from './messages';
```

Add new `SessionEvent` variants (alongside the existing ones):

```ts
export type SessionEvent =
  // ... existing variants ...
  | {
      type: 'tool-call-pending';
      sessionId: string;
      messageId: string;
      callId: string;
      decisionId: string;
      name: string;
      input: unknown;
      actionClass: ActionClass;
      reason: string;
    }
  | {
      type: 'tool-call-decided';
      sessionId: string;
      messageId: string;
      callId: string;
      decisionId: string;
      decision: 'approve' | 'approve-session' | 'deny';
    }
  | {
      type: 'tool-call-denied';
      sessionId: string;
      messageId: string;
      callId: string;
      name: string;
      input: unknown;
      reason: string;
    };
```

Add new request channels to `IpcRequest`:

```ts
export type IpcRequest =
  // ... existing variants ...
  | {
      channel: 'autonomy.decide';
      args: { decisionId: string; decision: 'approve' | 'approve-session' | 'deny' };
      result: void;
    }
  | { channel: 'autonomy.getMode'; args: void; result: AutonomyMode }
  | { channel: 'autonomy.setMode'; args: { mode: AutonomyMode }; result: void };
```

Add a new main → renderer event channel (analogous to `SESSION_EVENT_CHANNEL`):

```ts
export const AUTONOMY_EVENT_CHANNEL = 'autonomy.event';

export type AutonomyEvent =
  | { type: 'mode-changed'; mode: AutonomyMode };
```

Extend `OttoBridge`:

```ts
export interface OttoBridge {
  invoke<C extends IpcChannel>(
    channel: C,
    args: Extract<IpcRequest, { channel: C }>['args']
  ): Promise<Extract<IpcRequest, { channel: C }>['result']>;
  onSessionEvent(handler: (event: SessionEvent) => void): () => void;
  onAutonomyEvent(handler: (event: AutonomyEvent) => void): () => void;
}
```

- [ ] **Step 3: Update preload to expose `onAutonomyEvent`**

Modify `src/preload/index.ts` — add the autonomy event listener alongside `onSessionEvent`. The exact pattern: add another helper that wraps `ipcRenderer.on(AUTONOMY_EVENT_CHANNEL, ...)`. Mirror the existing structure verbatim, just with the new channel constant. (You can read `src/preload/index.ts` to see the existing shape.)

After the change, `window.otto.onAutonomyEvent(handler)` returns an unsubscribe function.

- [ ] **Step 4: Extend `OttoTool` interface in `src/main/agent/tools.ts`**

Modify the interface and update existing `echoTool`. Replace the file's exports with:

```ts
import { z } from 'zod';
import type { ActionClass } from '@shared/messages';

export interface OttoTool {
  name: string;
  description: string;
  actionClass: ActionClass;
  schema: z.ZodTypeAny;
  /** Optional pre-execution check. Return a deny reason string or null. */
  denyPatterns?(input: unknown): string | null;
  run(input: unknown): Promise<unknown>;
}

export const echoTool: OttoTool = {
  name: 'echo',
  description: 'Echoes back its input. Used to verify the tool-call pipeline.',
  actionClass: 'read',
  schema: z.object({ msg: z.string() }),
  async run(input) {
    const parsed = echoTool.schema.parse(input) as { msg: string };
    return parsed.msg;
  },
};

export const fakeMutateTool: OttoTool = {
  name: 'fake-mutate',
  description:
    'Pretends to mutate state. Tagged destructive so the autonomy framework prompts for approval. No real side effects.',
  actionClass: 'destructive',
  schema: z.object({ target: z.string() }),
  async run(input) {
    const parsed = fakeMutateTool.schema.parse(input) as { target: string };
    return `Pretended to mutate ${parsed.target}`;
  },
};

export const fakeWipeTool: OttoTool = {
  name: 'fake-wipe',
  description:
    'Pretends to perform an irreversible wipe. Tagged irreversible so the autonomy framework treats it strictly. No real side effects.',
  actionClass: 'irreversible',
  schema: z.object({ target: z.string() }),
  async run(input) {
    const parsed = fakeWipeTool.schema.parse(input) as { target: string };
    return `Pretended to wipe ${parsed.target}`;
  },
};

export const stubTools: OttoTool[] = [echoTool, fakeMutateTool, fakeWipeTool];
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (No tests changed; type extensions only.)

- [ ] **Step 6: Run existing tests**

Run: `npm run test`
Expected: PASS (40+ tests; no new tests yet).

If existing component tests assert specific tool sets, update only the assertions that explicitly count tools. Most tests work with whichever tools are registered.

- [ ] **Step 7: Commit**

```bash
git add src/shared/messages.ts src/shared/ipc-contract.ts src/preload/index.ts src/main/agent/tools.ts
git commit -m "feat(autonomy): extend shared types — action classes, blocks, channels"
```

---

## Task 2: Policy Module — The Matrix

**Files:**
- Create: `src/main/autonomy/policy.ts`
- Test: `src/main/autonomy/policy.test.ts`

- [ ] **Step 1: Write the failing test**

`src/main/autonomy/policy.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { evaluate, type Decision } from './policy';
import type { ActionClass, AutonomyMode } from '@shared/messages';

describe('evaluate', () => {
  const cases: Array<[AutonomyMode, ActionClass, Decision]> = [
    ['strict', 'read', 'allow'],
    ['strict', 'reversible', 'confirm'],
    ['strict', 'destructive', 'confirm'],
    ['strict', 'irreversible', 'deny'],
    ['balanced', 'read', 'allow'],
    ['balanced', 'reversible', 'allow'],
    ['balanced', 'destructive', 'confirm'],
    ['balanced', 'irreversible', 'deny'],
    ['full-allow', 'read', 'allow'],
    ['full-allow', 'reversible', 'allow'],
    ['full-allow', 'destructive', 'allow'],
    ['full-allow', 'irreversible', 'confirm'],
  ];

  for (const [mode, cls, expected] of cases) {
    it(`${mode} + ${cls} -> ${expected}`, () => {
      expect(evaluate(mode, cls)).toBe(expected);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/main/autonomy/policy.test.ts`
Expected: FAIL with "Cannot find module './policy'".

- [ ] **Step 3: Create `src/main/autonomy/policy.ts`**

```ts
import type { ActionClass, AutonomyMode } from '@shared/messages';

export type Decision = 'allow' | 'confirm' | 'deny';

const MATRIX: Record<AutonomyMode, Record<ActionClass, Decision>> = {
  strict: {
    read: 'allow',
    reversible: 'confirm',
    destructive: 'confirm',
    irreversible: 'deny',
  },
  balanced: {
    read: 'allow',
    reversible: 'allow',
    destructive: 'confirm',
    irreversible: 'deny',
  },
  'full-allow': {
    read: 'allow',
    reversible: 'allow',
    destructive: 'allow',
    irreversible: 'confirm',
  },
};

export function evaluate(mode: AutonomyMode, actionClass: ActionClass): Decision {
  return MATRIX[mode][actionClass];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/main/autonomy/policy.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/autonomy/policy.ts src/main/autonomy/policy.test.ts
git commit -m "feat(autonomy): add policy matrix evaluator"
```

---

## Task 3: Settings — JSON Persistence with Change Emitter

**Files:**
- Create: `src/main/autonomy/settings.ts`
- Test: `src/main/autonomy/settings.test.ts`

- [ ] **Step 1: Write the failing test**

`src/main/autonomy/settings.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Settings } from './settings';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-settings-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function settingsPath(): string {
  return path.join(dir, 'settings.json');
}

describe('Settings.load', () => {
  it('returns defaults when file is missing and writes a fresh defaults file', async () => {
    const s = new Settings(settingsPath());
    await s.load();
    expect(s.getMode()).toBe('balanced');
    const written = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(written).toEqual({ version: 1, autonomy: { mode: 'balanced' } });
  });

  it('returns existing mode from a v1 file', async () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ version: 1, autonomy: { mode: 'strict' } })
    );
    const s = new Settings(settingsPath());
    await s.load();
    expect(s.getMode()).toBe('strict');
  });

  it('returns defaults and warns on malformed JSON', async () => {
    writeFileSync(settingsPath(), '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new Settings(settingsPath());
    await s.load();
    expect(s.getMode()).toBe('balanced');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns defaults and warns on unknown future version', async () => {
    writeFileSync(settingsPath(), JSON.stringify({ version: 99, autonomy: { mode: 'strict' } }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new Settings(settingsPath());
    await s.load();
    expect(s.getMode()).toBe('balanced');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('Settings.setMode', () => {
  it('persists atomically and fires onChange listeners', async () => {
    const s = new Settings(settingsPath());
    await s.load();
    const events: string[] = [];
    const unsub = s.onChange((mode) => events.push(mode));
    await s.setMode('strict');
    expect(s.getMode()).toBe('strict');
    expect(events).toEqual(['strict']);
    const written = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(written.autonomy.mode).toBe('strict');
    unsub();
    await s.setMode('full-allow');
    expect(events).toEqual(['strict']); // no new events after unsubscribe
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/main/autonomy/settings.test.ts`
Expected: FAIL with "Cannot find module './settings'".

- [ ] **Step 3: Create `src/main/autonomy/settings.ts`**

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AutonomyMode } from '@shared/messages';

const CURRENT_VERSION = 1;
const DEFAULT_MODE: AutonomyMode = 'balanced';
const VALID_MODES: AutonomyMode[] = ['strict', 'balanced', 'full-allow'];

interface SettingsFile {
  version: number;
  autonomy: { mode: AutonomyMode };
}

type Listener = (mode: AutonomyMode) => void;

export class Settings {
  private mode: AutonomyMode = DEFAULT_MODE;
  private listeners = new Set<Listener>();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    let parsed: unknown = null;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      parsed = JSON.parse(raw);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        await this.writeDefaults();
        return;
      }
      console.warn(`[settings] could not read ${this.filePath}, using defaults:`, err);
      await this.writeDefaults();
      return;
    }

    const ok = this.applyParsed(parsed);
    if (!ok) {
      console.warn(`[settings] ${this.filePath} is malformed or has unknown version; using defaults`);
      await this.writeDefaults();
    }
  }

  getMode(): AutonomyMode {
    return this.mode;
  }

  async setMode(mode: AutonomyMode): Promise<void> {
    if (!VALID_MODES.includes(mode)) {
      throw new Error(`invalid mode: ${mode}`);
    }
    this.mode = mode;
    await this.writeFile();
    for (const fn of this.listeners) fn(mode);
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private applyParsed(parsed: unknown): boolean {
    if (!parsed || typeof parsed !== 'object') return false;
    const obj = parsed as Partial<SettingsFile>;
    if (obj.version !== CURRENT_VERSION) return false;
    const m = obj.autonomy?.mode;
    if (!m || !VALID_MODES.includes(m)) return false;
    this.mode = m;
    return true;
  }

  private async writeDefaults(): Promise<void> {
    this.mode = DEFAULT_MODE;
    await this.writeFile();
  }

  private async writeFile(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const payload: SettingsFile = { version: CURRENT_VERSION, autonomy: { mode: this.mode } };
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2));
    await fs.rename(tmp, this.filePath);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/main/autonomy/settings.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/autonomy/settings.ts src/main/autonomy/settings.test.ts
git commit -m "feat(autonomy): add Settings (JSON persistence + change emitter)"
```

---

## Task 4: DecisionBroker — Session-Scoped State + IPC

**Files:**
- Create: `src/main/autonomy/decision-broker.ts`
- Test: `src/main/autonomy/decision-broker.test.ts`

- [ ] **Step 1: Write the failing test**

`src/main/autonomy/decision-broker.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DecisionBroker, type DecideArgs } from './decision-broker';
import type { SessionEvent } from '@shared/ipc-contract';
import type { AutonomyMode } from '@shared/messages';

function makeBroker(initialMode: AutonomyMode = 'balanced') {
  const events: SessionEvent[] = [];
  const emit = (e: SessionEvent) => events.push(e);
  const broker = new DecisionBroker(initialMode, emit);
  return { broker, events };
}

function args(overrides: Partial<DecideArgs> = {}): DecideArgs {
  return {
    sessionId: 's1',
    messageId: 'm1',
    callId: `c-${Math.random().toString(36).slice(2)}`,
    toolName: 'tool-x',
    actionClass: 'destructive',
    input: { a: 1 },
    denyPatternsFn: null,
    ...overrides,
  };
}

describe('DecisionBroker.decide', () => {
  it('returns allow immediately when matrix says allow', async () => {
    const { broker, events } = makeBroker('balanced');
    const result = await broker.decide(args({ actionClass: 'read' }));
    expect(result).toBe('allow');
    expect(events).toEqual([]);
  });

  it('returns deny synchronously and emits tool-call-denied when matrix says deny', async () => {
    const { broker, events } = makeBroker('strict');
    const result = await broker.decide(args({ actionClass: 'irreversible' }));
    expect(result).toBe('deny');
    const e = events[0]!;
    expect(e.type).toBe('tool-call-denied');
  });

  it('returns deny synchronously when denyPatternsFn returns a reason', async () => {
    const { broker, events } = makeBroker('full-allow');
    const result = await broker.decide(
      args({
        actionClass: 'read',
        denyPatternsFn: () => 'because reasons',
      })
    );
    expect(result).toBe('deny');
    const e = events[0]!;
    expect(e.type).toBe('tool-call-denied');
    if (e.type === 'tool-call-denied') expect(e.reason).toBe('because reasons');
  });

  it('emits tool-call-pending on confirm and resolves on approve', async () => {
    const { broker, events } = makeBroker('balanced');
    const p = broker.decide(args({ actionClass: 'destructive' }));
    expect(events).toHaveLength(1);
    const pending = events[0]!;
    expect(pending.type).toBe('tool-call-pending');
    if (pending.type !== 'tool-call-pending') throw new Error('unreachable');
    broker.resolve(pending.decisionId, 'approve');
    const result = await p;
    expect(result).toBe('allow');
    expect(events[events.length - 1]!.type).toBe('tool-call-decided');
  });

  it('approve-session adds to cache; subsequent same-tool calls allow without prompting', async () => {
    const { broker, events } = makeBroker('balanced');
    const a = broker.decide(args({ callId: 'a', actionClass: 'destructive' }));
    const pending = events.find((e) => e.type === 'tool-call-pending');
    if (!pending || pending.type !== 'tool-call-pending') throw new Error('expected pending');
    broker.resolve(pending.decisionId, 'approve-session');
    await a;
    events.length = 0;
    const b = await broker.decide(args({ callId: 'b', actionClass: 'destructive' }));
    expect(b).toBe('allow');
    expect(events).toEqual([]);
  });

  it('approve-session does NOT bypass denylist', async () => {
    const { broker, events } = makeBroker('balanced');
    const a = broker.decide(args({ callId: 'a', actionClass: 'destructive' }));
    const pending = events.find((e) => e.type === 'tool-call-pending');
    if (!pending || pending.type !== 'tool-call-pending') throw new Error('expected pending');
    broker.resolve(pending.decisionId, 'approve-session');
    await a;
    events.length = 0;
    const b = await broker.decide(
      args({ callId: 'b', actionClass: 'destructive', denyPatternsFn: () => 'no' })
    );
    expect(b).toBe('deny');
  });

  it('deny on confirm resolves the call as deny', async () => {
    const { broker, events } = makeBroker('balanced');
    const p = broker.decide(args({ actionClass: 'destructive' }));
    const pending = events.find((e) => e.type === 'tool-call-pending');
    if (!pending || pending.type !== 'tool-call-pending') throw new Error('expected pending');
    broker.resolve(pending.decisionId, 'deny');
    const result = await p;
    expect(result).toBe('deny');
  });

  it('mode-change isolation: decision started in strict stays strict even if mode flips', async () => {
    const { broker, events } = makeBroker('strict');
    // 'strict' + 'reversible' = confirm
    const p = broker.decide(args({ actionClass: 'reversible' }));
    broker.setMode('full-allow'); // would have been allow
    const pending = events.find((e) => e.type === 'tool-call-pending');
    if (!pending || pending.type !== 'tool-call-pending') throw new Error('expected pending');
    broker.resolve(pending.decisionId, 'deny');
    const result = await p;
    expect(result).toBe('deny');
  });

  it('times out after 5 minutes and resolves as deny', async () => {
    vi.useFakeTimers();
    try {
      const { broker, events } = makeBroker('balanced');
      const p = broker.decide(args({ actionClass: 'destructive' }));
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      const result = await p;
      expect(result).toBe('deny');
      const decided = events.find((e) => e.type === 'tool-call-decided');
      expect(decided).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/main/autonomy/decision-broker.test.ts`
Expected: FAIL with "Cannot find module './decision-broker'".

- [ ] **Step 3: Create `src/main/autonomy/decision-broker.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { SessionEvent } from '@shared/ipc-contract';
import type { ActionClass, AutonomyMode } from '@shared/messages';
import { evaluate, type Decision } from './policy';

export interface DecideArgs {
  sessionId: string;
  messageId: string;
  callId: string;
  toolName: string;
  actionClass: ActionClass;
  input: unknown;
  /** Optional pre-check that returns a deny reason or null. */
  denyPatternsFn: ((input: unknown) => string | null) | null;
}

type UserChoice = 'approve' | 'approve-session' | 'deny';

interface Pending {
  resolver: (outcome: 'allow' | 'deny') => void;
  toolName: string;
  sessionId: string;
  messageId: string;
  callId: string;
  timer: NodeJS.Timeout;
}

const DECISION_TIMEOUT_MS = 5 * 60 * 1000;

export class DecisionBroker {
  private mode: AutonomyMode;
  private readonly pending = new Map<string, Pending>();
  private readonly sessionAllow = new Set<string>(); // `${sessionId}::${toolName}`

  constructor(initialMode: AutonomyMode, private readonly emit: (e: SessionEvent) => void) {
    this.mode = initialMode;
  }

  setMode(mode: AutonomyMode): void {
    this.mode = mode;
  }

  async decide(args: DecideArgs): Promise<'allow' | 'deny'> {
    if (args.denyPatternsFn) {
      const reason = args.denyPatternsFn(args.input);
      if (reason !== null) {
        this.emitDenied(args, reason);
        return 'deny';
      }
    }

    const cacheKey = `${args.sessionId}::${args.toolName}`;
    if (this.sessionAllow.has(cacheKey)) {
      return 'allow';
    }

    const policyOutcome: Decision = evaluate(this.mode, args.actionClass);
    if (policyOutcome === 'allow') return 'allow';
    if (policyOutcome === 'deny') {
      this.emitDenied(args, `mode=${this.mode}, class=${args.actionClass}`);
      return 'deny';
    }

    // policyOutcome === 'confirm'
    const decisionId = randomUUID();
    const reason = `mode=${this.mode}, class=${args.actionClass}`;

    return new Promise<'allow' | 'deny'>((resolve) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(decisionId);
        if (!entry) return;
        this.pending.delete(decisionId);
        this.emit({
          type: 'tool-call-decided',
          sessionId: args.sessionId,
          messageId: args.messageId,
          callId: args.callId,
          decisionId,
          decision: 'deny',
        });
        entry.resolver('deny');
      }, DECISION_TIMEOUT_MS);

      this.pending.set(decisionId, {
        resolver: resolve,
        toolName: args.toolName,
        sessionId: args.sessionId,
        messageId: args.messageId,
        callId: args.callId,
        timer,
      });

      this.emit({
        type: 'tool-call-pending',
        sessionId: args.sessionId,
        messageId: args.messageId,
        callId: args.callId,
        decisionId,
        name: args.toolName,
        input: args.input,
        actionClass: args.actionClass,
        reason,
      });
    });
  }

  resolve(decisionId: string, choice: UserChoice): void {
    const entry = this.pending.get(decisionId);
    if (!entry) return;
    this.pending.delete(decisionId);
    clearTimeout(entry.timer);

    if (choice === 'approve-session') {
      this.sessionAllow.add(`${entry.sessionId}::${entry.toolName}`);
    }

    this.emit({
      type: 'tool-call-decided',
      sessionId: entry.sessionId,
      messageId: entry.messageId,
      callId: entry.callId,
      decisionId,
      decision: choice,
    });

    entry.resolver(choice === 'deny' ? 'deny' : 'allow');
  }

  private emitDenied(args: DecideArgs, reason: string): void {
    this.emit({
      type: 'tool-call-denied',
      sessionId: args.sessionId,
      messageId: args.messageId,
      callId: args.callId,
      name: args.toolName,
      input: args.input,
      reason,
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/main/autonomy/decision-broker.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/autonomy/decision-broker.ts src/main/autonomy/decision-broker.test.ts
git commit -m "feat(autonomy): add DecisionBroker (matrix + denylist + session cache + timeout)"
```

---

## Task 5: Wire DecisionBroker into the SDK Tool Handlers

**Files:**
- Modify: `src/main/agent/sdk-client.ts`

The MCP tool handler in `sdk-client.ts` becomes the enforcement boundary. It needs:
1. Access to the broker (passed via constructor / factory args).
2. Access to the active sessionId and the `messageId` of the assistant message being authored.
3. Access to each tool's `denyPatterns`.

Today, `sdk-client.ts` exports `createRealSdkClient(): SdkClient`. We change this to `createRealSdkClient(deps: { broker: DecisionBroker })`, and `SessionManager` passes `sessionId` / `messageId` / `callId` through to the SDK by way of the handler's closure.

This is tricky because the MCP handler runs inside the SDK, deep in `query()`. We need a way to associate each in-flight tool call with its session/message context. The cleanest approach: in `sendTurn`, set "turn context" on a closure-captured variable that the handlers read. The closure captures `{ broker, sessionId, messageId, denyByToolName }`, and re-builds the MCP server per turn so it always has fresh context. The MCP server is cheap to construct.

- [ ] **Step 1: Update `createRealSdkClient` to accept dependencies and rebuild MCP per turn**

Replace `src/main/agent/sdk-client.ts` with:

```ts
import type { SdkClient, SdkStreamEvent, SdkTurn } from './session';
import { stubTools, type OttoTool } from './tools';
import { logger } from '../logger';
import type { DecisionBroker } from '../autonomy/decision-broker';

type AgentSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');
let sdkModulePromise: Promise<AgentSdkModule> | null = null;
function loadAgentSdk(): Promise<AgentSdkModule> {
  if (!sdkModulePromise) {
    sdkModulePromise = import('@anthropic-ai/claude-agent-sdk');
  }
  return sdkModulePromise;
}

const SYSTEM_PROMPT =
  'You are Otto, a desktop coworking agent. The available tools (echo, fake-mutate, fake-wipe) are stubs in this skeleton build. Be concise.';

interface TurnContext {
  sessionId: string;
  messageId: string;
  broker: DecisionBroker;
}

function buildOttoMcpServer(sdk: AgentSdkModule, tools: OttoTool[], ctx: TurnContext) {
  const { createSdkMcpServer, tool } = sdk;
  const sdkTools = tools.map((t) => {
    const shape = (t.schema as unknown as { shape?: Record<string, unknown> }).shape;
    if (!shape) {
      throw new Error(`OttoTool ${t.name} schema must be a z.object(...) so we can pull .shape`);
    }
    return tool(
      t.name,
      t.description,
      shape as any,
      async (args: unknown, _extra: unknown) => {
        // The SDK passes callId through `_extra.toolUseId` on recent versions.
        // Fall back to a synthesized id if unavailable.
        const callId =
          (typeof _extra === 'object' && _extra && 'toolUseId' in _extra
            ? String((_extra as { toolUseId?: unknown }).toolUseId ?? '')
            : '') || `${t.name}-${Date.now().toString(36)}`;

        const outcome = await ctx.broker.decide({
          sessionId: ctx.sessionId,
          messageId: ctx.messageId,
          callId,
          toolName: t.name,
          actionClass: t.actionClass,
          input: args,
          denyPatternsFn: t.denyPatterns ? (i: unknown) => t.denyPatterns!(i) : null,
        });

        if (outcome === 'deny') {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Denied by Otto autonomy policy` }],
          };
        }

        const result = await t.run(args);
        return {
          content: [
            {
              type: 'text' as const,
              text: typeof result === 'string' ? result : JSON.stringify(result),
            },
          ],
        };
      }
    );
  });
  return createSdkMcpServer({ name: 'otto-tools', version: '0.1.0', tools: sdkTools });
}

function createFakeSdkClient(): SdkClient {
  let counter = 0;
  return {
    async startSession() {
      counter += 1;
      return { id: `fake-${counter}` };
    },
    sendTurn(_sid, text, signal, _resumeId) {
      const fakeSdkId = `fake-sdk-${(counter += 1)}`;
      async function* events(): AsyncIterable<SdkStreamEvent> {
        yield { type: 'message-start' };
        yield { type: 'session-id', id: fakeSdkId };
        for (const ch of `echo: ${text}`) {
          if (signal.aborted) return;
          yield { type: 'text-delta', text: ch };
          await new Promise((r) => setTimeout(r, 5));
        }
        yield { type: 'tool-call-start', callId: 'c1', name: 'echo', input: { msg: text } };
        yield { type: 'tool-call-result', callId: 'c1', result: text, isError: false };
        yield { type: 'message-end' };
        yield { type: 'done' };
      }
      return { signal, events };
    },
  };
}

export interface RealSdkClientDeps {
  broker: DecisionBroker;
  /** Provides the messageId of the assistant message being authored for this turn. */
  currentMessageId: () => string;
}

export function createRealSdkClient(deps: RealSdkClientDeps): SdkClient {
  if (process.env.OTTO_FAKE_SDK === '1') return createFakeSdkClient();
  let sessionCounter = 0;
  const allowedTools = stubTools.map((t) => `mcp__otto-tools__${t.name}`);

  return {
    async startSession({ resume }) {
      const id = resume ?? `otto-${Date.now().toString(36)}-${(sessionCounter += 1).toString(36)}`;
      logger.info(`sdk session start: ${id}`);
      return { id };
    },

    sendTurn(sessionId, text, signal, resumeId): SdkTurn {
      const abortController = new AbortController();
      if (signal.aborted) abortController.abort();
      else signal.addEventListener('abort', () => abortController.abort(), { once: true });

      async function* events(): AsyncIterable<SdkStreamEvent> {
        yield { type: 'message-start' };
        const sdk = await loadAgentSdk();
        const turnCtx: TurnContext = {
          sessionId,
          messageId: deps.currentMessageId(),
          broker: deps.broker,
        };
        const ottoMcp = buildOttoMcpServer(sdk, stubTools, turnCtx);
        const iter = sdk.query({
          prompt: text,
          options: {
            systemPrompt: SYSTEM_PROMPT,
            tools: [],
            allowedTools,
            mcpServers: { 'otto-tools': ottoMcp },
            abortController,
            ...(resumeId ? { resume: resumeId } : {}),
          },
        });
        try {
          for await (const msg of iter) {
            for (const ev of mapSdkMessage(msg)) {
              yield ev;
            }
          }
        } finally {
          yield { type: 'message-end' };
          yield { type: 'done' };
        }
      }

      return { signal, events };
    },
  };
}

function mapSdkMessage(msg: unknown): SdkStreamEvent[] {
  if (!msg || typeof msg !== 'object') return [];
  const m = msg as { type?: string; subtype?: string; session_id?: unknown };

  if (m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string') {
    return [{ type: 'session-id', id: m.session_id }];
  }

  if (m.type === 'assistant') {
    const am = msg as { message?: { content?: Array<Record<string, unknown>> } };
    const blocks = am.message?.content ?? [];
    const out: SdkStreamEvent[] = [];
    for (const block of blocks) {
      const bType = block.type;
      if (bType === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        out.push({ type: 'text-delta', text: block.text as string });
      } else if (bType === 'tool_use') {
        out.push({
          type: 'tool-call-start',
          callId: typeof block.id === 'string' ? block.id : '',
          name: typeof block.name === 'string' ? block.name : '',
          input: block.input,
        });
      }
    }
    return out;
  }

  if (m.type === 'user') {
    const um = msg as { message?: { content?: Array<Record<string, unknown>> } };
    const blocks = um.message?.content ?? [];
    const out: SdkStreamEvent[] = [];
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        out.push({
          type: 'tool-call-result',
          callId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
          result: block.content,
          isError: !!block.is_error,
        });
      }
    }
    return out;
  }

  return [];
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: FAIL with errors in `src/main/index.ts` and tests that call `createRealSdkClient()` (no args). We'll fix the callers in Task 6 (SessionManager + main wiring). For now, expect failures at:
- `src/main/index.ts`: `createRealSdkClient()` — needs `{ broker, currentMessageId }`.
- `src/main/agent/session.test.ts` should not break (it injects a fake SdkClient directly).

If `typecheck` flags additional places, jot them down for Task 6/8.

- [ ] **Step 3: Commit the WIP**

```bash
git add src/main/agent/sdk-client.ts
git commit -m "feat(agent): tool handlers consult DecisionBroker (callers wired in next tasks)"
```

This commit intentionally leaves `src/main/index.ts` not typechecking. Task 6 closes the loop in the same logical change set.

---

## Task 6: SessionManager Passes messageId to SDK; Forwards New Events

**Files:**
- Modify: `src/main/agent/session.ts`

`SessionManager` currently:
- Owns the in-progress assistant message (with its `id`) inside `send()`.
- Calls `sdk.sendTurn(sessionId, text, signal, resumeId)`.

We need the SDK tool handlers to know the current `messageId`. Two cleanest paths:
- (A) Have `SessionManager` give the SDK client a `currentMessageId()` getter that returns the most recent assistant message id of the active turn.
- (B) Pass `messageId` as a fourth arg to `sendTurn`.

Path (A) is less invasive because `sdk-client.ts` already takes `deps`. SessionManager owns a tiny `let currentMessageId: string | null = null` updated at the start of each `send()`, and the dep getter reads it.

- [ ] **Step 1: Make SessionManager expose the current message id via a getter passed to the SDK client at bootstrap**

The SessionManager doesn't construct the SdkClient (the bootstrap does). So the bootstrap will:
1. Construct the `DecisionBroker` first.
2. Define a `let currentMessageId: string | null = null` in the bootstrap closure.
3. Pass `currentMessageId: () => currentMessageId ?? ''` and `broker` into `createRealSdkClient(...)`.
4. Construct `SessionManager`, giving it a callback `setCurrentMessageId: (id: string) => void`.
5. SessionManager calls that callback inside `send()` after generating the assistant message id.

To support this cleanly, add a small optional constructor option to `SessionManager`. Modify the constructor signature in `src/main/agent/session.ts`:

```ts
export class SessionManager {
  private readonly aborts = new Map<string, AbortController>();
  private activeSessionId: string | null = null;

  constructor(
    private readonly repo: Repo,
    private readonly sdk: SdkClient,
    private readonly defaultModel: string,
    private readonly emit: Emitter,
    private readonly onAssistantMessageId: (messageId: string) => void = () => {}
  ) {}
```

Then in `send()`, right after constructing `assistant`, call:

```ts
this.onAssistantMessageId(assistant.id);
```

(Place it on its own line, right before `this.emit({ type: 'message-start', ... })`.)

- [ ] **Step 2: Forward new session events through SessionManager**

`SessionManager` doesn't currently know about `tool-call-pending`, `tool-call-decided`, or `tool-call-denied`. These are emitted DIRECTLY by `DecisionBroker.emit(...)` — but the broker uses the SAME emitter pattern, so we can wire the broker's emitter to be the same IPC `emitSessionEvent` SessionManager uses. No new code is needed inside SessionManager itself; we just need to ensure both broker and SessionManager share the renderer-side IPC event channel.

This is a bootstrap-wiring concern (Task 8). SessionManager code in this task only adds the `onAssistantMessageId` callback.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: still fails on the `src/main/index.ts` wiring (Task 8). Local SessionManager + tests should be clean otherwise.

- [ ] **Step 4: Update SessionManager tests (none of the existing tests pass the new callback; the default no-op is fine)**

Run: `npm run test -- src/main/agent/session.test.ts`
Expected: PASS (existing tests unaffected; new callback is optional and defaults to a no-op).

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/session.ts
git commit -m "feat(agent): SessionManager surfaces current assistant messageId for autonomy"
```

---

## Task 7: IPC Handlers — autonomy.* channels

**Files:**
- Modify: `src/main/ipc/handlers.ts`
- Modify: `src/main/ipc/events.ts`

Adds three new request channels (`autonomy.decide`, `autonomy.getMode`, `autonomy.setMode`) and the broadcast emitter for `autonomy.event`.

- [ ] **Step 1: Add an `emitAutonomyEvent` helper to `src/main/ipc/events.ts`**

Modify the existing file to add (alongside `emitSessionEvent`):

```ts
import { BrowserWindow } from 'electron';
import {
  SESSION_EVENT_CHANNEL,
  AUTONOMY_EVENT_CHANNEL,
  type SessionEvent,
  type AutonomyEvent,
} from '@shared/ipc-contract';

export function emitSessionEvent(event: SessionEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(SESSION_EVENT_CHANNEL, event);
  }
}

export function emitAutonomyEvent(event: AutonomyEvent): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(AUTONOMY_EVENT_CHANNEL, event);
  }
}
```

- [ ] **Step 2: Extend the handler registration**

Replace `src/main/ipc/handlers.ts` with:

```ts
import { ipcMain } from 'electron';
import type { Repo } from '../db/repo';
import type { SessionManager } from '../agent/session';
import type { WindowManager } from '../window';
import type { DecisionBroker } from '../autonomy/decision-broker';
import type { Settings } from '../autonomy/settings';
import type {
  SessionStartArgs,
  SessionStartResult,
  SessionSendArgs,
  SessionCancelArgs,
  SessionLoadArgs,
} from '@shared/ipc-contract';
import type { Message, SessionMeta, AutonomyMode } from '@shared/messages';
import { logger } from '../logger';
import { emitAutonomyEvent } from './events';

export function registerIpcHandlers(deps: {
  repo: Repo;
  sessions: SessionManager;
  window: WindowManager;
  broker: DecisionBroker;
  settings: Settings;
}): void {
  const { repo, sessions, window, broker, settings } = deps;

  ipcMain.handle('session.start', async (_e, args: SessionStartArgs): Promise<SessionStartResult> => {
    return sessions.start(args);
  });

  ipcMain.handle('session.send', async (_e, args: SessionSendArgs): Promise<void> => {
    await sessions.send(args);
  });

  ipcMain.handle('session.cancel', async (_e, args: SessionCancelArgs): Promise<void> => {
    sessions.cancel(args);
  });

  ipcMain.handle('session.list', async (): Promise<SessionMeta[]> => {
    return repo.listSessions();
  });

  ipcMain.handle('session.load', async (_e, args: SessionLoadArgs): Promise<Message[]> => {
    return repo.loadMessages(args.sessionId);
  });

  ipcMain.handle('window.setMode', async (_e, args: { mode: 'bar' | 'panel' }): Promise<void> => {
    window.setMode(args.mode);
  });

  ipcMain.handle(
    'autonomy.decide',
    async (_e, args: { decisionId: string; decision: 'approve' | 'approve-session' | 'deny' }): Promise<void> => {
      broker.resolve(args.decisionId, args.decision);
    }
  );

  ipcMain.handle('autonomy.getMode', async (): Promise<AutonomyMode> => settings.getMode());

  ipcMain.handle('autonomy.setMode', async (_e, args: { mode: AutonomyMode }): Promise<void> => {
    try {
      await settings.setMode(args.mode);
    } catch (err) {
      logger.error('failed to set mode', err);
      // Re-emit the current mode so the renderer rolls back.
      emitAutonomyEvent({ type: 'mode-changed', mode: settings.getMode() });
      throw err;
    }
  });

  // Bridge settings changes (whether triggered by IPC or internal) to renderer.
  settings.onChange((mode) => {
    broker.setMode(mode);
    emitAutonomyEvent({ type: 'mode-changed', mode });
  });

  logger.info('ipc handlers registered');
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: still fails on `src/main/index.ts` (Task 8). Other modules clean.

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/handlers.ts src/main/ipc/events.ts
git commit -m "feat(ipc): autonomy.decide / getMode / setMode channels + autonomy event channel"
```

---

## Task 8: Main Bootstrap — Wire Settings + Broker into the App

**Files:**
- Modify: `src/main/index.ts`

This task closes the loop. The bootstrap:
1. Constructs `Settings`, calls `await settings.load()`.
2. Constructs the `DecisionBroker` with `settings.getMode()` and the same `emitSessionEvent` used everywhere else.
3. Declares `let currentMessageId: string | null = null` in the closure.
4. Constructs `createRealSdkClient({ broker, currentMessageId: () => currentMessageId ?? '' })`.
5. Constructs `SessionManager`, passing `(id) => { currentMessageId = id; }` as the fifth arg.
6. Passes `broker` and `settings` into `registerIpcHandlers`.

- [ ] **Step 1: Modify `src/main/index.ts`**

In the `startElectron()` function, after the existing `ottoConfigDir` resolution, add:

```ts
const { Settings } = await import('./autonomy/settings');
const { DecisionBroker } = await import('./autonomy/decision-broker');
```

Replace the construction block that creates `sdk` and `sessions`:

```ts
// (existing) const sdk = createRealSdkClient();
// (existing) const sessions = new SessionManager(repo, sdk, 'claude-sonnet-4-6', emitSessionEvent);
```

with:

```ts
const settings = new Settings(path.join(ottoConfigDir, 'settings.json'));
await settings.load();

let currentMessageId: string | null = null;
const broker = new DecisionBroker(settings.getMode(), emitSessionEvent);

const sdk = createRealSdkClient({
  broker,
  currentMessageId: () => currentMessageId ?? '',
});
const sessions = new SessionManager(
  repo,
  sdk,
  'claude-sonnet-4-6',
  emitSessionEvent,
  (id) => {
    currentMessageId = id;
  }
);
```

And update the `registerIpcHandlers` call:

```ts
registerIpcHandlers({ repo, sessions, window, broker, settings });
```

Make sure the import line `import { createRealSdkClient } from './agent/sdk-client'` stays a dynamic import like the others (`const { createRealSdkClient } = await import('./agent/sdk-client');`).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Run tests**

Run: `npm run test`
Expected: PASS — existing 40+ tests still green, plus the new Tasks 2/3/4 tests for the autonomy module.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(main): wire Settings + DecisionBroker into bootstrap"
```

---

## Task 9: Renderer Store — Reducer for New Events + Mode State

**Files:**
- Modify: `src/renderer/state/store.ts`
- Modify: `src/renderer/state/store.test.ts`

Extends the zustand store with:
- `mode: AutonomyMode` (default `balanced`; updated by mode-changed events and explicit `setMode`).
- Reducer cases for `tool-call-pending`, `tool-call-decided`, `tool-call-denied`.

- [ ] **Step 1: Write failing tests**

Append to `src/renderer/state/store.test.ts`:

```ts
describe('autonomy mode state', () => {
  it('defaults to balanced', () => {
    expect(useOttoStore.getState().mode).toBe('balanced');
  });

  it('setMode updates the mode', () => {
    useOttoStore.getState().setMode('strict');
    expect(useOttoStore.getState().mode).toBe('strict');
  });
});

describe('store: tool approval events', () => {
  beforeEach(() => {
    useOttoStore.getState().reset();
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().applyEvent({
      type: 'message-start',
      sessionId: 's1',
      messageId: 'm1',
    });
  });

  it('handles tool-call-pending by appending a pending_tool_use block', () => {
    useOttoStore.getState().applyEvent({
      type: 'tool-call-pending',
      sessionId: 's1',
      messageId: 'm1',
      callId: 'c1',
      decisionId: 'd1',
      name: 'fake-mutate',
      input: { target: 'x' },
      actionClass: 'destructive',
      reason: 'mode=balanced',
    });
    const blocks = useOttoStore.getState().activeSession!.messages[0]!.content;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'pending_tool_use',
      callId: 'c1',
      decisionId: 'd1',
      decision: 'pending',
      actionClass: 'destructive',
    });
  });

  it('transforms pending block on tool-call-decided approve', () => {
    useOttoStore.getState().applyEvent({
      type: 'tool-call-pending',
      sessionId: 's1',
      messageId: 'm1',
      callId: 'c1',
      decisionId: 'd1',
      name: 'fake-mutate',
      input: { target: 'x' },
      actionClass: 'destructive',
      reason: 'mode=balanced',
    });
    useOttoStore.getState().applyEvent({
      type: 'tool-call-decided',
      sessionId: 's1',
      messageId: 'm1',
      callId: 'c1',
      decisionId: 'd1',
      decision: 'approve',
    });
    const blocks = useOttoStore.getState().activeSession!.messages[0]!.content;
    expect(blocks[0]).toMatchObject({ type: 'pending_tool_use', decision: 'approved' });
  });

  it('transforms pending block on tool-call-decided deny', () => {
    useOttoStore.getState().applyEvent({
      type: 'tool-call-pending',
      sessionId: 's1',
      messageId: 'm1',
      callId: 'c1',
      decisionId: 'd1',
      name: 'fake-mutate',
      input: { target: 'x' },
      actionClass: 'destructive',
      reason: 'mode=balanced',
    });
    useOttoStore.getState().applyEvent({
      type: 'tool-call-decided',
      sessionId: 's1',
      messageId: 'm1',
      callId: 'c1',
      decisionId: 'd1',
      decision: 'deny',
    });
    const blocks = useOttoStore.getState().activeSession!.messages[0]!.content;
    expect(blocks[0]).toMatchObject({ type: 'pending_tool_use', decision: 'denied' });
  });

  it('appends tool_denied block on tool-call-denied (denylist or matrix)', () => {
    useOttoStore.getState().applyEvent({
      type: 'tool-call-denied',
      sessionId: 's1',
      messageId: 'm1',
      callId: 'c2',
      name: 'fake-wipe',
      input: { target: 'y' },
      reason: 'mode=strict, class=irreversible',
    });
    const blocks = useOttoStore.getState().activeSession!.messages[0]!.content;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'tool_denied',
      callId: 'c2',
      name: 'fake-wipe',
      reason: 'mode=strict, class=irreversible',
    });
  });
});
```

- [ ] **Step 2: Run tests to verify failures**

Run: `npm run test -- src/renderer/state/store.test.ts`
Expected: FAIL on the new tests.

- [ ] **Step 3: Update `src/renderer/state/store.ts`**

Extend the state shape:

```ts
// near the top, alongside other type imports:
import type { AutonomyMode } from '@shared/messages';

// in the OttoState interface:
mode: AutonomyMode;
setMode(mode: AutonomyMode): void;
```

In `initial`:

```ts
const initial = {
  windowMode: 'bar' as WindowMode,
  activeSession: null as ActiveSessionState | null,
  sessions: [] as SessionMeta[],
  mode: 'balanced' as AutonomyMode,
};
```

Add to the store implementation:

```ts
setMode(mode) {
  set({ mode });
},
```

Extend `applyEvent` with new cases inside the `switch (event.type)` block:

```ts
case 'tool-call-pending': {
  const next = updateAssistant(session, event.messageId, (m) => ({
    ...m,
    content: [
      ...m.content,
      {
        type: 'pending_tool_use' as const,
        callId: event.callId,
        decisionId: event.decisionId,
        name: event.name,
        input: event.input,
        actionClass: event.actionClass,
        reason: event.reason,
        decision: 'pending' as const,
      },
    ],
  }));
  set({ activeSession: next });
  return;
}
case 'tool-call-decided': {
  const next = updateAssistant(session, event.messageId, (m) => ({
    ...m,
    content: m.content.map((b) =>
      b.type === 'pending_tool_use' && b.decisionId === event.decisionId
        ? {
            ...b,
            decision:
              event.decision === 'approve'
                ? ('approved' as const)
                : event.decision === 'approve-session'
                  ? ('approved-session' as const)
                  : ('denied' as const),
          }
        : b
    ),
  }));
  set({ activeSession: next });
  return;
}
case 'tool-call-denied': {
  const next = updateAssistant(session, event.messageId, (m) => ({
    ...m,
    content: [
      ...m.content,
      {
        type: 'tool_denied' as const,
        callId: event.callId,
        name: event.name,
        input: event.input,
        reason: event.reason,
      },
    ],
  }));
  set({ activeSession: next });
  return;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- src/renderer/state/store.test.ts`
Expected: PASS (existing + new tests, ~14 total).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/state/store.ts src/renderer/state/store.test.ts
git commit -m "feat(renderer): store handles autonomy events + mode state"
```

---

## Task 10: ApprovalCard Component + Message Renderer Updates

**Files:**
- Create: `src/renderer/components/ApprovalCard.tsx`
- Test: `src/renderer/components/ApprovalCard.test.tsx`
- Modify: `src/renderer/components/Message.tsx`

- [ ] **Step 1: Write the failing test for ApprovalCard**

`src/renderer/components/ApprovalCard.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApprovalCard } from './ApprovalCard';

describe('ApprovalCard', () => {
  const block = {
    type: 'pending_tool_use' as const,
    callId: 'c1',
    decisionId: 'd1',
    name: 'fake-mutate',
    input: { target: 'thing' },
    actionClass: 'destructive' as const,
    reason: 'mode=balanced',
    decision: 'pending' as const,
  };

  let invoke: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    invoke = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { otto: { invoke: typeof invoke } }).otto = { invoke } as never;
  });

  it('renders tool name, action class, and input summary', () => {
    render(<ApprovalCard block={block} />);
    expect(screen.getByText('fake-mutate')).toBeInTheDocument();
    expect(screen.getByText(/destructive/i)).toBeInTheDocument();
    expect(screen.getByText(/thing/)).toBeInTheDocument();
  });

  it('Approve sends autonomy.decide with approve', async () => {
    render(<ApprovalCard block={block} />);
    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    expect(invoke).toHaveBeenCalledWith('autonomy.decide', {
      decisionId: 'd1',
      decision: 'approve',
    });
  });

  it('Approve for session sends approve-session', async () => {
    render(<ApprovalCard block={block} />);
    await userEvent.click(screen.getByRole('button', { name: /session/i }));
    expect(invoke).toHaveBeenCalledWith('autonomy.decide', {
      decisionId: 'd1',
      decision: 'approve-session',
    });
  });

  it('Deny sends deny', async () => {
    render(<ApprovalCard block={block} />);
    await userEvent.click(screen.getByRole('button', { name: /^deny$/i }));
    expect(invoke).toHaveBeenCalledWith('autonomy.decide', {
      decisionId: 'd1',
      decision: 'deny',
    });
  });

  it('post-decision: buttons disabled, badge visible', () => {
    render(<ApprovalCard block={{ ...block, decision: 'approved' }} />);
    expect(screen.getByText(/approved/i)).toBeInTheDocument();
    for (const btn of screen.getAllByRole('button')) {
      expect(btn).toBeDisabled();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/renderer/components/ApprovalCard.test.tsx`
Expected: FAIL ("Cannot find module './ApprovalCard'").

- [ ] **Step 3: Create `src/renderer/components/ApprovalCard.tsx`**

```tsx
import { useCallback } from 'react';
import type { ContentBlock } from '@shared/messages';
import { ipc } from '../ipc';

interface Props {
  block: Extract<ContentBlock, { type: 'pending_tool_use' }>;
}

export function ApprovalCard({ block }: Props) {
  const submit = useCallback(
    async (decision: 'approve' | 'approve-session' | 'deny') => {
      await ipc.invoke('autonomy.decide', { decisionId: block.decisionId, decision });
    },
    [block.decisionId]
  );

  const inputSummary = (() => {
    try {
      return JSON.stringify(block.input);
    } catch {
      return String(block.input);
    }
  })();

  const decided = block.decision !== 'pending';

  return (
    <div className="my-2 rounded-lg border border-accent/40 bg-accent/10 p-3 text-sm">
      <div className="flex items-baseline justify-between mb-2">
        <div className="font-medium">
          <span>{block.name}</span>
          <span className="ml-2 text-[10px] uppercase tracking-wide text-muted">
            {block.actionClass}
          </span>
        </div>
        {decided && (
          <span className="text-[11px] uppercase text-accent">
            {block.decision === 'denied' ? 'Denied' : 'Approved'}
          </span>
        )}
      </div>
      <pre className="text-xs font-mono bg-bg/60 rounded p-2 overflow-x-auto mb-2">{inputSummary}</pre>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => submit('approve')}
          disabled={decided}
          className="px-2 py-1 text-xs rounded bg-accent text-bg disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() => submit('approve-session')}
          disabled={decided}
          className="px-2 py-1 text-xs rounded border border-accent text-accent disabled:opacity-50"
        >
          Approve for session
        </button>
        <button
          type="button"
          onClick={() => submit('deny')}
          disabled={decided}
          className="px-2 py-1 text-xs rounded border border-danger text-danger disabled:opacity-50"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/renderer/components/ApprovalCard.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Update `src/renderer/components/Message.tsx` to render new block types**

Locate the `renderBlocks` function (currently handles `text`, `tool_use`, `tool_result`). Add handling for `pending_tool_use` and `tool_denied`. Replace the function with:

```tsx
import type { Message as MessageType, ContentBlock } from '@shared/messages';
import { ToolCallCard } from './ToolCallCard';
import { ApprovalCard } from './ApprovalCard';

interface Props {
  message: MessageType;
}

export function MessageView({ message }: Props) {
  if (message.role === 'user') {
    return (
      <div data-testid="message-user" className="flex justify-end my-3">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent/20 border border-accent/30 px-4 py-2 text-sm">
          {renderText(message.content)}
        </div>
      </div>
    );
  }
  if (message.role === 'assistant') {
    const cls = ['my-3', message.errored ? 'opacity-60' : '', message.cancelled ? 'opacity-70 italic' : '']
      .filter(Boolean)
      .join(' ');
    return (
      <div data-testid="message-assistant" className={cls}>
        {renderBlocks(message.content)}
        {message.cancelled && <div className="text-xs text-muted mt-1">(cancelled)</div>}
        {message.errored && <div className="text-xs text-danger mt-1">(error)</div>}
      </div>
    );
  }
  return (
    <div data-testid="message-tool" className="my-3 text-xs text-muted font-mono">
      {renderBlocks(message.content)}
    </div>
  );
}

function renderText(content: ContentBlock[]): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function renderBlocks(content: ContentBlock[]) {
  const elements: React.ReactNode[] = [];
  const toolResults = new Map<string, { result: unknown; isError: boolean }>();
  for (const b of content) {
    if (b.type === 'tool_result') toolResults.set(b.callId, { result: b.result, isError: b.isError ?? false });
  }
  let textBuffer = '';
  for (let i = 0; i < content.length; i += 1) {
    const b = content[i]!;
    if (b.type === 'text') {
      textBuffer += b.text;
      continue;
    }
    if (textBuffer) {
      elements.push(<p key={`t-${i}`} className="text-sm leading-relaxed whitespace-pre-wrap">{textBuffer}</p>);
      textBuffer = '';
    }
    if (b.type === 'tool_use') {
      const res = toolResults.get(b.callId);
      elements.push(
        <ToolCallCard
          key={b.callId}
          name={b.name}
          input={b.input}
          result={res?.result}
          isError={res?.isError ?? false}
        />
      );
    } else if (b.type === 'pending_tool_use') {
      elements.push(<ApprovalCard key={b.callId} block={b} />);
    } else if (b.type === 'tool_denied') {
      elements.push(
        <div
          key={b.callId}
          className="my-2 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm"
        >
          <div className="font-medium text-danger">{b.name} — denied</div>
          <div className="text-xs text-muted mt-1">{b.reason}</div>
        </div>
      );
    }
  }
  if (textBuffer) {
    elements.push(<p key="t-tail" className="text-sm leading-relaxed whitespace-pre-wrap">{textBuffer}</p>);
  }
  return <>{elements}</>;
}
```

- [ ] **Step 6: Run all tests**

Run: `npm run test`
Expected: PASS (existing + ApprovalCard + new store tests; ~60 total).

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/ApprovalCard.tsx src/renderer/components/ApprovalCard.test.tsx src/renderer/components/Message.tsx
git commit -m "feat(renderer): ApprovalCard component + Message renders pending/denied blocks"
```

---

## Task 11: ModeBadge in Status Footer

**Files:**
- Create: `src/renderer/components/ModeBadge.tsx`
- Test: `src/renderer/components/ModeBadge.test.tsx`
- Modify: `src/renderer/components/StatusFooter.tsx`

- [ ] **Step 1: Write the failing test**

`src/renderer/components/ModeBadge.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModeBadge } from './ModeBadge';

let invoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  invoke = vi.fn().mockResolvedValue(undefined);
  (window as unknown as { otto: { invoke: typeof invoke } }).otto = { invoke } as never;
});

describe('ModeBadge', () => {
  it('shows the current mode label', () => {
    render(<ModeBadge mode="balanced" />);
    expect(screen.getByRole('button', { name: /balanced/i })).toBeInTheDocument();
  });

  it('clicking the badge opens a popover with three options', async () => {
    render(<ModeBadge mode="balanced" />);
    await userEvent.click(screen.getByRole('button', { name: /balanced/i }));
    expect(screen.getByText(/strict/i)).toBeInTheDocument();
    expect(screen.getByText(/full-allow/i)).toBeInTheDocument();
  });

  it('selecting a different mode invokes autonomy.setMode', async () => {
    render(<ModeBadge mode="balanced" />);
    await userEvent.click(screen.getByRole('button', { name: /balanced/i }));
    await userEvent.click(screen.getByRole('button', { name: /strict/i }));
    expect(invoke).toHaveBeenCalledWith('autonomy.setMode', { mode: 'strict' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/renderer/components/ModeBadge.test.tsx`
Expected: FAIL ("Cannot find module './ModeBadge'").

- [ ] **Step 3: Create `src/renderer/components/ModeBadge.tsx`**

```tsx
import { useState } from 'react';
import type { AutonomyMode } from '@shared/messages';
import { ipc } from '../ipc';

interface Props {
  mode: AutonomyMode;
}

const DOT_BY_MODE: Record<AutonomyMode, string> = {
  strict: 'bg-danger',
  balanced: 'bg-amber-500',
  'full-allow': 'bg-emerald-500',
};

const DESCRIPTIONS: Record<AutonomyMode, string> = {
  strict: 'Confirm anything mutating; deny irreversible.',
  balanced: 'Confirm destructive; deny irreversible.',
  'full-allow': 'Allow everything; confirm only irreversible.',
};

export function ModeBadge({ mode }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const choose = async (next: AutonomyMode) => {
    setOpen(false);
    if (next === mode) return;
    setBusy(true);
    try {
      await ipc.invoke('autonomy.setMode', { mode: next });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide px-2 py-0.5 rounded border border-border bg-bg/60 hover:bg-surface/60 disabled:opacity-50"
      >
        <span className={`inline-block w-2 h-2 rounded-full ${DOT_BY_MODE[mode]}`} />
        <span>{mode}</span>
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-1 w-56 rounded-lg border border-border bg-surface shadow-xl z-10">
          {(['strict', 'balanced', 'full-allow'] as AutonomyMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => choose(m)}
              className={`w-full text-left px-3 py-2 text-xs hover:bg-bg/40 ${
                m === mode ? 'bg-accent/10' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`inline-block w-2 h-2 rounded-full ${DOT_BY_MODE[m]}`} />
                <span className="font-medium">{m}</span>
              </div>
              <div className="text-[10px] text-muted mt-0.5">{DESCRIPTIONS[m]}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Modify `src/renderer/components/StatusFooter.tsx` to include the badge**

```tsx
import type { AutonomyMode } from '@shared/messages';
import { ModeBadge } from './ModeBadge';

interface Props {
  model: string;
  sessionId: string | null;
  streaming: boolean;
  mode: AutonomyMode;
}

export function StatusFooter({ model, sessionId, streaming, mode }: Props) {
  return (
    <div className="flex items-center justify-between text-[10px] text-muted">
      <div className="flex items-center gap-2">
        <span className="px-1.5 py-0.5 rounded bg-bg/60 border border-border">{model}</span>
        {sessionId && <span className="font-mono truncate max-w-[200px]">{sessionId}</span>}
      </div>
      <div className="flex items-center gap-3">
        <ModeBadge mode={mode} />
        <div>{streaming ? 'thinking…' : ''}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run tests**

Run: `npm run test`
Expected: PASS — including new ModeBadge tests. The `StatusFooter` change adds a required prop `mode`, which will be supplied in Task 12.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/ModeBadge.tsx src/renderer/components/ModeBadge.test.tsx src/renderer/components/StatusFooter.tsx
git commit -m "feat(renderer): ModeBadge in StatusFooter with popover"
```

---

## Task 12: App Wiring — Load Mode, Subscribe to Mode Events, Pass to Footer

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/ipc.ts`

- [ ] **Step 1: Extend `src/renderer/ipc.ts` to expose the autonomy event channel**

Replace the file with:

```ts
import type { IpcChannel, IpcRequest, SessionEvent, AutonomyEvent } from '@shared/ipc-contract';

export const ipc = {
  invoke<C extends IpcChannel>(
    channel: C,
    args: Extract<IpcRequest, { channel: C }>['args']
  ): Promise<Extract<IpcRequest, { channel: C }>['result']> {
    return window.otto.invoke(channel, args);
  },
  onSessionEvent(handler: (e: SessionEvent) => void): () => void {
    return window.otto.onSessionEvent(handler);
  },
  onAutonomyEvent(handler: (e: AutonomyEvent) => void): () => void {
    return window.otto.onAutonomyEvent(handler);
  },
};
```

- [ ] **Step 2: Update `src/renderer/App.tsx`**

Near the other `useEffect`s, add:

```tsx
useEffect(() => {
  void ipc.invoke('autonomy.getMode', undefined).then((m) => useOttoStore.getState().setMode(m));
}, []);

useEffect(() => {
  return ipc.onAutonomyEvent((e) => {
    if (e.type === 'mode-changed') {
      useOttoStore.getState().setMode(e.mode);
    }
  });
}, []);
```

And in the panel branch, replace the StatusFooter usage:

```tsx
<StatusFooter
  model={MODEL}
  sessionId={activeSession?.id ?? null}
  streaming={activeSession?.streaming ?? false}
  mode={useOttoStore.getState().mode}
/>
```

But `useOttoStore.getState()` inside the JSX won't re-render. Use the hook instead — at the top of the component:

```tsx
const mode = useOttoStore((s) => s.mode);
```

Then the JSX becomes:

```tsx
<StatusFooter
  model={MODEL}
  sessionId={activeSession?.id ?? null}
  streaming={activeSession?.streaming ?? false}
  mode={mode}
/>
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run all tests**

Run: `npm run test`
Expected: PASS — full suite.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.tsx src/renderer/ipc.ts
git commit -m "feat(renderer): App loads autonomy mode and subscribes to changes"
```

---

## Task 13: Playwright Integration — Confirm-Flow Smoke

**Files:**
- Create: `tests/integration/autonomy.spec.ts`
- Modify: `src/main/agent/sdk-client.ts` (fake client: extend to emit a `fake-mutate` call when prompt contains a keyword, so the integration test can exercise the confirm path)

- [ ] **Step 1: Extend the fake SDK client to support the autonomy test**

Modify `createFakeSdkClient` in `src/main/agent/sdk-client.ts`. Locate the existing fake events generator and add a branch: if the prompt contains the substring `[mutate]`, after the streaming echo emit a tool call for `fake-mutate` instead of `echo`. Replace the fake events function with:

```ts
function createFakeSdkClient(): SdkClient {
  let counter = 0;
  return {
    async startSession() {
      counter += 1;
      return { id: `fake-${counter}` };
    },
    sendTurn(_sid, text, signal, _resumeId) {
      const fakeSdkId = `fake-sdk-${(counter += 1)}`;
      const wantsMutate = text.includes('[mutate]');
      async function* events(): AsyncIterable<SdkStreamEvent> {
        yield { type: 'message-start' };
        yield { type: 'session-id', id: fakeSdkId };
        for (const ch of `echo: ${text}`) {
          if (signal.aborted) return;
          yield { type: 'text-delta', text: ch };
          await new Promise((r) => setTimeout(r, 5));
        }
        if (wantsMutate) {
          yield {
            type: 'tool-call-start',
            callId: 'c-mut',
            name: 'fake-mutate',
            input: { target: 'X' },
          };
          yield {
            type: 'tool-call-result',
            callId: 'c-mut',
            result: 'Pretended to mutate X',
            isError: false,
          };
        } else {
          yield { type: 'tool-call-start', callId: 'c1', name: 'echo', input: { msg: text } };
          yield { type: 'tool-call-result', callId: 'c1', result: text, isError: false };
        }
        yield { type: 'message-end' };
        yield { type: 'done' };
      }
      return { signal, events };
    },
  };
}
```

> The fake client emits the `tool-call-start` / `tool-call-result` events directly to SessionManager, which in turn just forwards them. The BROKER would only fire if the real MCP handler ran — which the fake client doesn't exercise. To actually exercise the confirm path in an integration test, we route through a different mechanism: write the test against the renderer's reducer by injecting a `tool-call-pending` event directly from main into the renderer.

The cleanest end-to-end smoke is: have the fake SDK emit a special event `[mutate]`-triggered that, from `sdk-client.ts`, calls `deps.broker.decide(...)` directly (bypassing the real MCP). Then the broker emits `tool-call-pending` to the renderer through the real IPC pipeline, the test sees the card, clicks Approve, and the broker resolves the decision.

Update the fake client to accept `deps` like the real one (so we can call the broker from inside the fake events generator when `[mutate]` is in the prompt). Refactor the function signatures:

```ts
function createFakeSdkClient(deps?: { broker?: DecisionBroker; currentMessageId?: () => string }): SdkClient {
  // ... existing setup ...
  return {
    // ... startSession ...
    sendTurn(sid, text, signal, _resumeId) {
      const fakeSdkId = `fake-sdk-${(counter += 1)}`;
      const wantsMutate = text.includes('[mutate]') && !!deps?.broker;
      async function* events(): AsyncIterable<SdkStreamEvent> {
        yield { type: 'message-start' };
        yield { type: 'session-id', id: fakeSdkId };
        for (const ch of `echo: ${text}`) {
          if (signal.aborted) return;
          yield { type: 'text-delta', text: ch };
          await new Promise((r) => setTimeout(r, 5));
        }
        if (wantsMutate && deps?.broker) {
          // Drive the broker exactly as the real MCP handler would.
          const messageId = deps.currentMessageId?.() ?? 'fake-msg';
          const outcome = await deps.broker.decide({
            sessionId: sid,
            messageId,
            callId: 'c-mut',
            toolName: 'fake-mutate',
            actionClass: 'destructive',
            input: { target: 'X' },
            denyPatternsFn: null,
          });
          if (outcome === 'allow') {
            yield {
              type: 'tool-call-start',
              callId: 'c-mut',
              name: 'fake-mutate',
              input: { target: 'X' },
            };
            yield {
              type: 'tool-call-result',
              callId: 'c-mut',
              result: 'Pretended to mutate X',
              isError: false,
            };
          }
          // On deny, the broker already emitted tool-call-decided; nothing more to do.
        } else {
          yield { type: 'tool-call-start', callId: 'c1', name: 'echo', input: { msg: text } };
          yield { type: 'tool-call-result', callId: 'c1', result: text, isError: false };
        }
        yield { type: 'message-end' };
        yield { type: 'done' };
      }
      return { signal, events };
    },
  };
}
```

And pass `deps` through in the export:

```ts
export function createRealSdkClient(deps: RealSdkClientDeps): SdkClient {
  if (process.env.OTTO_FAKE_SDK === '1') return createFakeSdkClient(deps);
  // ... existing real client ...
}
```

- [ ] **Step 2: Create `tests/integration/autonomy.spec.ts`**

```ts
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

test('autonomy: approve a destructive tool call', async () => {
  const cfg = mkdtempSync(path.join(tmpdir(), 'otto-autonomy-e2e-'));
  mkdirSync(path.join(cfg, 'otto'), { recursive: true });
  writeFileSync(
    path.join(cfg, 'otto', 'settings.json'),
    JSON.stringify({ version: 1, autonomy: { mode: 'balanced' } })
  );

  const app = await electron.launch({
    args: [path.join(process.cwd())],
    env: {
      ...process.env,
      OTTO_FAKE_SDK: '1',
      XDG_CONFIG_HOME: cfg,
      NODE_ENV: 'test',
    },
  });

  const page = await app.firstWindow();
  await page.waitForSelector('input[placeholder*="Ask Otto" i]');
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.show();
  });

  await page.fill('input[placeholder*="Ask Otto" i]', '[mutate] please');
  await page.press('input[placeholder*="Ask Otto" i]', 'Enter');

  // Approval card should appear within ~5s.
  await expect(page.getByText('fake-mutate')).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: /^approve$/i }).click();

  // After approval, the tool call card should render.
  await expect(page.getByText('Pretended to mutate X', { exact: false })).toBeVisible({ timeout: 5000 });

  await app.close();
  rmSync(cfg, { recursive: true, force: true });
});

test('autonomy: deny short-circuits the call', async () => {
  const cfg = mkdtempSync(path.join(tmpdir(), 'otto-autonomy-e2e-'));
  mkdirSync(path.join(cfg, 'otto'), { recursive: true });
  writeFileSync(
    path.join(cfg, 'otto', 'settings.json'),
    JSON.stringify({ version: 1, autonomy: { mode: 'balanced' } })
  );

  const app = await electron.launch({
    args: [path.join(process.cwd())],
    env: {
      ...process.env,
      OTTO_FAKE_SDK: '1',
      XDG_CONFIG_HOME: cfg,
      NODE_ENV: 'test',
    },
  });

  const page = await app.firstWindow();
  await page.waitForSelector('input[placeholder*="Ask Otto" i]');
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.show();
  });

  await page.fill('input[placeholder*="Ask Otto" i]', '[mutate] nope');
  await page.press('input[placeholder*="Ask Otto" i]', 'Enter');

  await expect(page.getByText('fake-mutate')).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: /^deny$/i }).click();

  // The card should now show the decided state.
  await expect(page.getByText(/^denied$/i)).toBeVisible({ timeout: 3000 });
  // The tool result should NOT appear.
  await expect(page.getByText('Pretended to mutate X', { exact: false })).toHaveCount(0);

  await app.close();
  rmSync(cfg, { recursive: true, force: true });
});
```

- [ ] **Step 3: Build & run**

```bash
npm run build
npm run test:integration
```

Expected: 3 tests pass (existing smoke + 2 new autonomy tests).

- [ ] **Step 4: Commit**

```bash
git add tests/integration/autonomy.spec.ts src/main/agent/sdk-client.ts
git commit -m "test(integration): autonomy approve + deny flows via fake SDK"
```

---

## Task 14: Manual Verification

**Files:** none — runtime smoke.

- [ ] **Step 1: Start the dev app**

```bash
npm run dev
```

- [ ] **Step 2: Walk the checklist (from spec)**

- [ ] Mode badge shows current mode; clicking switches it without restart.
- [ ] In `balanced`, ask "use the fake-mutate tool on 'foo'". Approval card appears. Approve → tool runs. Deny → tool denied, model proceeds with denial.
- [ ] Approve-for-session: second fake-mutate call same session runs without prompting. New session prompts again.
- [ ] In `strict`, ask "use the fake-wipe tool on 'foo'". Should be denied immediately with reason `mode=strict, class=irreversible`.
- [ ] In `full-allow`, ask "use the fake-wipe tool on 'foo'". Approval card appears (irreversible always confirms). Approve → tool runs.
- [ ] Quit and reopen the app: mode persists.
- [ ] `cat ~/.config/otto/settings.json` shows the current mode.
- [ ] Make `~/.config/otto/settings.json` malformed (`echo '{' > settings.json`), restart, verify log warns and app uses defaults.

- [ ] **Step 3: Commit any fixes**

Per-fix commits as needed.

---

## Self-Review Notes

Mapped each spec section to tasks:
- **Goals / Mode × Action-Class Matrix** → Tasks 1 (types), 2 (policy matrix), 4 (broker).
- **Non-Goals** → enforced by absence (no plan-level UI, no env vars, no settings page, no persistent grants).
- **Architecture (`policy.ts`, `decision-broker.ts`, `settings.ts`)** → Tasks 2, 3, 4.
- **OttoTool integration** → Task 1 (interface), Task 5 (handlers).
- **IPC contract additions** → Task 1 (types), Task 7 (handlers), Task 12 (renderer wrapper).
- **Renderer components (ApprovalCard, ModeBadge)** → Tasks 10, 11.
- **Store reducer (new events + mode)** → Task 9.
- **App wiring (load mode, subscribe to events)** → Task 12.
- **Confirm / Deny / Mode-change flows** → exercised in Tasks 4 (unit) and 13 (integration).
- **Approve-for-session cache + denylist non-bypass** → Task 4 unit tests cover both.
- **Mode-change isolation** → Task 4 unit test.
- **Timeout** → Task 4 unit test.
- **Settings file errors** → Task 3 unit tests.
- **Manual verification checklist** → Task 14.

No placeholders, no "TBD", no "similar to task N". Method names cross-checked across tasks (`decide`, `resolve`, `setMode`, `getMode`, `onChange`, `evaluate`, `setCurrentMessageId`/`onAssistantMessageId`, `emitSessionEvent`, `emitAutonomyEvent`).

Known seams documented inline:
- The fake SDK needs the broker dep for the integration test to drive the confirm path through real IPC (Task 13 calls this out and refactors the fake client to accept `deps`).
- Task 5 intentionally leaves `src/main/index.ts` non-compiling; Task 6 + Task 8 close the loop in the same logical change set, with explicit commits at each boundary.
