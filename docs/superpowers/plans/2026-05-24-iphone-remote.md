# iPhone Remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a PWA-based iPhone remote that lets the user drive Otto from their phone over Tailscale — streaming events, first-resolver-wins approvals, and screenshot thumbs — without exposing Otto to the LAN or public internet.

**Architecture:** New `src/main/remote/` module adds a fan-out `SessionBus` between the agent and N subscribers (existing desktop renderer + each connected phone). A `BridgeServer` binds HTTP+WS to the tailnet IP only, gated by hashed bearer tokens issued via a QR-code pairing flow. A second Vite entry serves the PWA from the same Electron bundle.

**Tech Stack:** Node `ws` (WebSocket), Node `http`, `better-sqlite3`, `argon2` (token hashing), `qrcode` (QR rendering), React 18, electron-vite, vitest, playwright.

**Spec:** [`docs/superpowers/specs/2026-05-24-iphone-remote-design.md`](../specs/2026-05-24-iphone-remote-design.md)

---

## File Map

**New:**
- `src/main/remote/pairing-store.ts` (+ test) — SQLite-backed paired-device records, argon2id hashed tokens.
- `src/main/remote/session-bus.ts` (+ test) — fan-out event bus + serialized input queue + per-session ring buffer.
- `src/main/remote/tailnet.ts` (+ test) — resolve tailnet IPv4 via `tailscale ip -4`, with stub for tests.
- `src/main/remote/bridge-server.ts` (+ test) — HTTP + WS server bound to tailnet IP only.
- `src/main/remote/screenshot-urls.ts` (+ test) — HMAC-signed, expiring screenshot URLs.
- `src/main/remote/index.ts` — module entry point (`RemoteModule` start/stop).
- `src/main/remote/settings.ts` (+ test) — `remote` block in settings JSON (enabled, remote_ceiling).
- `src/renderer-remote/` — second Vite renderer entry (PWA).
  - `index.html`, `main.tsx`, `App.tsx`, `pair.tsx`, `chat.tsx`, `approval-card.tsx`, `screenshot.tsx`, `manifest.webmanifest`, `sw.ts`, `wire.ts`, `store.ts`.
- `tests/remote/pair-and-chat.e2e.ts` — playwright E2E.

**Modified:**
- `src/main/db/db.ts` — add migration 006 (`paired_devices` table).
- `src/main/agent/session.ts` — accept a `SessionBus` (or compatible fan-out emitter) instead of single `emit` callback.
- `src/main/index.ts` — instantiate `RemoteModule`, wire to settings + agent.
- `src/main/settings-window.ts` — add "Remote access" panel; expose IPC for pair/revoke/toggle.
- `src/main/ipc/handlers.ts` — handlers for `remote:*` IPC channels.
- `src/preload/index.ts` — expose `remote` API to renderer.
- `src/shared/ipc-contract.ts` — add `RemoteEvent` and `remote:*` channel types.
- `electron.vite.config.ts` — add second renderer entry `renderer-remote`.
- `package.json` — add `ws`, `@types/ws`, `argon2`, `qrcode`, `@types/qrcode`.

---

## Phase 1 — DB and pairing

### Task 1: Add `paired_devices` table migration

**Files:**
- Modify: `src/main/db/db.ts`
- Test: `src/main/db/db.test.ts`

- [ ] **Step 1: Write failing test** — append to `src/main/db/db.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
// existing imports

describe('migration 006: paired_devices', () => {
  it('creates paired_devices table with expected columns', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'otto-db-'));
    const db = openDatabase(path.join(dir, 'otto.db'));
    const cols = db.prepare(`PRAGMA table_info(paired_devices)`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(['id', 'label', 'last_seen_at', 'paired_at', 'revoked_at', 'token_hash'].sort());
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test, expect FAIL** — `pnpm test src/main/db/db.test.ts`

Expected: failure (`paired_devices` does not exist).

- [ ] **Step 3: Add migration to `src/main/db/db.ts`** — append above the `MIGRATIONS` array:

```typescript
const MIGRATION_006_PAIRED_DEVICES = `
CREATE TABLE IF NOT EXISTS paired_devices (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  paired_at    INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at   INTEGER
);

CREATE INDEX IF NOT EXISTS paired_devices_revoked_idx ON paired_devices(revoked_at);
`;
```

And register it:

```typescript
const MIGRATIONS: { version: number; sql: string }[] = [
  { version: 1, sql: MIGRATION_001_INIT },
  { version: 2, sql: MIGRATION_002_SDK_SESSION_ID },
  { version: 3, sql: MIGRATION_003_ARTIFACTS },
  { version: 4, sql: MIGRATION_004_FACTS },
  { version: 5, sql: MIGRATION_005_VEC },
  { version: 6, sql: MIGRATION_006_PAIRED_DEVICES },
];
```

- [ ] **Step 4: Run test, expect PASS** — `pnpm test src/main/db/db.test.ts`

- [ ] **Step 5: Commit** —
```bash
git add src/main/db/db.ts src/main/db/db.test.ts
git commit -m "db: add migration 006 (paired_devices)"
```

---

### Task 2: Add argon2 + crypto deps

**Files:**
- Modify: `package.json`

- [ ] **Step 1:** `pnpm add argon2 ws qrcode` and `pnpm add -D @types/ws @types/qrcode`.

- [ ] **Step 2: Verify install** — `pnpm install` exits 0; `node -e "require('argon2'); require('ws'); require('qrcode')"` exits 0.

- [ ] **Step 3: Run ABI ensure** — `node scripts/ensure-abi.mjs node` then `pnpm test src/main/db/db.test.ts` to confirm native deps still load.

- [ ] **Step 4: Commit** —
```bash
git add package.json pnpm-lock.yaml
git commit -m "deps: add ws, argon2, qrcode for remote bridge"
```

---

### Task 3: Implement `PairingStore`

**Files:**
- Create: `src/main/remote/pairing-store.ts`
- Test: `src/main/remote/pairing-store.test.ts`

- [ ] **Step 1: Write failing tests** — `src/main/remote/pairing-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../db/db';
import { PairingStore } from './pairing-store';

let dir: string;
let db: Database;
let store: PairingStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'otto-pairing-'));
  db = openDatabase(path.join(dir, 'otto.db'));
  store = new PairingStore(db, () => 1000);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('PairingStore', () => {
  it('issues a token and verifies it back', async () => {
    const { deviceId, token } = await store.issue('iPhone');
    const found = await store.verify(token);
    expect(found?.id).toBe(deviceId);
    expect(found?.label).toBe('iPhone');
  });

  it('verify returns null for an unknown token', async () => {
    expect(await store.verify('not-a-token')).toBeNull();
  });

  it('revoked devices fail verification and cannot reconnect', async () => {
    const { deviceId, token } = await store.issue('iPhone');
    store.revoke(deviceId);
    expect(await store.verify(token)).toBeNull();
  });

  it('list returns devices with paired_at and last_seen_at', async () => {
    await store.issue('iPhone');
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.pairedAt).toBe(1000);
    expect(list[0]!.lastSeenAt).toBeNull();
  });

  it('verify updates last_seen_at', async () => {
    const { token } = await store.issue('iPhone');
    let now = 1000;
    const store2 = new PairingStore(db, () => now);
    now = 2000;
    await store2.verify(token);
    expect(store2.list()[0]!.lastSeenAt).toBe(2000);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm test src/main/remote/pairing-store.test.ts`

- [ ] **Step 3: Implement** — `src/main/remote/pairing-store.ts`:

```typescript
import type { Database } from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';

export interface PairedDevice {
  id: string;
  label: string;
  pairedAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

interface Row {
  id: string;
  label: string;
  token_hash: string;
  paired_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

export class PairingStore {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {}

  async issue(label: string): Promise<{ deviceId: string; token: string }> {
    const deviceId = randomUUID();
    const token = randomBytes(32).toString('base64url');
    const tokenHash = await argon2.hash(token, { type: argon2.argon2id });
    this.db.prepare(
      `INSERT INTO paired_devices (id, label, token_hash, paired_at, last_seen_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL, NULL)`
    ).run(deviceId, label, tokenHash, this.now());
    return { deviceId, token };
  }

  async verify(token: string): Promise<PairedDevice | null> {
    const rows = this.db.prepare(
      `SELECT * FROM paired_devices WHERE revoked_at IS NULL`
    ).all() as Row[];
    for (const row of rows) {
      if (await argon2.verify(row.token_hash, token)) {
        const now = this.now();
        this.db.prepare(`UPDATE paired_devices SET last_seen_at = ? WHERE id = ?`).run(now, row.id);
        return { id: row.id, label: row.label, pairedAt: row.paired_at, lastSeenAt: now, revokedAt: null };
      }
    }
    return null;
  }

  revoke(deviceId: string): void {
    this.db.prepare(`UPDATE paired_devices SET revoked_at = ? WHERE id = ?`).run(this.now(), deviceId);
  }

  list(): PairedDevice[] {
    const rows = this.db.prepare(`SELECT * FROM paired_devices ORDER BY paired_at DESC`).all() as Row[];
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      pairedAt: r.paired_at,
      lastSeenAt: r.last_seen_at,
      revokedAt: r.revoked_at,
    }));
  }
}
```

Note on the `verify` linear scan: argon2 verification is intentionally expensive, so this scales poorly. Single-user tool with a handful of paired devices makes this acceptable. If device counts ever grow, add a short non-secret prefix to tokens and index by prefix.

- [ ] **Step 4: Run, expect PASS** — `pnpm test src/main/remote/pairing-store.test.ts`

- [ ] **Step 5: Commit** —
```bash
git add src/main/remote/pairing-store.ts src/main/remote/pairing-store.test.ts
git commit -m "remote: PairingStore with argon2id hashed tokens"
```

---

## Phase 2 — Tailnet resolver

### Task 4: Implement `tailnet.ts`

**Files:**
- Create: `src/main/remote/tailnet.ts`
- Test: `src/main/remote/tailnet.test.ts`

- [ ] **Step 1: Write failing tests** — `src/main/remote/tailnet.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { resolveTailnetIp } from './tailnet';

describe('resolveTailnetIp', () => {
  it('returns the IPv4 from a successful exec', async () => {
    const ip = await resolveTailnetIp({ exec: async () => ({ stdout: '100.64.1.2\n', stderr: '', code: 0 }) });
    expect(ip).toBe('100.64.1.2');
  });

  it('returns null when tailscale is not installed', async () => {
    const ip = await resolveTailnetIp({
      exec: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    });
    expect(ip).toBeNull();
  });

  it('returns null when exit code is non-zero', async () => {
    const ip = await resolveTailnetIp({ exec: async () => ({ stdout: '', stderr: 'not running', code: 1 }) });
    expect(ip).toBeNull();
  });

  it('rejects non-IPv4 output', async () => {
    const ip = await resolveTailnetIp({ exec: async () => ({ stdout: 'fd7a::1\n', stderr: '', code: 0 }) });
    expect(ip).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `pnpm test src/main/remote/tailnet.test.ts`

- [ ] **Step 3: Implement** — `src/main/remote/tailnet.ts`:

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface ExecResult { stdout: string; stderr: string; code: number }
export interface ExecFn { (cmd: string, args: string[]): Promise<ExecResult> }

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

const defaultExec: ExecFn = async (cmd, args) => {
  try {
    const r = await execFileP(cmd, args);
    return { stdout: r.stdout, stderr: r.stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: string | number; stdout?: string; stderr?: string };
    if (e.code === 'ENOENT') throw e;
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: typeof e.code === 'number' ? e.code : 1 };
  }
};

export async function resolveTailnetIp(opts: { exec?: (args?: string[]) => Promise<ExecResult> } = {}): Promise<string | null> {
  const exec = opts.exec ?? ((args = ['ip', '-4']) => defaultExec('tailscale', args));
  try {
    const r = await exec();
    if (r.code !== 0) return null;
    const ip = r.stdout.trim().split(/\s+/)[0] ?? '';
    return IPV4_RE.test(ip) ? ip : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run, expect PASS** — `pnpm test src/main/remote/tailnet.test.ts`

- [ ] **Step 5: Commit** —
```bash
git add src/main/remote/tailnet.ts src/main/remote/tailnet.test.ts
git commit -m "remote: tailnet IP resolver"
```

---

## Phase 3 — Session bus (fan-out + serialized input)

### Task 5: Define `SessionBus` types and broadcast

**Files:**
- Create: `src/main/remote/session-bus.ts`
- Test: `src/main/remote/session-bus.test.ts`

- [ ] **Step 1: Write failing tests** — `src/main/remote/session-bus.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { SessionBus, type RemoteOutbound } from './session-bus';

let bus: SessionBus;
let clock: { t: number };
beforeEach(() => {
  clock = { t: 1000 };
  bus = new SessionBus({ ringSize: 5, now: () => clock.t });
});

describe('SessionBus broadcast', () => {
  it('delivers events to every subscriber', () => {
    const a: RemoteOutbound[] = [];
    const b: RemoteOutbound[] = [];
    bus.subscribe('s1', (e) => a.push(e));
    bus.subscribe('s1', (e) => b.push(e));
    bus.publish('s1', { type: 'event', kind: 'text-delta', text: 'hi' });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('unsubscribe stops further delivery', () => {
    const a: RemoteOutbound[] = [];
    const off = bus.subscribe('s1', (e) => a.push(e));
    off();
    bus.publish('s1', { type: 'event', kind: 'text-delta', text: 'hi' });
    expect(a).toHaveLength(0);
  });

  it('does not leak events across sessions', () => {
    const a: RemoteOutbound[] = [];
    bus.subscribe('s1', (e) => a.push(e));
    bus.publish('s2', { type: 'event', kind: 'text-delta', text: 'hi' });
    expect(a).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement initial scaffold** — `src/main/remote/session-bus.ts`:

```typescript
export type RemoteOutbound =
  | { type: 'event'; kind: string; [k: string]: unknown }
  | { type: 'approval_pending'; decisionId: string; tool: string; summary: string; actionClass: string; expiresAt: number }
  | { type: 'approval_resolved'; decisionId: string; decision: 'approve' | 'deny'; by: 'desktop' | 'remote' | 'timeout' }
  | { type: 'session_state'; sessionId: string; status: string; autonomyMode: string; pendingApprovals: string[] }
  | { type: 'error'; code: string; message: string; fatal: boolean };

export type RemoteInbound =
  | { type: 'prompt'; sessionId: string; text: string }
  | { type: 'approval'; decisionId: string; decision: 'approve' | 'deny' }
  | { type: 'interrupt'; sessionId: string };

type Subscriber = (e: RemoteOutbound) => void;

interface RingEntry { seq: number; event: RemoteOutbound; t: number }

export interface SessionBusOpts { ringSize?: number; now?: () => number }

export class SessionBus {
  private readonly subs = new Map<string, Set<Subscriber>>();
  private readonly ring = new Map<string, RingEntry[]>();
  private readonly seqs = new Map<string, number>();
  private readonly inputQueue = new Map<string, Array<RemoteInbound & { resolve: () => void }>>();
  private readonly inputRunning = new Map<string, boolean>();
  private readonly ringSize: number;
  private readonly now: () => number;

  constructor(opts: SessionBusOpts = {}) {
    this.ringSize = opts.ringSize ?? 200;
    this.now = opts.now ?? Date.now;
  }

  subscribe(sessionId: string, sub: Subscriber): () => void {
    let set = this.subs.get(sessionId);
    if (!set) { set = new Set(); this.subs.set(sessionId, set); }
    set.add(sub);
    return () => { set!.delete(sub); };
  }

  publish(sessionId: string, event: RemoteOutbound): void {
    const seq = (this.seqs.get(sessionId) ?? 0) + 1;
    this.seqs.set(sessionId, seq);
    const entry: RingEntry = { seq, event, t: this.now() };
    let ring = this.ring.get(sessionId);
    if (!ring) { ring = []; this.ring.set(sessionId, ring); }
    ring.push(entry);
    if (ring.length > this.ringSize) ring.shift();
    const subs = this.subs.get(sessionId);
    if (!subs) return;
    for (const s of subs) {
      try { s(event); } catch { /* a single bad subscriber must not break the others */ }
    }
  }

  history(sessionId: string, sinceSeq: number): { events: Array<{ seq: number; event: RemoteOutbound }>; truncated: boolean } {
    const ring = this.ring.get(sessionId) ?? [];
    if (ring.length === 0) return { events: [], truncated: false };
    const oldest = ring[0]!.seq;
    const truncated = sinceSeq + 1 < oldest;
    const events = ring.filter((e) => e.seq > sinceSeq).map((e) => ({ seq: e.seq, event: e.event }));
    return { events, truncated };
  }
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** —
```bash
git add src/main/remote/session-bus.ts src/main/remote/session-bus.test.ts
git commit -m "remote: SessionBus scaffold (broadcast + ring buffer)"
```

---

### Task 6: SessionBus ring buffer and `history`

**Files:**
- Test: `src/main/remote/session-bus.test.ts`

- [ ] **Step 1: Add failing tests** — append to test file:

```typescript
describe('SessionBus ring/history', () => {
  it('history returns events newer than sinceSeq', () => {
    bus.publish('s1', { type: 'event', kind: 'a' } as RemoteOutbound);
    bus.publish('s1', { type: 'event', kind: 'b' } as RemoteOutbound);
    bus.publish('s1', { type: 'event', kind: 'c' } as RemoteOutbound);
    const { events, truncated } = bus.history('s1', 1);
    expect(events.map((e) => e.seq)).toEqual([2, 3]);
    expect(truncated).toBe(false);
  });

  it('history marks truncated when sinceSeq is older than the ring', () => {
    // ringSize is 5 in beforeEach
    for (let i = 0; i < 10; i++) bus.publish('s1', { type: 'event', kind: 'x' } as RemoteOutbound);
    const { events, truncated } = bus.history('s1', 1);
    expect(truncated).toBe(true);
    expect(events).toHaveLength(5);
    expect(events[0]!.seq).toBe(6);
  });

  it('history with sinceSeq equal to latest returns empty, not truncated', () => {
    bus.publish('s1', { type: 'event', kind: 'a' } as RemoteOutbound);
    const { events, truncated } = bus.history('s1', 1);
    expect(events).toEqual([]);
    expect(truncated).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect PASS** (logic already present — these tests pin the contract).

- [ ] **Step 3: Commit** —
```bash
git add src/main/remote/session-bus.test.ts
git commit -m "remote: SessionBus ring buffer history tests"
```

---

### Task 7: SessionBus serialized input queue

**Files:**
- Modify: `src/main/remote/session-bus.ts`
- Test: `src/main/remote/session-bus.test.ts`

- [ ] **Step 1: Write failing tests** — append to test file:

```typescript
describe('SessionBus input queue', () => {
  it('serializes concurrent enqueues per session', async () => {
    const order: string[] = [];
    const runner = async (m: { type: 'prompt'; sessionId: string; text: string } | { type: 'approval'; decisionId: string; decision: 'approve' | 'deny' } | { type: 'interrupt'; sessionId: string }) => {
      if (m.type === 'prompt') {
        order.push(`start:${m.text}`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`end:${m.text}`);
      }
    };
    bus.setInputHandler('s1', runner);
    await Promise.all([
      bus.enqueueInput('s1', { type: 'prompt', sessionId: 's1', text: 'A' }),
      bus.enqueueInput('s1', { type: 'prompt', sessionId: 's1', text: 'B' }),
    ]);
    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B']);
  });

  it('independent sessions run in parallel', async () => {
    const events: string[] = [];
    bus.setInputHandler('s1', async () => { events.push('s1-start'); await new Promise((r) => setTimeout(r, 30)); events.push('s1-end'); });
    bus.setInputHandler('s2', async () => { events.push('s2-start'); await new Promise((r) => setTimeout(r, 10)); events.push('s2-end'); });
    await Promise.all([
      bus.enqueueInput('s1', { type: 'prompt', sessionId: 's1', text: 'x' }),
      bus.enqueueInput('s2', { type: 'prompt', sessionId: 's2', text: 'y' }),
    ]);
    expect(events.indexOf('s2-end')).toBeLessThan(events.indexOf('s1-end'));
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (`setInputHandler`, `enqueueInput` don't exist).

- [ ] **Step 3: Extend `session-bus.ts`** — add to the `SessionBus` class:

```typescript
type InputHandler = (m: RemoteInbound) => Promise<void>;

// inside SessionBus
private readonly handlers = new Map<string, InputHandler>();

setInputHandler(sessionId: string, handler: InputHandler): void {
  this.handlers.set(sessionId, handler);
}

async enqueueInput(sessionId: string, message: RemoteInbound): Promise<void> {
  return new Promise<void>((resolve) => {
    let q = this.inputQueue.get(sessionId);
    if (!q) { q = []; this.inputQueue.set(sessionId, q); }
    q.push({ ...(message as RemoteInbound & { resolve: () => void }), resolve });
    void this.drain(sessionId);
  });
}

private async drain(sessionId: string): Promise<void> {
  if (this.inputRunning.get(sessionId)) return;
  this.inputRunning.set(sessionId, true);
  try {
    const q = this.inputQueue.get(sessionId)!;
    while (q.length > 0) {
      const m = q.shift()!;
      const handler = this.handlers.get(sessionId);
      try { if (handler) await handler(m); } catch { /* surfaced via published events */ }
      m.resolve();
    }
  } finally {
    this.inputRunning.set(sessionId, false);
  }
}
```

(Move the appropriate `import` of `InputHandler` type internal — kept inline above.)

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** —
```bash
git add src/main/remote/session-bus.ts src/main/remote/session-bus.test.ts
git commit -m "remote: SessionBus serialized input queue"
```

---

## Phase 4 — Agent fan-out integration

### Task 8: Wrap agent `emit` with the bus

**Files:**
- Modify: `src/main/agent/session.ts` (no signature changes — keeps `emit` callback contract)
- Modify: `src/main/index.ts`
- Test: `src/main/agent/session.test.ts`

The existing `SessionManager` takes a single `emit: (event: SessionEvent) => void` callback. The cleanest non-invasive integration is to construct it with an `emit` that fans out to BOTH the existing renderer IPC and the `SessionBus`. No `session.ts` shape change required.

- [ ] **Step 1: Identify the call site** — `grep -n "new SessionManager" src/main/index.ts` to find where `emit` is currently passed.

- [ ] **Step 2: Add failing test** — append to `src/main/agent/session.test.ts` (using the file's existing fake-SDK + fake-Repo pattern; if names differ, adapt to the locals in scope):

```typescript
import { SessionBus, type RemoteOutbound } from '../remote/session-bus';

it('events emitted by SessionManager reach both renderer emit and the SessionBus', async () => {
  const rendererCalls: SessionEvent[] = [];
  const bus = new SessionBus();
  const busCalls: RemoteOutbound[] = [];

  // Use the file's existing fake SDK that yields a fixed event sequence.
  const sdk = makeFakeSdk([
    { type: 'message-start' },
    { type: 'session-id', id: 'sdk-1' },
    { type: 'text-delta', text: 'hi' },
    { type: 'message-end' },
    { type: 'done' },
  ]);
  const repo = makeFakeRepo();

  const mgr = new SessionManager(repo, sdk, 'claude-test', (e) => {
    rendererCalls.push(e);
    if ('sessionId' in e && e.sessionId) {
      bus.publish(e.sessionId, { type: 'event', kind: e.type, ...e } as unknown as RemoteOutbound);
    }
  });

  const { sessionId } = await mgr.start({ model: 'claude-test' });
  bus.subscribe(sessionId, (e) => busCalls.push(e));
  await mgr.send({ sessionId, text: 'go' });

  expect(rendererCalls.some((e) => e.type === 'text-delta')).toBe(true);
  expect(busCalls.some((e) => e.type === 'event' && (e as { kind?: string }).kind === 'text-delta')).toBe(true);
});
```

- [ ] **Step 3: Run, expect FAIL.**

- [ ] **Step 4: Modify `src/main/index.ts`** — at the `new SessionManager(...)` call site, change the `emit` argument from `(e) => sendToRenderer(e)` to:

```typescript
const remoteEmit = (sessionId: string, e: SessionEvent) => {
  // shallow re-shape: SessionEvent → RemoteOutbound 'event' variant
  sessionBus.publish(sessionId, { type: 'event', kind: e.type, ...e } as RemoteOutbound);
};

const sessionManager = new SessionManager(repo, sdk, defaultModel, (e) => {
  sendToRenderer(e);
  if ('sessionId' in e && e.sessionId) remoteEmit(e.sessionId, e);
}, onAssistantMessageId);
```

- [ ] **Step 5: Run test, expect PASS.**

- [ ] **Step 6: Wire `enqueueInput` → `sessionManager.send`** — in `index.ts`, after the bus is constructed and the active session begins, register an input handler per active session:

```typescript
sessionManager.onUserActiveListener((sessionId) => {
  sessionBus.setInputHandler(sessionId, async (m) => {
    if (m.type === 'prompt') await sessionManager.send({ sessionId, text: m.text });
    else if (m.type === 'interrupt') sessionManager.cancel({ sessionId });
    // approvals routed via DecisionBroker in Task 17
  });
});
```

- [ ] **Step 7: Commit** —
```bash
git add src/main/index.ts src/main/agent/session.test.ts
git commit -m "agent: fan out session events to SessionBus"
```

---

## Phase 5 — Bridge server (HTTP scaffold + pairing)

### Task 9: HTTP server bound to tailnet IP

**Files:**
- Create: `src/main/remote/bridge-server.ts`
- Test: `src/main/remote/bridge-server.test.ts`

- [ ] **Step 1: Write failing tests** —

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { BridgeServer } from './bridge-server';
import { SessionBus } from './session-bus';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../db/db';
import { PairingStore } from './pairing-store';

let server: BridgeServer | null = null;
const dirs: string[] = [];
afterEach(async () => {
  if (server) await server.stop();
  server = null;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function makeStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'otto-bridge-'));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, 'otto.db'));
  return new PairingStore(db, () => 1000);
}

describe('BridgeServer HTTP', () => {
  it('refuses to start when no tailnet IP is provided', async () => {
    server = new BridgeServer({ tailnetIp: null, pairing: makeStore(), bus: new SessionBus(), pwaDir: null });
    await expect(server.start()).rejects.toThrow(/tailnet/i);
  });

  it('binds to the provided IP and serves a 404 for unknown paths', async () => {
    server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing: makeStore(), bus: new SessionBus(), pwaDir: null });
    const { port } = await server.start();
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** — `src/main/remote/bridge-server.ts`:

```typescript
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { logger } from '../logger';
import type { PairingStore } from './pairing-store';
import type { SessionBus } from './session-bus';

export interface BridgeServerOpts {
  tailnetIp: string | null;
  pairing: PairingStore;
  bus: SessionBus;
  pwaDir: string | null;
}

export class BridgeServer {
  private server: http.Server | null = null;

  constructor(private readonly opts: BridgeServerOpts) {}

  async start(): Promise<{ port: number }> {
    if (!this.opts.tailnetIp) {
      throw new Error('tailnet IP not available; refusing to bind to 0.0.0.0 or 127.0.0.1');
    }
    const server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, this.opts.tailnetIp!, () => resolve());
    });
    this.server = server;
    const { port } = server.address() as AddressInfo;
    logger.info(`remote bridge listening on http://${this.opts.tailnetIp}:${port}`);
    return { port };
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.statusCode = 404;
    res.end('not found');
  }
}
```

Note the localhost-as-stub: tests bind to `127.0.0.1` instead of a real tailnet IP. Production callers always pass the real tailnet IP from `resolveTailnetIp` or `null` (in which case `start` rejects).

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** —
```bash
git add src/main/remote/bridge-server.ts src/main/remote/bridge-server.test.ts
git commit -m "remote: BridgeServer HTTP scaffold"
```

---

### Task 10: Pairing-code mint + `POST /pair`

**Files:**
- Modify: `src/main/remote/bridge-server.ts`
- Test: `src/main/remote/bridge-server.test.ts`

- [ ] **Step 1: Add failing tests** —

```typescript
describe('BridgeServer /pair', () => {
  it('mints a code, accepts /pair with that code, returns a token', async () => {
    const pairing = makeStore();
    server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing, bus: new SessionBus(), pwaDir: null });
    const { port } = await server.start();
    const code = server.mintPairingCode();
    const res = await fetch(`http://127.0.0.1:${port}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceLabel: 'iPhone' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; deviceId: string };
    expect(body.token).toMatch(/.{40,}/);
    expect(body.deviceId).toBeTruthy();
    expect(pairing.list()).toHaveLength(1);
  });

  it('rejects unknown pairing codes with 401', async () => {
    server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing: makeStore(), bus: new SessionBus(), pwaDir: null });
    const { port } = await server.start();
    const res = await fetch(`http://127.0.0.1:${port}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'bogus', deviceLabel: 'iPhone' }),
    });
    expect(res.status).toBe(401);
  });

  it('a pairing code is single-use', async () => {
    server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing: makeStore(), bus: new SessionBus(), pwaDir: null });
    const { port } = await server.start();
    const code = server.mintPairingCode();
    const ok = await fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceLabel: 'A' }) });
    expect(ok.status).toBe(200);
    const dup = await fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, deviceLabel: 'B' }) });
    expect(dup.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Extend `bridge-server.ts`** — add to class:

```typescript
import { randomBytes } from 'node:crypto';

interface PairingCode { code: string; expiresAt: number }
private readonly codes = new Map<string, PairingCode>();
private readonly PAIR_TTL_MS = 120_000;

mintPairingCode(now: number = Date.now()): string {
  const code = randomBytes(32).toString('base64url');
  this.codes.set(code, { code, expiresAt: now + this.PAIR_TTL_MS });
  return code;
}

private async readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}
```

And replace `handle()`:

```typescript
private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    if (req.method === 'POST' && req.url === '/pair') return await this.handlePair(req, res);
    res.statusCode = 404; res.end('not found');
  } catch (err) {
    logger.warn(`bridge: handler error: ${(err as Error).message}`);
    res.statusCode = 500; res.end('internal error');
  }
}

private async handlePair(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await this.readJson<{ code: string; deviceLabel?: string }>(req);
  const entry = this.codes.get(body.code);
  const now = Date.now();
  if (!entry || entry.expiresAt < now) { res.statusCode = 401; res.end('invalid code'); return; }
  this.codes.delete(body.code);
  const { deviceId, token } = await this.opts.pairing.issue(body.deviceLabel ?? 'iPhone');
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ token, deviceId, wsUrl: `/ws` }));
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** —
```bash
git add src/main/remote/bridge-server.ts src/main/remote/bridge-server.test.ts
git commit -m "remote: pairing-code mint and POST /pair"
```

---

### Task 11: Rate-limit `/pair` (10/min per source IP)

**Files:**
- Modify: `src/main/remote/bridge-server.ts`
- Test: `src/main/remote/bridge-server.test.ts`

- [ ] **Step 1: Add failing test** —

```typescript
it('rate-limits /pair to 10 requests per minute per IP', async () => {
  server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing: makeStore(), bus: new SessionBus(), pwaDir: null });
  const { port } = await server.start();
  for (let i = 0; i < 10; i++) {
    await fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'bogus', deviceLabel: 'x' }) });
  }
  const blocked = await fetch(`http://127.0.0.1:${port}/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'bogus', deviceLabel: 'x' }) });
  expect(blocked.status).toBe(429);
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Add rate limiter** — in `bridge-server.ts`:

```typescript
private readonly pairHits = new Map<string, number[]>();
private readonly PAIR_WINDOW_MS = 60_000;
private readonly PAIR_MAX = 10;

private rateLimited(req: http.IncomingMessage): boolean {
  const ip = req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const arr = (this.pairHits.get(ip) ?? []).filter((t) => now - t < this.PAIR_WINDOW_MS);
  if (arr.length >= this.PAIR_MAX) { this.pairHits.set(ip, arr); return true; }
  arr.push(now);
  this.pairHits.set(ip, arr);
  return false;
}
```

And in `handlePair`, at the top:

```typescript
if (this.rateLimited(req)) { res.statusCode = 429; res.end('too many requests'); return; }
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** —
```bash
git add src/main/remote/bridge-server.ts src/main/remote/bridge-server.test.ts
git commit -m "remote: rate-limit /pair to 10/min per IP"
```

---

## Phase 6 — WebSocket: auth, events, history

### Task 12: WS auth handshake

**Files:**
- Modify: `src/main/remote/bridge-server.ts`
- Test: `src/main/remote/bridge-server.test.ts`

- [ ] **Step 1: Add failing test** — at top of test file add:

```typescript
import WebSocket from 'ws';
```

And new test:

```typescript
it('WS closes with auth_failed when first frame is not a valid auth', async () => {
  server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing: makeStore(), bus: new SessionBus(), pwaDir: null });
  const { port } = await server.start();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
  ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'prompt', sessionId: 's1', text: 'hi' })));
  const ev = await closed;
  expect(ev.reason).toMatch(/auth/i);
});

it('WS accepts a valid token and replies auth_ok', async () => {
  const pairing = makeStore();
  const bus = new SessionBus();
  server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing, bus, pwaDir: null });
  const { port } = await server.start();
  const { token } = await pairing.issue('iPhone');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const ok = await new Promise<unknown>((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'auth', token })));
    ws.on('message', (data) => resolve(JSON.parse(data.toString())));
    ws.on('error', reject);
  });
  ws.close();
  expect(ok).toMatchObject({ type: 'auth_ok' });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Add WS server to `bridge-server.ts`** —

```typescript
import { WebSocketServer, WebSocket } from 'ws';

// in BridgeServer class:
private wss: WebSocketServer | null = null;

// in start(), after server.listen:
this.wss = new WebSocketServer({ server, path: '/ws' });
this.wss.on('connection', (ws, req) => this.handleWs(ws, req));

// in stop(), before server.close:
if (this.wss) { this.wss.close(); this.wss = null; }

private handleWs(ws: WebSocket, _req: http.IncomingMessage): void {
  let authed = false;
  let device: { id: string; label: string } | null = null;
  let unsub: (() => void) | null = null;

  const close = (code: number, reason: string) => { try { ws.close(code, reason); } catch { /* ws may already be torn down */ } };

  ws.on('message', async (data) => {
    let msg: { v?: number; type?: string; [k: string]: unknown };
    try { msg = JSON.parse(data.toString()); } catch { return close(1003, 'bad json'); }
    if (!authed) {
      if (msg.type !== 'auth' || typeof msg.token !== 'string') return close(4001, 'auth_failed: first frame must be auth');
      const found = await this.opts.pairing.verify(msg.token);
      if (!found) return close(4001, 'auth_failed');
      authed = true;
      device = { id: found.id, label: found.label };
      ws.send(JSON.stringify({ v: 1, type: 'auth_ok', deviceLabel: found.label }));
      return;
    }
    // post-auth message handling fills in Task 13.
  });

  ws.on('close', () => { if (unsub) unsub(); });
  // expose `device` and `unsub` via closure for subsequent tasks
  void device;
  void unsub;
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** —
```bash
git add src/main/remote/bridge-server.ts src/main/remote/bridge-server.test.ts
git commit -m "remote: WS auth handshake"
```

---

### Task 13: WS event forwarding from `SessionBus`

**Files:**
- Modify: `src/main/remote/bridge-server.ts`
- Test: `src/main/remote/bridge-server.test.ts`

- [ ] **Step 1: Add failing test** —

```typescript
it('forwards SessionBus events for the active session to the WS', async () => {
  const pairing = makeStore();
  const bus = new SessionBus();
  server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing, bus, pwaDir: null, activeSessionId: () => 's1' });
  const { port } = await server.start();
  const { token } = await pairing.issue('iPhone');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages: unknown[] = [];
  await new Promise<void>((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'auth', token })));
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      messages.push(m);
      if (m.type === 'auth_ok') {
        bus.publish('s1', { type: 'event', kind: 'text-delta', text: 'hello' });
        setTimeout(resolve, 50);
      }
    });
  });
  ws.close();
  expect(messages).toContainEqual(expect.objectContaining({ type: 'event', kind: 'text-delta', text: 'hello' }));
});
```

- [ ] **Step 2: Run, expect FAIL** (`activeSessionId` is new; subscription is wired).

- [ ] **Step 3: Update `BridgeServerOpts`** in `bridge-server.ts`:

```typescript
export interface BridgeServerOpts {
  tailnetIp: string | null;
  pairing: PairingStore;
  bus: SessionBus;
  pwaDir: string | null;
  activeSessionId?: () => string | null;
}
```

And in `handleWs`, after successful auth, replace the trailing `void` lines with:

```typescript
const sid = this.opts.activeSessionId?.() ?? null;
if (sid) {
  unsub = this.opts.bus.subscribe(sid, (e) => {
    try { ws.send(JSON.stringify({ v: 1, ...e })); } catch { /* ws may be closed */ }
  });
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** —
```bash
git add src/main/remote/bridge-server.ts src/main/remote/bridge-server.test.ts
git commit -m "remote: forward SessionBus events to WS"
```

---

### Task 14: WS inbound `prompt` and `interrupt` routing

**Files:**
- Modify: `src/main/remote/bridge-server.ts`
- Test: `src/main/remote/bridge-server.test.ts`

- [ ] **Step 1: Add failing test** —

```typescript
it('routes inbound prompt to bus.enqueueInput', async () => {
  const pairing = makeStore();
  const bus = new SessionBus();
  const seen: unknown[] = [];
  bus.setInputHandler('s1', async (m) => { seen.push(m); });
  server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing, bus, pwaDir: null, activeSessionId: () => 's1' });
  const { port } = await server.start();
  const { token } = await pairing.issue('iPhone');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'auth', token })));
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === 'auth_ok') {
        ws.send(JSON.stringify({ v: 1, type: 'prompt', sessionId: 's1', text: 'hi from phone' }));
        setTimeout(resolve, 50);
      }
    });
  });
  ws.close();
  expect(seen).toContainEqual(expect.objectContaining({ type: 'prompt', text: 'hi from phone' }));
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Extend the post-auth branch in `handleWs`** — after `unsub = ...`, replace the “Task 13 fills in” comment in the message handler with:

```typescript
if (msg.type === 'prompt' && typeof msg.sessionId === 'string' && typeof msg.text === 'string') {
  void this.opts.bus.enqueueInput(msg.sessionId, { type: 'prompt', sessionId: msg.sessionId, text: msg.text });
  return;
}
if (msg.type === 'interrupt' && typeof msg.sessionId === 'string') {
  void this.opts.bus.enqueueInput(msg.sessionId, { type: 'interrupt', sessionId: msg.sessionId });
  return;
}
if (msg.type === 'ping') { ws.send(JSON.stringify({ v: 1, type: 'pong' })); return; }
// `approval` lands in Task 17.
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** —
```bash
git add src/main/remote/bridge-server.ts src/main/remote/bridge-server.test.ts
git commit -m "remote: route inbound prompt/interrupt/ping"
```

---

### Task 15: `GET /history?session_id=&since=` backfill

**Files:**
- Modify: `src/main/remote/bridge-server.ts`
- Test: `src/main/remote/bridge-server.test.ts`

- [ ] **Step 1: Add failing test** —

```typescript
it('GET /history requires auth token and returns events from the ring', async () => {
  const pairing = makeStore();
  const bus = new SessionBus();
  server = new BridgeServer({ tailnetIp: '127.0.0.1', pairing, bus, pwaDir: null });
  const { port } = await server.start();
  const { token } = await pairing.issue('iPhone');
  bus.publish('s1', { type: 'event', kind: 'a' });
  bus.publish('s1', { type: 'event', kind: 'b' });
  const noauth = await fetch(`http://127.0.0.1:${port}/history?session_id=s1&since=0`);
  expect(noauth.status).toBe(401);
  const ok = await fetch(`http://127.0.0.1:${port}/history?session_id=s1&since=0`, { headers: { authorization: `Bearer ${token}` } });
  expect(ok.status).toBe(200);
  const body = (await ok.json()) as { events: Array<{ seq: number }>; truncated: boolean };
  expect(body.events).toHaveLength(2);
  expect(body.truncated).toBe(false);
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Extend `handle()`** —

```typescript
if (req.method === 'GET' && req.url?.startsWith('/history')) return await this.handleHistory(req, res);
```

And add:

```typescript
private async handleHistory(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!token || !(await this.opts.pairing.verify(token))) { res.statusCode = 401; res.end('unauthorized'); return; }
  const url = new URL(req.url!, 'http://x');
  const sid = url.searchParams.get('session_id') ?? '';
  const since = Number(url.searchParams.get('since') ?? '0');
  const out = this.opts.bus.history(sid, isFinite(since) ? since : 0);
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(out));
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit** —
```bash
git add src/main/remote/bridge-server.ts src/main/remote/bridge-server.test.ts
git commit -m "remote: GET /history backfill with bearer auth"
```

---

### Task 16: Signed, expiring screenshot URLs

**Files:**
- Create: `src/main/remote/screenshot-urls.ts`
- Test: `src/main/remote/screenshot-urls.test.ts`
- Modify: `src/main/remote/bridge-server.ts`
- Test: `src/main/remote/bridge-server.test.ts`

- [ ] **Step 1: Write failing test for the signer** — `src/main/remote/screenshot-urls.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ScreenshotUrlSigner } from './screenshot-urls';

describe('ScreenshotUrlSigner', () => {
  const signer = new ScreenshotUrlSigner('test-secret', () => 1000);

  it('signs and verifies a fresh URL', () => {
    const url = signer.sign('abc');
    const { ok, id } = signer.verify(url);
    expect(ok).toBe(true);
    expect(id).toBe('abc');
  });

  it('rejects expired URLs', () => {
    const signer2 = new ScreenshotUrlSigner('test-secret', () => 1000);
    const url = signer2.sign('abc');
    const signer3 = new ScreenshotUrlSigner('test-secret', () => 1000 + 120_000);
    expect(signer3.verify(url).ok).toBe(false);
  });

  it('rejects tampered URLs', () => {
    const url = signer.sign('abc');
    const tampered = url.replace('id=abc', 'id=xyz');
    expect(signer.verify(tampered).ok).toBe(false);
  });

  it('single-use: second verify of same URL fails', () => {
    const url = signer.sign('abc');
    expect(signer.verify(url).ok).toBe(true);
    expect(signer.verify(url).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** — `src/main/remote/screenshot-urls.ts`:

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

const TTL_MS = 60_000;

export class ScreenshotUrlSigner {
  private readonly consumed = new Set<string>();
  constructor(private readonly secret: string, private readonly now: () => number = Date.now) {}

  sign(id: string): string {
    const exp = this.now() + TTL_MS;
    const sig = this.hmac(`${id}|${exp}`);
    return `/screenshot/${encodeURIComponent(id)}?id=${encodeURIComponent(id)}&exp=${exp}&sig=${sig}`;
  }

  verify(url: string): { ok: boolean; id: string | null } {
    const u = new URL(url, 'http://x');
    const id = u.searchParams.get('id') ?? '';
    const exp = Number(u.searchParams.get('exp') ?? '0');
    const sig = u.searchParams.get('sig') ?? '';
    if (!id || !exp || !sig) return { ok: false, id: null };
    if (this.now() > exp) return { ok: false, id: null };
    const expected = this.hmac(`${id}|${exp}`);
    if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return { ok: false, id: null };
    const consumeKey = `${id}|${exp}|${sig}`;
    if (this.consumed.has(consumeKey)) return { ok: false, id: null };
    this.consumed.add(consumeKey);
    return { ok: true, id };
  }

  private hmac(s: string): string {
    return createHmac('sha256', this.secret).update(s).digest('base64url');
  }
}
```

- [ ] **Step 4: Run signer test, expect PASS.**

- [ ] **Step 5: Wire `GET /screenshot/*` into `BridgeServer`** — add to `BridgeServerOpts`:

```typescript
screenshotSecret: string;
loadScreenshot: (id: string) => Promise<Buffer | null>;
```

In `handle()`:

```typescript
if (req.method === 'GET' && req.url?.startsWith('/screenshot/')) return await this.handleScreenshot(req, res);
```

And add:

```typescript
private signer: ScreenshotUrlSigner | null = null;
// in constructor body: this.signer = new ScreenshotUrlSigner(opts.screenshotSecret);

signScreenshotUrl(id: string): string { return this.signer!.sign(id); }

private async handleScreenshot(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const result = this.signer!.verify(req.url!);
  if (!result.ok || !result.id) { res.statusCode = 401; res.end('bad url'); return; }
  const buf = await this.opts.loadScreenshot(result.id);
  if (!buf) { res.statusCode = 404; res.end('not found'); return; }
  res.statusCode = 200;
  res.setHeader('content-type', 'image/png');
  res.end(buf);
}
```

- [ ] **Step 6: Add bridge integration test** — append to `bridge-server.test.ts`:

```typescript
it('serves a signed screenshot URL once, then 401', async () => {
  const pairing = makeStore();
  const bus = new SessionBus();
  server = new BridgeServer({
    tailnetIp: '127.0.0.1', pairing, bus, pwaDir: null,
    screenshotSecret: 'unit-test-secret',
    loadScreenshot: async () => Buffer.from([137, 80, 78, 71]),
  });
  const { port } = await server.start();
  const url = server.signScreenshotUrl('shot-1');
  const ok = await fetch(`http://127.0.0.1:${port}${url}`);
  expect(ok.status).toBe(200);
  const dup = await fetch(`http://127.0.0.1:${port}${url}`);
  expect(dup.status).toBe(401);
});
```

- [ ] **Step 7: Run, expect PASS.**

- [ ] **Step 8: Commit** —
```bash
git add src/main/remote/screenshot-urls.ts src/main/remote/screenshot-urls.test.ts src/main/remote/bridge-server.ts src/main/remote/bridge-server.test.ts
git commit -m "remote: signed expiring screenshot URLs"
```

---

### Task 17: Approval bridging (first-resolver-wins)

**Files:**
- Modify: `src/main/autonomy/decision-broker.ts` (no schema changes — keep `resolve(decisionId, choice)` API)
- Modify: `src/main/remote/bridge-server.ts`
- Modify: `src/main/index.ts`
- Test: `src/main/remote/bridge-server.test.ts`

The existing `DecisionBroker.resolve(decisionId, choice)` is idempotent-by-design (it returns early if `decisionId` is unknown — see `pending.get(decisionId)` returning undefined). That gives us first-resolver-wins for free. The bridge just needs to:
1. Translate `tool-call-pending` events the bus already publishes into `approval_pending` outbound messages on the WS, with `actionClass` carried through.
2. Accept inbound `approval` messages and call `decisionBroker.resolve(...)`.

- [ ] **Step 1: Add failing test** —

```typescript
it('inbound approval message resolves the DecisionBroker via injected resolver', async () => {
  const pairing = makeStore();
  const bus = new SessionBus();
  const resolved: Array<{ decisionId: string; choice: string }> = [];
  server = new BridgeServer({
    tailnetIp: '127.0.0.1', pairing, bus, pwaDir: null,
    screenshotSecret: 'x', loadScreenshot: async () => null,
    activeSessionId: () => 's1',
    resolveApproval: (id, choice) => { resolved.push({ decisionId: id, choice }); return true; },
  });
  const { port } = await server.start();
  const { token } = await pairing.issue('iPhone');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve) => {
    ws.on('open', () => ws.send(JSON.stringify({ v: 1, type: 'auth', token })));
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === 'auth_ok') {
        ws.send(JSON.stringify({ v: 1, type: 'approval', decisionId: 'd1', decision: 'approve' }));
        setTimeout(resolve, 50);
      }
    });
  });
  ws.close();
  expect(resolved).toEqual([{ decisionId: 'd1', choice: 'approve' }]);
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Extend `BridgeServerOpts`** — add `resolveApproval?: (decisionId: string, choice: 'approve' | 'deny') => boolean`.

And in the post-auth message branch:

```typescript
if (msg.type === 'approval' && typeof msg.decisionId === 'string' && (msg.decision === 'approve' || msg.decision === 'deny')) {
  this.opts.resolveApproval?.(msg.decisionId, msg.decision);
  return;
}
```

- [ ] **Step 4: Wire in `src/main/index.ts`** — pass `resolveApproval: (id, choice) => { decisionBroker.resolve(id, choice); return true; }` to `new BridgeServer({...})`.

- [ ] **Step 5: Run test, expect PASS.**

- [ ] **Step 6: Manual sanity** — `pnpm typecheck`.

- [ ] **Step 7: Commit** —
```bash
git add src/main/remote/bridge-server.ts src/main/remote/bridge-server.test.ts src/main/index.ts
git commit -m "remote: route inbound approvals to DecisionBroker"
```

---

### Task 18: Autonomy clamp for remote turns

**Files:**
- Modify: `src/main/autonomy/policy.ts` (read-only audit; add a clamp helper if missing)
- Test: `src/main/autonomy/policy.test.ts`
- Modify: `src/main/index.ts` (wire `originSurface` through `enqueueInput → sessionManager.send`)

The bus's input handler must propagate that a turn was originated remotely so the broker can clamp. Approach: extend the `RemoteInbound` `prompt` variant with `origin: 'desktop' | 'remote'` (default `'desktop'` when called from existing IPC), thread it through `SessionManager.send`, and have `DecisionBroker.decide` accept an `origin` arg. The broker consults a `remoteCeiling` getter only when `origin === 'remote'`.

Concrete type change in `src/main/remote/session-bus.ts`:

```typescript
export type RemoteInbound =
  | { type: 'prompt'; sessionId: string; text: string; origin: 'desktop' | 'remote' }
  | { type: 'approval'; decisionId: string; decision: 'approve' | 'deny' }
  | { type: 'interrupt'; sessionId: string };
```

Existing call sites that build `prompt` messages (from Task 14 and the index.ts setInputHandler) must pass `origin: 'remote'` when the source is the WS handler and `origin: 'desktop'` everywhere else.

- [ ] **Step 1: Read `src/main/autonomy/policy.ts`** to find the existing `evaluate(mode, actionClass) → Decision`. Add (if absent) a helper `clamp(desktopMode, ceiling)` returning the more-restrictive mode using ordering `strict < balanced < full-allow`.

- [ ] **Step 2: Add failing test** in `policy.test.ts`:

```typescript
import { clamp } from './policy';

describe('clamp', () => {
  it('returns the more-restrictive mode', () => {
    expect(clamp('full-allow', 'strict')).toBe('strict');
    expect(clamp('balanced', 'full-allow')).toBe('balanced');
    expect(clamp('balanced', 'match')).toBe('balanced');
    expect(clamp('strict', 'match')).toBe('strict');
  });
});
```

- [ ] **Step 3: Implement `clamp`** in `policy.ts`:

```typescript
const ORDER: Record<AutonomyMode, number> = { strict: 0, balanced: 1, 'full-allow': 2 };
export type RemoteCeiling = AutonomyMode | 'match';
export function clamp(desktop: AutonomyMode, ceiling: RemoteCeiling): AutonomyMode {
  if (ceiling === 'match') return desktop;
  return ORDER[ceiling] < ORDER[desktop] ? ceiling : desktop;
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Extend `DecisionBroker.decide`** to accept an `origin` field and consult a `remoteCeiling` getter; only the `origin === 'remote'` branch uses `clamp(this.mode, ceiling)` instead of `this.mode`. Add a unit test for this in `decision-broker.test.ts`.

- [ ] **Step 6: Wire in `src/main/index.ts`** — the `setInputHandler` callback constructed in Task 8 calls `sessionManager.send({ sessionId, text, origin: 'remote' })`. Add `origin?: 'desktop' | 'remote'` to `SessionManager.send` args and thread to whatever path constructs the `decide()` args.

- [ ] **Step 7: Commit** —
```bash
git add src/main/autonomy/policy.ts src/main/autonomy/policy.test.ts src/main/autonomy/decision-broker.ts src/main/autonomy/decision-broker.test.ts src/main/agent/session.ts src/main/index.ts
git commit -m "autonomy: clamp remote-originated turns to remote_ceiling"
```

---

## Phase 7 — Module wiring and supervisor

### Task 19: `RemoteModule` start/stop + tailnet polling + crash supervisor

**Files:**
- Create: `src/main/remote/index.ts`
- Test: `src/main/remote/index.test.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Write failing tests** for `RemoteModule`:

```typescript
import { describe, it, expect } from 'vitest';
import { RemoteModule } from './index';

describe('RemoteModule', () => {
  it('stays down when tailnet IP is null', async () => {
    const mod = new RemoteModule({ resolveTailnetIp: async () => null, /* ...other deps via fakes... */ });
    await mod.start();
    expect(mod.status()).toMatchObject({ running: false, reason: /tailnet/i });
  });

  it('restarts the bridge once if it crashes', async () => {
    // construct with a BridgeServer factory that throws on first start and succeeds on second
    // assert mod.status().running === true after restart attempt
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** — `src/main/remote/index.ts` exposing `RemoteModule` with:
  - `start()` resolves tailnet IP, constructs `BridgeServer`, polls every 60s for IP change, rebinds on change.
  - `stop()` tears down bridge and stops polling.
  - `status()` returns `{ running, reason?, url?, pairedCount }`.
  - Crash supervisor: catches `bridge.start()` throws, retries once after 1s; if a second crash happens within 60s, stays down and logs.

- [ ] **Step 4: Wire into `src/main/index.ts`** — instantiate `RemoteModule` after `PairingStore`, `SessionBus`, and `BridgeServer` factory are available. Start it conditionally on settings (`remote.enabled`).

- [ ] **Step 5: Run, expect PASS.**

- [ ] **Step 6: Commit** —
```bash
git add src/main/remote/index.ts src/main/remote/index.test.ts src/main/index.ts
git commit -m "remote: RemoteModule (tailnet polling + supervisor)"
```

---

## Phase 8 — Settings persistence and IPC

### Task 20: `remote` settings block

**Files:**
- Create: `src/main/remote/settings.ts`
- Test: `src/main/remote/settings.test.ts`
- Modify: existing settings loader (look at `src/main/autonomy/settings.ts` for pattern)

- [ ] **Step 1: Read `src/main/autonomy/settings.ts`** to mirror its load/save shape.

- [ ] **Step 2: Write failing tests** —

```typescript
import { loadRemoteSettings, saveRemoteSettings, defaultRemoteSettings } from './settings';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

it('returns defaults when no file exists', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'otto-rs-'));
  const settings = loadRemoteSettings(path.join(dir, 'remote.json'));
  expect(settings).toEqual(defaultRemoteSettings());
  rmSync(dir, { recursive: true, force: true });
});

it('round-trips enabled + remoteCeiling', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'otto-rs-'));
  const file = path.join(dir, 'remote.json');
  saveRemoteSettings(file, { enabled: true, remoteCeiling: 'strict' });
  expect(loadRemoteSettings(file)).toEqual({ enabled: true, remoteCeiling: 'strict' });
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run, expect FAIL.**

- [ ] **Step 4: Implement** —

```typescript
import fs from 'node:fs';
import path from 'node:path';
import type { RemoteCeiling } from '../autonomy/policy';

export interface RemoteSettings {
  enabled: boolean;
  remoteCeiling: RemoteCeiling;
}

export function defaultRemoteSettings(): RemoteSettings {
  return { enabled: false, remoteCeiling: 'match' };
}

export function loadRemoteSettings(file: string): RemoteSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...defaultRemoteSettings(), ...raw };
  } catch {
    return defaultRemoteSettings();
  }
}

export function saveRemoteSettings(file: string, s: RemoteSettings): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
}
```

- [ ] **Step 5: Run, expect PASS. Commit** —
```bash
git add src/main/remote/settings.ts src/main/remote/settings.test.ts
git commit -m "remote: settings persistence (enabled, remoteCeiling)"
```

---

### Task 21: IPC channels for remote

**Files:**
- Modify: `src/shared/ipc-contract.ts`
- Modify: `src/main/ipc/handlers.ts`
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Define channel contract** in `src/shared/ipc-contract.ts`:

```typescript
export interface RemoteIpc {
  getStatus(): Promise<{ running: boolean; url: string | null; reason: string | null; enabled: boolean; remoteCeiling: 'match' | 'strict' | 'balanced' | 'full-allow' }>;
  setEnabled(enabled: boolean): Promise<void>;
  setRemoteCeiling(c: 'match' | 'strict' | 'balanced' | 'full-allow'): Promise<void>;
  mintPairingCode(): Promise<{ code: string; url: string; expiresAt: number }>;
  listDevices(): Promise<Array<{ id: string; label: string; pairedAt: number; lastSeenAt: number | null }>>;
  revokeDevice(id: string): Promise<void>;
}
```

- [ ] **Step 2: Implement handlers** in `src/main/ipc/handlers.ts` using channel names `remote:getStatus`, `remote:setEnabled`, `remote:setRemoteCeiling`, `remote:mintPairingCode`, `remote:listDevices`, `remote:revokeDevice`.

- [ ] **Step 3: Expose in `src/preload/index.ts`** under `window.otto.remote`.

- [ ] **Step 4: typecheck + commit** —
```bash
pnpm typecheck
git add src/shared/ipc-contract.ts src/main/ipc/handlers.ts src/preload/index.ts
git commit -m "remote: IPC channels for status/pair/revoke"
```

---

## Phase 9 — Settings UI panel

### Task 22: "Remote access" panel skeleton

**Files:**
- Modify: `src/main/settings-window.ts` (or wherever settings UI is mounted)
- Create: `src/renderer/settings/remote-panel.tsx`

- [ ] **Step 1: Inspect existing settings UI** — `ls src/renderer/settings/` (or similar) to find the existing panel pattern.

- [ ] **Step 2: Create `remote-panel.tsx`** with: enable toggle, status line ("Listening on `http://100.x.y.z:NNNN`" or "Tailscale not detected — install/start Tailscale"), remote ceiling dropdown (Match desktop / Force strict), "Pair new device" button, paired-device list with revoke buttons.

- [ ] **Step 3: Wire `window.otto.remote.*` calls** in component effects.

- [ ] **Step 4: Add to settings navigation** — register the panel route/tab.

- [ ] **Step 5: Manual smoke** — `pnpm dev`; open Settings → "Remote access". Toggle visible, defaults shown.

- [ ] **Step 6: Commit** —
```bash
git add src/main/settings-window.ts src/renderer/settings/remote-panel.tsx
git commit -m "settings: Remote access panel skeleton"
```

---

### Task 23: QR pairing modal

**Files:**
- Create: `src/renderer/settings/pair-modal.tsx`
- Modify: `src/renderer/settings/remote-panel.tsx`

- [ ] **Step 1:** Implement modal: clicking "Pair new device" calls `window.otto.remote.mintPairingCode()`, renders QR using `qrcode` package (`QRCode.toDataURL`), displays the URL + a 2-minute countdown, "Done" closes the modal.

- [ ] **Step 2: Auto-refresh device list** when modal closes (poll `listDevices` once on close, plus a 5s interval while modal is open to catch the moment the phone completes pairing).

- [ ] **Step 3: Commit** —
```bash
git add src/renderer/settings/pair-modal.tsx src/renderer/settings/remote-panel.tsx
git commit -m "settings: QR pairing modal"
```

---

### Task 24: Paired-device list + revoke

**Files:**
- Modify: `src/renderer/settings/remote-panel.tsx`

- [ ] **Step 1:** Render list as `{label} · paired {pairedAt} · last seen {lastSeenAt ?? 'never'}` with a Revoke button. On revoke, `confirm()` then call `window.otto.remote.revokeDevice(id)`, re-fetch list.

- [ ] **Step 2: Manual smoke** — pair from `wscat`-style script (use `/pair` directly via curl), confirm appears in list, revoke removes.

- [ ] **Step 3: Commit** —
```bash
git add src/renderer/settings/remote-panel.tsx
git commit -m "settings: paired-device list + revoke"
```

---

## Phase 10 — PWA

### Task 25: Second Vite renderer entry

**Files:**
- Modify: `electron.vite.config.ts`
- Create: `src/renderer-remote/index.html`
- Create: `src/renderer-remote/main.tsx`
- Create: `src/renderer-remote/App.tsx`
- Create: `src/renderer-remote/manifest.webmanifest`

- [ ] **Step 1: Extend `electron.vite.config.ts`**:

```typescript
renderer: [
  { /* existing renderer config */ },
  {
    root: 'src/renderer-remote',
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { outDir: 'out/renderer-remote', rollupOptions: { input: 'src/renderer-remote/index.html' } },
  },
],
```

(Confirm electron-vite supports an array; if not, build the PWA via a standalone `vite.config.ts` invoked from a custom build script.)

- [ ] **Step 2: Implement `App.tsx`** — minimal "Hello from PWA" with the build hash visible, so we can prove the second bundle ships.

- [ ] **Step 3: Add `manifest.webmanifest`** — name, short_name, start_url `/`, display `standalone`, theme/background color matching Otto branding.

- [ ] **Step 4: Update `BridgeServer.handle()`** to serve `out/renderer-remote/*` as static (or `pwaDir` if provided). Set proper MIME types for `.html`, `.js`, `.css`, `.webmanifest`. No directory listing.

- [ ] **Step 5: Manual smoke** — `pnpm build`, run Otto with a fake tailnet IP override pointing at 127.0.0.1, `curl http://127.0.0.1:PORT/` returns the PWA HTML.

- [ ] **Step 6: Commit** —
```bash
git add electron.vite.config.ts src/renderer-remote/
git commit -m "pwa: second Vite entry + bridge static serving"
```

---

### Task 26: PWA pair screen

**Files:**
- Create: `src/renderer-remote/pair.tsx`
- Create: `src/renderer-remote/wire.ts`
- Create: `src/renderer-remote/store.ts`
- Modify: `src/renderer-remote/App.tsx`

- [ ] **Step 1: Implement `store.ts`** — zustand store with `{ token: string | null, sessionId: string | null, autonomyMode: string | null }`. Persist `token` to `localStorage` under key `otto.remote.token`.

- [ ] **Step 2: Implement `wire.ts`** — wrapper around `fetch` and `WebSocket` that attaches the token. Functions: `pair(code, label)`, `openWs(token, handlers)`, `getHistory(since)`.

- [ ] **Step 3: Implement `pair.tsx`** — input field for pairing URL, parses out `?code=`, calls `wire.pair(code, navigator.userAgent.includes('iPhone') ? 'iPhone' : 'Browser')`, stores returned token in zustand+localStorage, navigates to chat.

- [ ] **Step 4: Route in `App.tsx`** — if no token, render `<Pair/>`; otherwise render `<Chat/>` (placeholder for Task 27).

- [ ] **Step 5: Commit** —
```bash
git add src/renderer-remote/pair.tsx src/renderer-remote/wire.ts src/renderer-remote/store.ts src/renderer-remote/App.tsx
git commit -m "pwa: pair screen + token persistence"
```

---

### Task 27: PWA chat + streaming

**Files:**
- Create: `src/renderer-remote/chat.tsx`
- Modify: `src/renderer-remote/App.tsx`

- [ ] **Step 1: Implement `chat.tsx`** —
  - On mount, call `wire.openWs(token, handlers)`. Handlers:
    - `auth_ok`: store `sessionId`, `autonomyMode`. Call `wire.getHistory(0)` to backfill.
    - `event.kind === 'text-delta'`: append to current streaming assistant bubble.
    - `event.kind === 'tool-call-start'`: append tool card.
    - `event.kind === 'tool-call-result'`: update tool card.
    - `event.kind === 'done'`: finalize current bubble.
    - `approval_pending`: push to pending approvals (rendered in Task 28).
  - Input bar at bottom: textarea + send button → `ws.send({ v:1, type:'prompt', sessionId, text })`. Disabled while a turn is streaming.
  - Reconnect with exponential backoff (1s → 30s) on WS close.
  - 20s `ping` keepalive.

- [ ] **Step 2: Manual smoke** — open desktop Otto, pair an iOS Simulator's Safari (or desktop Safari) against `http://127.0.0.1:PORT/`, send a prompt, observe streaming.

- [ ] **Step 3: Commit** —
```bash
git add src/renderer-remote/chat.tsx src/renderer-remote/App.tsx
git commit -m "pwa: chat surface with streaming + reconnect"
```

---

### Task 28: Approval cards

**Files:**
- Create: `src/renderer-remote/approval-card.tsx`
- Modify: `src/renderer-remote/chat.tsx`

- [ ] **Step 1: Implement `approval-card.tsx`** — large, prominent card with:
  - Tool name in bold
  - **Action class badge** (`read` / `reversible` / `destructive` / `irreversible`) color-coded
  - Summary (truncated tool input)
  - Approve / Deny buttons → `ws.send({ v:1, type:'approval', decisionId, decision })`
  - Dismiss on incoming `approval_resolved` with matching `decisionId`; if resolved by another surface, show "(approved on desktop)" briefly.

- [ ] **Step 2: Render pending approvals at top of chat** in `chat.tsx`.

- [ ] **Step 3: Commit** —
```bash
git add src/renderer-remote/approval-card.tsx src/renderer-remote/chat.tsx
git commit -m "pwa: approval cards with action-class badge"
```

---

### Task 29: Screenshot thumbs

**Files:**
- Create: `src/renderer-remote/screenshot.tsx`
- Modify: `src/renderer-remote/chat.tsx`
- Modify: `src/main/remote/bridge-server.ts` (emit signed URL inside `screenshot-captured` events)
- Modify: `src/main/index.ts` (provide `loadScreenshot` impl reading from existing screenshot store)

- [ ] **Step 1:** When the agent emits a `screenshot-captured` event into the bus, wrap it in the bridge's fan-out to add a `signedUrl` field. Do this in the existing bus-publish wrapper from Task 8 by detecting the event kind.

- [ ] **Step 2: Implement `screenshot.tsx`** — fetches the signed URL (with `Authorization: Bearer <token>` since the URL endpoint also accepts bearer auth for backfill), shows a thumb, tap-to-fullscreen.

- [ ] **Step 3: Render thumbs inline** in the chat transcript wherever a `screenshot-captured` event appears.

- [ ] **Step 4: Commit** —
```bash
git add src/renderer-remote/screenshot.tsx src/renderer-remote/chat.tsx src/main/remote/bridge-server.ts src/main/index.ts
git commit -m "pwa: screenshot thumbs with signed URL fetch"
```

---

## Phase 11 — E2E and release notes

### Task 30: Playwright E2E

**Files:**
- Create: `tests/remote/pair-and-chat.e2e.ts`

- [ ] **Step 1: Write E2E** that:
  1. Spawns Otto in test mode with a fake tailnet IP `127.0.0.1` and a fake agent that scripts `text-delta` events.
  2. Opens a second browser context simulating the desktop Settings, mints a pairing code via IPC.
  3. Opens a third context simulating the PWA on `http://127.0.0.1:PORT/`, posts to `/pair`, navigates to chat.
  4. Sends a prompt → observes streaming bubble.
  5. Fake agent emits a `tool-call-pending` → PWA renders approval card → tap Approve → fake agent observes the resolution.
  6. Closes PWA, fake agent emits more events → PWA reconnects → backfill via `/history` → transcript matches.

- [ ] **Step 2: Run** — `pnpm test:integration -- tests/remote/pair-and-chat.e2e.ts`.

- [ ] **Step 3: Commit** —
```bash
git add tests/remote/pair-and-chat.e2e.ts
git commit -m "remote: E2E pair → chat → approval → reconnect"
```

---

### Task 31: Release notes + manual smoke checklist

**Files:**
- Modify: `RELEASE_NOTES.md`
- Create: `docs/superpowers/notes/2026-05-24-iphone-remote-manual-smoke.md`

- [ ] **Step 1: Add to `RELEASE_NOTES.md`** under an `## Unreleased` section: "iPhone remote: pair an iPhone via QR code over Tailscale; full chat + approvals + screenshots from the phone, with autonomy clamping for remote turns."

- [ ] **Step 2: Write manual smoke checklist** — a markdown file capturing:
  - [ ] Tailscale running on both devices.
  - [ ] Settings → Remote access → enable → status shows tailnet URL.
  - [ ] Pair iPhone via QR; device appears in list.
  - [ ] Open PWA, "Add to Home Screen", kill, reopen — token persisted, lands on chat.
  - [ ] Send prompt from phone, observe streaming on desktop too.
  - [ ] Trigger an autonomy gate; approval card appears on both; resolving on phone dismisses on desktop.
  - [ ] Stop Tailscale, restart Otto — Settings shows "Tailscale not detected" warning, no port exposed.
  - [ ] Cellular-only test: Wi-Fi off on phone, connect via tailnet — works.

- [ ] **Step 3: Commit** —
```bash
git add RELEASE_NOTES.md docs/superpowers/notes/2026-05-24-iphone-remote-manual-smoke.md
git commit -m "docs: iPhone remote release notes + manual smoke checklist"
```

---

## Self-Review Checklist (for the executor)

- [ ] `pnpm typecheck` clean.
- [ ] `pnpm test` clean.
- [ ] `pnpm lint` clean.
- [ ] `pnpm test:integration` clean.
- [ ] Manual smoke checklist (Task 31) walked through on real hardware.
- [ ] Spec gaps: every numbered section of `2026-05-24-iphone-remote-design.md` maps to at least one task above. Sections 1–6 of the spec correspond to Tasks 1–19 (backend/bridge), 20–24 (settings), 25–29 (PWA), 30–31 (testing/release).

## Notes for the Executor

- **TDD discipline:** every code-bearing task here writes the test first, runs it failing, then implements. Don't batch — small green steps stay green.
- **Frequent commits:** each task ends in a commit. A 31-task PR is the wrong shape; merge in 2-3 logical chunks (e.g., Phases 1–4, 5–7, 8–11).
- **DRY:** `BridgeServer.handle()` will grow handlers. Resist a "router" abstraction until at least 5 routes exist (currently 4: `/pair`, `/history`, `/screenshot/*`, `/ws` upgrade). Same for inbound WS message types.
- **YAGNI:** do not add token rotation, push notifications, multi-session phone UI, or remote autonomy editing. They are explicit non-goals in the spec.
- **Native dep ABI:** `argon2` is a native module. Run `node scripts/ensure-abi.mjs electron` before `pnpm dev` if anything misbehaves at runtime, and `node scripts/ensure-abi.mjs node` before `pnpm test`.
