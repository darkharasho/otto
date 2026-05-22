# Otto Shell / Process Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five shell tools (`shell.exec`, `shell.spawn`, `shell.read`, `shell.wait`, `shell.kill`) that run via `sh -c` on Linux, with dynamic action-class classification, per-tool denylist patterns over the command string, an inline `ProcessCard` for spawned processes (live output + Cancel), and a `ProcessRegistry` that cleans up on app quit.

**Architecture:** New `src/main/shell/` module with three units — `executor.ts` (thin `child_process` wrapper), `process-registry.ts` (in-memory handle map + lifecycle events), `command-class.ts` (pure classify + denyReason). `OttoTool` gains `actionClassFor?(input) → ActionClass`; the MCP handler in `sdk-client.ts` uses it when present. The `PlatformAdapter` interface gains a `shell` namespace; `LinuxAdapter` implements it. Spec: `docs/superpowers/specs/2026-05-22-otto-shell-design.md`.

**Tech Stack:** TypeScript, Vitest, React + Tailwind, Electron IPC, Node `child_process`. No new dependencies.

---

## File Structure

```
src/main/shell/
  executor.ts                     # Task 2: exec + spawn helpers
  executor.test.ts
  command-class.ts                # Task 3: classify + denyReason
  command-class.test.ts
  process-registry.ts             # Task 4: in-memory handle map + events
  process-registry.test.ts
src/main/platform/
  index.ts                        # Task 1: PlatformAdapter.shell interface
  linux.ts                        # Task 1: shell impl
src/main/agent/
  tools.ts                        # Task 5: OttoTool gains actionClassFor; buildShellTools factory
  sdk-client.ts                   # Task 6: use actionClassFor when present
src/main/ipc/
  handlers.ts                     # Task 7: shell.kill IPC channel
src/main/index.ts                 # Task 8: registry construction + before-quit cleanup
src/shared/
  ipc-contract.ts                 # Task 1: +5 SessionEvent variants, shell.kill channel
  messages.ts                     # Task 1: process_output ContentBlock
src/renderer/
  state/store.ts                  # Task 9: reducer cases for process events
  state/store.test.ts
  components/ProcessCard.tsx      # Task 10
  components/ProcessCard.test.tsx
  components/Message.tsx          # Task 10: render process_output
tests/integration/
  shell.spec.ts                   # Task 11: exec + spawn/Cancel smoke
```

---

## Task 1: Shared Types — process_output Block, SessionEvent Variants, shell.kill Channel, PlatformAdapter.shell

**Files:**
- Modify: `src/shared/messages.ts`
- Modify: `src/shared/ipc-contract.ts`
- Modify: `src/main/platform/index.ts`
- Modify: `src/main/platform/linux.ts`

Pure type additions. No behavior yet.

- [ ] **Step 1: Add `process_output` to `ContentBlock` in `src/shared/messages.ts`**

Add the variant to the existing `ContentBlock` union (keep the existing variants):

```ts
  | {
      type: 'process_output';
      handle: string;
      command: string;
      cwd: string;
      lines: Array<{ stream: 'stdout' | 'stderr'; data: string }>;
      status: 'running' | 'exited' | 'killed';
      exitCode: number | null;
    }
```

- [ ] **Step 2: Extend `src/shared/ipc-contract.ts`**

Append to the `SessionEvent` union (keep existing variants):

```ts
  | { type: 'process-spawned'; sessionId: string; messageId: string; handle: string; pid: number; command: string; cwd: string }
  | { type: 'process-stdout'; sessionId: string; messageId: string; handle: string; data: string }
  | { type: 'process-stderr'; sessionId: string; messageId: string; handle: string; data: string }
  | {
      type: 'process-exited';
      sessionId: string;
      messageId: string;
      handle: string;
      exitCode: number | null;
      signal: string | null;
    }
  | { type: 'process-killed'; sessionId: string; messageId: string; handle: string };
```

Append to `IpcRequest`:

```ts
  | { channel: 'shell.kill'; args: { handle: string }; result: { killed: boolean } };
```

- [ ] **Step 3: Update `src/main/platform/index.ts` — add `shell` namespace**

Read the existing file first. Add a `ShellChild` interface (also used by `executor.ts`) and extend `PlatformAdapter`:

```ts
import { LinuxAdapter } from './linux';

export type DisplayServer = 'x11' | 'wayland' | 'unknown';

export interface ShellChild {
  pid: number;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal: NodeJS.Signals): boolean;
  exited: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
}

export interface PlatformAdapter {
  readonly name: 'linux' | 'darwin' | 'win32';
  detectDisplayServer(): DisplayServer;
  defaultHotkey(): string;
  shell: {
    spawnShell(command: string, cwd: string): ShellChild;
    composeEnv(): NodeJS.ProcessEnv;
  };
}

export function getPlatformAdapter(): PlatformAdapter {
  if (process.platform === 'linux') return new LinuxAdapter();
  throw new Error(`Otto skeleton supports linux only (current: ${process.platform})`);
}
```

- [ ] **Step 4: Implement `shell` in `src/main/platform/linux.ts`**

Replace the file with:

```ts
import { spawn as nodeSpawn } from 'node:child_process';
import type { DisplayServer, PlatformAdapter, ShellChild } from './index';

export class LinuxAdapter implements PlatformAdapter {
  readonly name = 'linux';

  detectDisplayServer(): DisplayServer {
    const s = (process.env.XDG_SESSION_TYPE ?? '').toLowerCase();
    if (s === 'wayland') return 'wayland';
    if (s === 'x11') return 'x11';
    return 'unknown';
  }

  defaultHotkey(): string {
    return 'Super+Space';
  }

  shell = {
    spawnShell: (command: string, cwd: string): ShellChild => {
      const child = nodeSpawn('sh', ['-c', command], {
        cwd,
        env: this.shell.composeEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.once('exit', (code, signal) => resolve({ exitCode: code, signal }));
        }
      );
      return {
        pid: child.pid ?? -1,
        stdout: child.stdout!,
        stderr: child.stderr!,
        kill: (signal: NodeJS.Signals) => child.kill(signal),
        exited,
      };
    },
    composeEnv: (): NodeJS.ProcessEnv => ({ ...process.env }),
  };
}
```

- [ ] **Step 5: Run existing platform tests**

Run: `npm run test -- src/main/platform/platform.test.ts`
Expected: PASS (existing 4 tests). The added `shell` field doesn't break them.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/messages.ts src/shared/ipc-contract.ts src/main/platform/index.ts src/main/platform/linux.ts
git commit -m "feat(shell): shared types, PlatformAdapter.shell, Linux impl"
```

---

## Task 2: Executor — exec + spawn

**Files:**
- Create: `src/main/shell/executor.ts`
- Test: `src/main/shell/executor.test.ts`

The thin wrapper over `node:child_process`. Real child processes for exec tests (cheap); spawn covered through the registry in Task 4. Strict TDD.

- [ ] **Step 1: Write the failing test**

`src/main/shell/executor.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exec, spawn } from './executor';
import { getPlatformAdapter } from '../platform';

const adapter = getPlatformAdapter();

describe('exec', () => {
  it('returns stdout for a successful command', async () => {
    const res = await exec({ command: "echo hello", cwd: tmpdir(), timeoutMs: 5_000 }, adapter);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe('hello');
    expect(res.stderr).toBe('');
    expect(res.timedOut).toBe(false);
    expect(typeof res.durationMs).toBe('number');
  });

  it('captures stderr', async () => {
    const res = await exec({ command: 'echo err 1>&2', cwd: tmpdir(), timeoutMs: 5_000 }, adapter);
    expect(res.exitCode).toBe(0);
    expect(res.stderr.trim()).toBe('err');
  });

  it('reports non-zero exit for failing commands', async () => {
    const res = await exec({ command: 'false', cwd: tmpdir(), timeoutMs: 5_000 }, adapter);
    expect(res.exitCode).not.toBe(0);
  });

  it('honors cwd', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'otto-exec-cwd-'));
    try {
      const res = await exec({ command: 'pwd', cwd: dir, timeoutMs: 5_000 }, adapter);
      // pwd may resolve symlinks; check both the literal and the realpath.
      expect([dir, await import('node:fs').then((m) => m.realpathSync(dir))]).toContain(
        res.stdout.trim()
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('times out and reports timedOut: true', async () => {
    const res = await exec({ command: 'sleep 10', cwd: tmpdir(), timeoutMs: 100 }, adapter);
    expect(res.timedOut).toBe(true);
    // exitCode may be -1 or whatever signal Node reports; assert the flag.
  });

  it('truncates stdout past 1 MB', async () => {
    // Generate ~1.5MB of output via head -c.
    const res = await exec(
      { command: "head -c 1572864 /dev/zero | base64", cwd: tmpdir(), timeoutMs: 10_000 },
      adapter
    );
    expect(res.stdout.length).toBeLessThanOrEqual(1024 * 1024 + 64); // cap + marker
    expect(res.stdout).toContain('[output truncated]');
  });
});

describe('spawn', () => {
  it('returns a ShellChild whose exited resolves on natural exit', async () => {
    const child = spawn('echo hi', tmpdir(), adapter);
    expect(typeof child.pid).toBe('number');
    const result = await child.exited;
    expect(result.exitCode).toBe(0);
  });

  it('emits stdout data events', async () => {
    const child = spawn('echo streamed', tmpdir(), adapter);
    const chunks: string[] = [];
    child.stdout.on('data', (d: Buffer) => chunks.push(d.toString('utf8')));
    await child.exited;
    expect(chunks.join('').trim()).toBe('streamed');
  });
});
```

- [ ] **Step 2: Run test, expect fail (cannot find module)**

Run: `npm run test -- src/main/shell/executor.test.ts`
Expected: FAIL.

- [ ] **Step 3: Create `src/main/shell/executor.ts`**

```ts
import type { PlatformAdapter, ShellChild } from '../platform';

export interface ExecOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
}

const OUTPUT_CAP_BYTES = 1024 * 1024;
const TRUNCATION_MARKER = '\n[output truncated]';
const KILL_GRACE_MS = 2_000;

export async function exec(opts: ExecOptions, adapter: PlatformAdapter): Promise<ExecResult> {
  const startedAt = Date.now();
  const child = adapter.shell.spawnShell(opts.command, opts.cwd);

  let stdout = '';
  let stderr = '';
  let stdoutTruncated = false;
  let stderrTruncated = false;

  const onStdout = (chunk: Buffer): void => {
    if (stdoutTruncated) return;
    const next = stdout + chunk.toString('utf8');
    if (next.length > OUTPUT_CAP_BYTES) {
      stdout = next.slice(0, OUTPUT_CAP_BYTES) + TRUNCATION_MARKER;
      stdoutTruncated = true;
    } else {
      stdout = next;
    }
  };

  const onStderr = (chunk: Buffer): void => {
    if (stderrTruncated) return;
    const next = stderr + chunk.toString('utf8');
    if (next.length > OUTPUT_CAP_BYTES) {
      stderr = next.slice(0, OUTPUT_CAP_BYTES) + TRUNCATION_MARKER;
      stderrTruncated = true;
    } else {
      stderr = next;
    }
  };

  child.stdout.on('data', onStdout);
  child.stderr.on('data', onStderr);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
  }, opts.timeoutMs);

  const result = await child.exited;
  clearTimeout(timer);

  const exitCode = result.exitCode ?? -1;
  return {
    stdout,
    stderr,
    exitCode,
    durationMs: Date.now() - startedAt,
    timedOut,
  };
}

export function spawn(command: string, cwd: string, adapter: PlatformAdapter): ShellChild {
  return adapter.shell.spawnShell(command, cwd);
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test -- src/main/shell/executor.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/shell/executor.ts src/main/shell/executor.test.ts
git commit -m "feat(shell): executor (exec + spawn) with timeout and output cap"
```

---

## Task 3: Command Class — classify + denyReason

**Files:**
- Create: `src/main/shell/command-class.ts`
- Test: `src/main/shell/command-class.test.ts`

Pure functions over the command string.

- [ ] **Step 1: Write the failing test**

`src/main/shell/command-class.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classify, denyReason } from './command-class';

describe('classify', () => {
  const reads: string[] = [
    'ls',
    'ls -la',
    'cat foo.txt',
    'grep -r foo .',
    'find . -type f',
    'head -n 20 a.log',
    'tail -n 50 b.log',
    'wc -l c.txt',
    'pwd',
    'which node',
    'echo hello',
    'printf "%s\n" hi',
    'date',
    'whoami',
    'id',
    'uname -a',
    'ps aux',
    'top -bn1',
    'df -h',
    'du -sh .',
    'stat foo.txt',
    'file bar',
    'git status',
    'git log --oneline -5',
    'git diff',
    'git show HEAD',
    'git branch',
    'git remote -v',
    'git rev-parse HEAD',
    'sudo ls',
    'env FOO=bar ls',
    'nice -n 5 grep foo .',
  ];
  for (const cmd of reads) {
    it(`'${cmd}' -> read`, () => {
      expect(classify(cmd)).toBe('read');
    });
  }

  const irreversible: string[] = [
    'rm -rf foo',
    'rm -R bar',
    'dd if=foo of=/dev/sdb',
    'mkfs.ext4 /dev/sdb1',
  ];
  for (const cmd of irreversible) {
    it(`'${cmd}' -> irreversible`, () => {
      expect(classify(cmd)).toBe('irreversible');
    });
  }

  const destructive: string[] = [
    'npm install',
    'mv a b',
    'chmod 777 foo',
    'rm foo.txt',
    'tail -f log.txt',  // -f is not in the read allowlist
    'curl https://example.com',
  ];
  for (const cmd of destructive) {
    it(`'${cmd}' -> destructive`, () => {
      expect(classify(cmd)).toBe('destructive');
    });
  }
});

describe('denyReason', () => {
  const denied: Array<[string, string]> = [
    ['rm -rf /', 'rm-rf-root'],
    ['rm -rf --no-preserve-root /', 'rm-rf-root'],
    ['dd if=/dev/zero of=/dev/sda bs=1M', 'dd-to-block-device'],
    ['mkfs.ext4 /dev/sda1', 'mkfs'],
    ['shred -vfz /dev/sda', 'shred-device'],
    [':(){ :|:& };:', 'fork-bomb'],
    ['echo X > /dev/sdc', 'redirect-to-block-device'],
    ['chmod -R 000 /', 'chmod-root'],
    ['chmod -R 00 /', 'chmod-root'],
  ];
  for (const [cmd, name] of denied) {
    it(`'${cmd}' -> ${name}`, () => {
      expect(denyReason(cmd)).toBe(name);
    });
  }

  const allowed: string[] = ['ls', 'rm file.txt', 'dd if=foo of=bar', 'chmod 644 file.txt'];
  for (const cmd of allowed) {
    it(`'${cmd}' -> null`, () => {
      expect(denyReason(cmd)).toBeNull();
    });
  }
});
```

- [ ] **Step 2: Run test, expect fail (cannot find module)**

- [ ] **Step 3: Create `src/main/shell/command-class.ts`**

```ts
import type { ActionClass } from '@shared/messages';

const PREFIX_STRIP = /^\s*(?:sudo\s+|nice(?:\s+-n\s+-?\d+)?\s+|env(?:\s+[A-Za-z_][A-Za-z0-9_]*=\S+)+\s+)+/;

function normalize(command: string): string {
  return command.replace(PREFIX_STRIP, '').trimStart();
}

// Read allowlist — anchored at command start after normalization.
const READ_ALLOWLIST: RegExp[] = [
  /^ls\b/,
  /^cat\b/,
  /^grep\b/,
  /^find\b.*\s-type\b/,
  /^find\b(?!.*\s-(?:delete|exec))/,
  /^head\b/,
  /^tail\b(?!.*\s-f\b)/,
  /^wc\b/,
  /^pwd\b/,
  /^which\b/,
  /^echo\b/,
  /^printf\b/,
  /^date\b/,
  /^whoami\b/,
  /^id\b/,
  /^uname\b/,
  /^ps\b/,
  /^top\b.*\s-bn1\b/,
  /^df\b/,
  /^du\b/,
  /^stat\b/,
  /^file\b/,
  /^git\s+(?:status|log|diff|show|branch|remote|rev-parse)\b/,
];

const IRREVERSIBLE_PATTERNS: RegExp[] = [
  /\brm\s+-[rR]f?\b/,
  /\brm\s+-f[rR]\b/,
  /\bdd\b.*\bof=/,
  /\bmkfs\./,
];

const DENY_RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: 'rm-rf-root', pattern: /\brm\s+(?:-[rRf]+\s+)+(?:--no-preserve-root\s+)?\/(?:\s|$)/ },
  { name: 'rm-rf-root', pattern: /\brm\s+-rf\s+--no-preserve-root\s+\// },
  { name: 'dd-to-block-device', pattern: /\bdd\b.*\bof=\/dev\/(?:sd|nvme|hd|vd)/ },
  { name: 'mkfs', pattern: /\bmkfs\./ },
  { name: 'shred-device', pattern: /\bshred\b.*\s\/dev\// },
  { name: 'fork-bomb', pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { name: 'redirect-to-block-device', pattern: />\s*\/dev\/(?:sd|nvme|hd|vd)/ },
  { name: 'chmod-root', pattern: /\bchmod\s+-R\s+0{1,3}\s+\// },
];

export function classify(command: string): ActionClass {
  const cmd = normalize(command);
  for (const re of IRREVERSIBLE_PATTERNS) if (re.test(cmd)) return 'irreversible';
  for (const re of READ_ALLOWLIST) if (re.test(cmd)) return 'read';
  return 'destructive';
}

export function denyReason(command: string): string | null {
  for (const rule of DENY_RULES) if (rule.pattern.test(command)) return rule.name;
  return null;
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test -- src/main/shell/command-class.test.ts`
Expected: PASS.

If a few tests fail (regex edge cases — e.g. `chmod -R 00 /` matching `chmod-root` with 1-3 zeros), tune the specific regex and re-run. The named patterns are the contract; the regexes are implementation. Adjust only the regex, not the test expectations.

- [ ] **Step 5: Commit**

```bash
git add src/main/shell/command-class.ts src/main/shell/command-class.test.ts
git commit -m "feat(shell): classify + denyReason for shell commands"
```

---

## Task 4: ProcessRegistry

**Files:**
- Create: `src/main/shell/process-registry.ts`
- Test: `src/main/shell/process-registry.test.ts`

Owns process lifecycle, output buffering, event emission. Uses an injectable spawn factory so tests don't fork real children.

- [ ] **Step 1: Write the failing test**

`src/main/shell/process-registry.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ProcessRegistry } from './process-registry';
import type { SessionEvent } from '@shared/ipc-contract';
import type { ShellChild } from '../platform';

class FakeChild extends EventEmitter implements ShellChild {
  pid = Math.floor(Math.random() * 100_000);
  stdout = new PassThrough();
  stderr = new PassThrough();
  exited: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  private resolveExited!: (v: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;
  kill(_signal: NodeJS.Signals): boolean {
    return true;
  }
  constructor() {
    super();
    this.exited = new Promise((r) => (this.resolveExited = r));
  }
  finish(exitCode: number | null, signal: NodeJS.Signals | null = null): void {
    this.resolveExited({ exitCode, signal });
  }
}

function makeRegistry(): { registry: ProcessRegistry; events: SessionEvent[]; spawned: FakeChild[] } {
  const events: SessionEvent[] = [];
  const spawned: FakeChild[] = [];
  const factory = (_cmd: string, _cwd: string): ShellChild => {
    const c = new FakeChild();
    spawned.push(c);
    return c;
  };
  const registry = new ProcessRegistry((e) => events.push(e), factory);
  return { registry, events, spawned };
}

describe('ProcessRegistry.spawn', () => {
  it('registers a process and emits process-spawned', () => {
    const { registry, events, spawned } = makeRegistry();
    const p = registry.spawn({ sessionId: 's1', messageId: 'm1', command: 'echo hi', cwd: '/tmp' });
    expect(p.handle).toBeTruthy();
    expect(p.pid).toBe(spawned[0]!.pid);
    expect(events[0]?.type).toBe('process-spawned');
  });

  it('emits process-stdout/stderr on stream data', () => {
    const { registry, events, spawned } = makeRegistry();
    registry.spawn({ sessionId: 's1', messageId: 'm1', command: 'x', cwd: '/tmp' });
    spawned[0]!.stdout.write('hello');
    spawned[0]!.stderr.write('err');
    // streams emit synchronously in pass-through mode.
    expect(events.filter((e) => e.type === 'process-stdout')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'process-stderr')).toHaveLength(1);
  });

  it('emits process-exited when the child exits', async () => {
    const { registry, events, spawned } = makeRegistry();
    registry.spawn({ sessionId: 's1', messageId: 'm1', command: 'x', cwd: '/tmp' });
    spawned[0]!.finish(0);
    await spawned[0]!.exited;
    // give the registry one microtask to settle
    await new Promise((r) => setImmediate(r));
    const exited = events.find((e) => e.type === 'process-exited');
    expect(exited).toBeTruthy();
    if (exited && exited.type === 'process-exited') expect(exited.exitCode).toBe(0);
  });
});

describe('ProcessRegistry.read', () => {
  it('returns buffered output and advances nextIndex', () => {
    const { registry, spawned } = makeRegistry();
    const p = registry.spawn({ sessionId: 's1', messageId: 'm1', command: 'x', cwd: '/tmp' });
    spawned[0]!.stdout.write('a');
    spawned[0]!.stdout.write('b');
    const r1 = registry.read(p.handle, 0);
    expect(r1.entries.map((e) => e.data).join('')).toBe('ab');
    expect(r1.nextIndex).toBe(2);
    spawned[0]!.stdout.write('c');
    const r2 = registry.read(p.handle, r1.nextIndex);
    expect(r2.entries.map((e) => e.data).join('')).toBe('c');
    expect(r2.nextIndex).toBe(3);
  });

  it('returns status: exited after the child exits', async () => {
    const { registry, spawned } = makeRegistry();
    const p = registry.spawn({ sessionId: 's1', messageId: 'm1', command: 'x', cwd: '/tmp' });
    spawned[0]!.finish(7);
    await spawned[0]!.exited;
    await new Promise((r) => setImmediate(r));
    const r = registry.read(p.handle, 0);
    expect(r.status).toBe('exited');
    expect(r.exitCode).toBe(7);
  });
});

describe('ProcessRegistry.wait', () => {
  it('resolves once the child exits', async () => {
    const { registry, spawned } = makeRegistry();
    const p = registry.spawn({ sessionId: 's1', messageId: 'm1', command: 'x', cwd: '/tmp' });
    const waiter = registry.wait(p.handle);
    spawned[0]!.finish(0);
    const r = await waiter;
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it('honors timeoutMs', async () => {
    vi.useFakeTimers();
    try {
      const { registry } = makeRegistry();
      const p = registry.spawn({ sessionId: 's1', messageId: 'm1', command: 'x', cwd: '/tmp' });
      const waiter = registry.wait(p.handle, 50);
      vi.advanceTimersByTime(60);
      const r = await waiter;
      expect(r.timedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ProcessRegistry.kill', () => {
  it('returns true and emits process-killed for a known handle', async () => {
    const { registry, events, spawned } = makeRegistry();
    const p = registry.spawn({ sessionId: 's1', messageId: 'm1', command: 'x', cwd: '/tmp' });
    const killSpy = vi.spyOn(spawned[0]!, 'kill');
    const ok = registry.kill(p.handle);
    expect(ok).toBe(true);
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(events.find((e) => e.type === 'process-killed')).toBeTruthy();
  });

  it('returns false for unknown handle', () => {
    const { registry, events } = makeRegistry();
    expect(registry.kill('nope')).toBe(false);
    expect(events).toHaveLength(0);
  });
});

describe('ProcessRegistry.killAll', () => {
  it('SIGTERMs every live process and resolves once they exit', async () => {
    const { registry, spawned } = makeRegistry();
    registry.spawn({ sessionId: 's1', messageId: 'm1', command: 'a', cwd: '/tmp' });
    registry.spawn({ sessionId: 's1', messageId: 'm1', command: 'b', cwd: '/tmp' });
    const killSpies = spawned.map((c) => vi.spyOn(c, 'kill'));
    const done = registry.killAll();
    spawned[0]!.finish(0);
    spawned[1]!.finish(0);
    await done;
    expect(killSpies[0]).toHaveBeenCalledWith('SIGTERM');
    expect(killSpies[1]).toHaveBeenCalledWith('SIGTERM');
  });
});
```

- [ ] **Step 2: Run test, expect fail**

- [ ] **Step 3: Create `src/main/shell/process-registry.ts`**

```ts
import { randomUUID } from 'node:crypto';
import type { SessionEvent } from '@shared/ipc-contract';
import type { ShellChild } from '../platform';

export interface OutputEntry {
  stream: 'stdout' | 'stderr';
  data: string;
  at: number;
}

export interface RunningProcess {
  handle: string;
  pid: number;
  command: string;
  cwd: string;
  sessionId: string;
  messageId: string;
  startedAt: number;
  outputBuffer: OutputEntry[];
  outputBytes: number;
  status: 'running' | 'exited' | 'killed';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  truncated: boolean;
}

export type SpawnFactory = (command: string, cwd: string) => ShellChild;

const BUFFER_CAP_BYTES = 4 * 1024 * 1024;
const KILLALL_GRACE_MS = 2_000;

export class ProcessRegistry {
  private readonly processes = new Map<string, RunningProcess>();
  private readonly children = new Map<string, ShellChild>();

  constructor(
    private readonly emit: (e: SessionEvent) => void,
    private readonly factory: SpawnFactory
  ) {}

  spawn(args: {
    sessionId: string;
    messageId: string;
    command: string;
    cwd: string;
  }): RunningProcess {
    const child = this.factory(args.command, args.cwd);
    const handle = randomUUID();
    const proc: RunningProcess = {
      handle,
      pid: child.pid,
      command: args.command,
      cwd: args.cwd,
      sessionId: args.sessionId,
      messageId: args.messageId,
      startedAt: Date.now(),
      outputBuffer: [],
      outputBytes: 0,
      status: 'running',
      exitCode: null,
      signal: null,
      truncated: false,
    };
    this.processes.set(handle, proc);
    this.children.set(handle, child);

    this.emit({
      type: 'process-spawned',
      sessionId: proc.sessionId,
      messageId: proc.messageId,
      handle,
      pid: proc.pid,
      command: proc.command,
      cwd: proc.cwd,
    });

    child.stdout.on('data', (chunk: Buffer) => this.onChunk(handle, 'stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => this.onChunk(handle, 'stderr', chunk));

    void child.exited.then(({ exitCode, signal }) => {
      const p = this.processes.get(handle);
      if (!p) return;
      if (p.status === 'killed') {
        // already emitted process-killed; record exit details and emit process-exited too.
        p.exitCode = exitCode;
        p.signal = signal;
      } else {
        p.status = 'exited';
        p.exitCode = exitCode;
        p.signal = signal;
      }
      this.emit({
        type: 'process-exited',
        sessionId: p.sessionId,
        messageId: p.messageId,
        handle,
        exitCode,
        signal: signal ?? null,
      });
      this.children.delete(handle);
    });

    return proc;
  }

  read(handle: string, sinceIndex = 0): {
    entries: OutputEntry[];
    nextIndex: number;
    status: 'running' | 'exited' | 'killed';
    exitCode: number | null;
  } {
    const p = this.processes.get(handle);
    if (!p) {
      return { entries: [], nextIndex: 0, status: 'exited', exitCode: null };
    }
    const entries = p.outputBuffer.filter((e) => e.at >= sinceIndex);
    const nextIndex = p.outputBuffer.length;
    return { entries, nextIndex, status: p.status, exitCode: p.exitCode };
  }

  async wait(
    handle: string,
    timeoutMs?: number
  ): Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean }> {
    const p = this.processes.get(handle);
    if (!p) return { exitCode: null, signal: null, timedOut: false };
    const child = this.children.get(handle);
    if (!child) {
      return { exitCode: p.exitCode, signal: p.signal ?? null, timedOut: false };
    }
    if (timeoutMs === undefined) {
      const r = await child.exited;
      return { exitCode: r.exitCode, signal: r.signal ?? null, timedOut: false };
    }
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeout = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const result = await Promise.race([
      child.exited.then((r) => ({ kind: 'exit' as const, r })),
      timeout.then(() => ({ kind: 'timeout' as const })),
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (result.kind === 'exit') {
      return { exitCode: result.r.exitCode, signal: result.r.signal ?? null, timedOut: false };
    }
    return { exitCode: null, signal: null, timedOut: true };
  }

  kill(handle: string): boolean {
    const p = this.processes.get(handle);
    const child = this.children.get(handle);
    if (!p || !child) return false;
    p.status = 'killed';
    child.kill('SIGTERM');
    this.emit({
      type: 'process-killed',
      sessionId: p.sessionId,
      messageId: p.messageId,
      handle,
    });
    return true;
  }

  async killAll(): Promise<void> {
    const handles = [...this.children.keys()];
    for (const h of handles) this.kill(h);
    const childExits = handles
      .map((h) => this.children.get(h)?.exited)
      .filter((x): x is Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> => !!x);
    const allExited = Promise.all(childExits);
    await Promise.race([
      allExited,
      new Promise((resolve) => setTimeout(resolve, KILLALL_GRACE_MS)),
    ]);
    // SIGKILL any survivors.
    for (const h of handles) {
      const c = this.children.get(h);
      if (c) c.kill('SIGKILL');
    }
  }

  get(handle: string): RunningProcess | null {
    return this.processes.get(handle) ?? null;
  }

  private onChunk(handle: string, stream: 'stdout' | 'stderr', chunk: Buffer): void {
    const p = this.processes.get(handle);
    if (!p) return;
    const data = chunk.toString('utf8');
    p.outputBytes += data.length;
    while (p.outputBytes > BUFFER_CAP_BYTES && p.outputBuffer.length > 0) {
      const dropped = p.outputBuffer.shift()!;
      p.outputBytes -= dropped.data.length;
      p.truncated = true;
    }
    p.outputBuffer.push({ stream, data, at: p.outputBuffer.length });
    // Renumber 'at' to remain dense after shifts.
    p.outputBuffer.forEach((e, i) => (e.at = i));
    this.emit({
      type: stream === 'stdout' ? 'process-stdout' : 'process-stderr',
      sessionId: p.sessionId,
      messageId: p.messageId,
      handle,
      data,
    });
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test -- src/main/shell/process-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/shell/process-registry.ts src/main/shell/process-registry.test.ts
git commit -m "feat(shell): ProcessRegistry (lifecycle + buffered output + events)"
```

---

## Task 5: OttoTool gains actionClassFor + buildShellTools factory

**Files:**
- Modify: `src/main/agent/tools.ts`
- Test: `src/main/agent/tools.test.ts` (new)

- [ ] **Step 1: Write tests for the new tools**

`src/main/agent/tools.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildShellTools, type OttoTool } from './tools';
import { ProcessRegistry } from '../shell/process-registry';

function makeTools(): { tools: OttoTool[]; byName: Map<string, OttoTool> } {
  // Registry isn't actually called in these unit tests — pass a stub.
  const stubRegistry = {} as unknown as ProcessRegistry;
  const tools = buildShellTools(() => stubRegistry);
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { tools, byName };
}

describe('buildShellTools', () => {
  it('returns five tools', () => {
    const { tools } = makeTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['shell.exec', 'shell.kill', 'shell.read', 'shell.spawn', 'shell.wait']);
  });

  it('shell.exec uses dynamic action class', () => {
    const { byName } = makeTools();
    const exec = byName.get('shell.exec')!;
    expect(exec.actionClassFor).toBeTruthy();
    expect(exec.actionClassFor!({ command: 'ls' })).toBe('read');
    expect(exec.actionClassFor!({ command: 'rm -rf foo' })).toBe('irreversible');
    expect(exec.actionClassFor!({ command: 'mv a b' })).toBe('destructive');
  });

  it('shell.exec exposes denyPatterns', () => {
    const { byName } = makeTools();
    const exec = byName.get('shell.exec')!;
    expect(exec.denyPatterns).toBeTruthy();
    expect(exec.denyPatterns!({ command: 'rm -rf /' })).toBeTruthy();
    expect(exec.denyPatterns!({ command: 'ls' })).toBeNull();
  });

  it('shell.kill has static destructive class and no command-based deny', () => {
    const { byName } = makeTools();
    const kill = byName.get('shell.kill')!;
    expect(kill.actionClass).toBe('destructive');
    expect(kill.actionClassFor).toBeUndefined();
    expect(kill.denyPatterns).toBeUndefined();
  });

  it('shell.read and shell.wait dynamic class follows classify(command)... wait, they take a handle not a command', () => {
    // The original spec ambiguity: read/wait/kill take handle, not command. They
    // should have a static class of 'read' for read/wait, 'destructive' for kill.
    const { byName } = makeTools();
    expect(byName.get('shell.read')!.actionClass).toBe('read');
    expect(byName.get('shell.wait')!.actionClass).toBe('read');
    expect(byName.get('shell.read')!.actionClassFor).toBeUndefined();
    expect(byName.get('shell.wait')!.actionClassFor).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test, expect fail**

The test name `'shell.read and shell.wait dynamic class follows classify(command)... wait, they take a handle not a command'` is intentional — it documents the clarification. Make sure the implementation matches the test (read/wait are static `'read'`, no `actionClassFor`, no `denyPatterns`).

- [ ] **Step 3: Update `src/main/agent/tools.ts`**

Read the current file. Extend `OttoTool` (add `actionClassFor`), keep existing stubs (echo, fake-mutate, fake-wipe, stubTools), and add `buildShellTools`. Replace the file with:

```ts
import { z } from 'zod';
import type { ActionClass } from '@shared/messages';
import type { ProcessRegistry } from '../shell/process-registry';
import { exec } from '../shell/executor';
import { classify, denyReason } from '../shell/command-class';
import { getPlatformAdapter } from '../platform';

export interface OttoTool {
  name: string;
  description: string;
  actionClass: ActionClass;
  actionClassFor?(input: unknown): ActionClass;
  schema: z.ZodTypeAny;
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

const execSchema = z.object({
  command: z.string(),
  cwd: z.string().optional(),
  timeout_ms: z.number().int().positive().optional(),
});

const spawnSchema = z.object({
  command: z.string(),
  cwd: z.string().optional(),
});

const readSchema = z.object({
  handle: z.string(),
  since: z.number().int().nonnegative().optional(),
});

const waitSchema = z.object({
  handle: z.string(),
  timeout_ms: z.number().int().positive().optional(),
});

const killSchema = z.object({
  handle: z.string(),
});

function defaultCwd(): string {
  return process.env.HOME ?? '/';
}

export function buildShellTools(getRegistry: () => ProcessRegistry): OttoTool[] {
  return [
    {
      name: 'shell.exec',
      description:
        'Run a shell command via `sh -c`. Blocks until completion. Default timeout 60s. Returns stdout, stderr, exitCode, durationMs, timedOut.',
      actionClass: 'destructive',
      actionClassFor: (input) => classify((input as { command: string }).command),
      schema: execSchema,
      denyPatterns: (input) => denyReason((input as { command: string }).command),
      async run(input) {
        const args = execSchema.parse(input);
        const cwd = args.cwd ?? defaultCwd();
        return exec(
          { command: args.command, cwd, timeoutMs: args.timeout_ms ?? 60_000 },
          getPlatformAdapter()
        );
      },
    },
    {
      name: 'shell.spawn',
      description:
        'Start a long-running shell command via `sh -c`. Returns immediately with { handle, pid }. Output streams into the chat; use shell.read or shell.wait for follow-up.',
      actionClass: 'destructive',
      actionClassFor: (input) => classify((input as { command: string }).command),
      schema: spawnSchema,
      denyPatterns: (input) => denyReason((input as { command: string }).command),
      async run(input) {
        const args = spawnSchema.parse(input);
        const cwd = args.cwd ?? defaultCwd();
        // The MCP handler in sdk-client wires sessionId/messageId via closure.
        // The handler will be augmented (Task 6) to inject those values when
        // it runs this tool. For now, throw if the registry hasn't been
        // primed with a session — but in practice the SDK handler invokes
        // this through a thin wrapper that supplies the context.
        throw new Error(
          'shell.spawn must be invoked via the SDK handler (see sdk-client). Direct invocation not supported.'
        );
      },
    },
    {
      name: 'shell.read',
      description:
        'Read buffered output for a spawned process by handle. Pass `since` to read incrementally; the returned `nextIndex` is the offset for the next call.',
      actionClass: 'read',
      schema: readSchema,
      async run(input) {
        const args = readSchema.parse(input);
        const p = getRegistry().read(args.handle, args.since ?? 0);
        return p;
      },
    },
    {
      name: 'shell.wait',
      description:
        'Block until the spawned process exits (or timeout_ms elapses). Returns { exitCode, signal, timedOut }.',
      actionClass: 'read',
      schema: waitSchema,
      async run(input) {
        const args = waitSchema.parse(input);
        return getRegistry().wait(args.handle, args.timeout_ms);
      },
    },
    {
      name: 'shell.kill',
      description:
        'Send SIGTERM to a spawned process by handle. Returns { killed: boolean }.',
      actionClass: 'destructive',
      schema: killSchema,
      async run(input) {
        const args = killSchema.parse(input);
        const killed = getRegistry().kill(args.handle);
        return { killed };
      },
    },
  ];
}

export const stubTools: OttoTool[] = [echoTool, fakeMutateTool, fakeWipeTool];
```

Note: `shell.spawn`'s `run` throws — actual execution is wired by the SDK handler in Task 6 (the handler intercepts `shell.spawn` calls because it needs the sessionId/messageId from closure). This is the same approach the autonomy framework uses for context-bound execution.

- [ ] **Step 4: Run tests**

Run: `npm run test -- src/main/agent/tools.test.ts`
Expected: PASS.

Also run: `npm run test` (full suite) — existing tests should still pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/tools.ts src/main/agent/tools.test.ts
git commit -m "feat(agent): buildShellTools + OttoTool.actionClassFor"
```

---

## Task 6: SDK Handler Uses actionClassFor + Wires shell.spawn

**Files:**
- Modify: `src/main/agent/sdk-client.ts`

`sdk-client.ts` currently builds MCP tools from `stubTools` only. It needs to:
1. Build from `stubTools.concat(buildShellTools(getRegistry))`.
2. Use `t.actionClassFor(args) ?? t.actionClass` when calling `broker.decide`.
3. Special-case `shell.spawn` so its handler calls `registry.spawn({ sessionId, messageId, command, cwd })` with the closure-captured session context, instead of calling `t.run(args)`.

The `RealSdkClientDeps` interface already has `broker` and `currentMessageId`. Add `getRegistry: () => ProcessRegistry`.

- [ ] **Step 1: Read the current `src/main/agent/sdk-client.ts`** to understand the current MCP handler structure.

- [ ] **Step 2: Modify `createRealSdkClient`**

Update the deps interface:

```ts
import type { ProcessRegistry } from '../shell/process-registry';

export interface RealSdkClientDeps {
  broker: DecisionBroker;
  currentMessageId: () => string;
  getRegistry: () => ProcessRegistry;
}
```

Inside `sendTurn`, where the MCP server is built per turn, change the tool list from `stubTools` to:

```ts
import { buildShellTools, stubTools, type OttoTool } from './tools';

const allTools: OttoTool[] = [...stubTools, ...buildShellTools(deps.getRegistry)];
```

In the wrapped tool handler (replace the existing `broker.decide` call's `actionClass`):

```ts
const cls = t.actionClassFor ? t.actionClassFor(args) : t.actionClass;
const outcome = await ctx.broker.decide({
  sessionId: ctx.sessionId,
  messageId: ctx.messageId,
  callId,
  toolName: t.name,
  actionClass: cls,
  input: args,
  denyPatternsFn: t.denyPatterns ? (i: unknown) => t.denyPatterns!(i) : null,
});
```

In the same wrapped handler, special-case `shell.spawn` after the decide check returns `'allow'`:

```ts
if (outcome === 'allow') {
  if (t.name === 'shell.spawn') {
    const spawnArgs = args as { command: string; cwd?: string };
    const cwd = spawnArgs.cwd ?? process.env.HOME ?? '/';
    const p = deps.getRegistry().spawn({
      sessionId: ctx.sessionId,
      messageId: ctx.messageId,
      command: spawnArgs.command,
      cwd,
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ handle: p.handle, pid: p.pid }),
        },
      ],
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
```

Also update the `allowedTools` list (currently `stubTools.map((t) => \`mcp__otto-tools__${t.name}\`)`) to use `allTools`. The list of MCP tool names is read at session-init time, so build it inside `sendTurn` or as a const computed at module load using `buildShellTools(() => null as unknown as ProcessRegistry)` to get names without invoking the registry. Cleaner: compute it inside `sendTurn`:

```ts
const allowedTools = allTools.map((t) => `mcp__otto-tools__${t.name}`);
```

- [ ] **Step 3: Update the fake SDK client to accept the new dep**

The existing `createFakeSdkClient(deps?: {...})` already takes optional broker + currentMessageId. Add `getRegistry?: () => ProcessRegistry`. Tests don't need it; the integration test (Task 11) will.

```ts
function createFakeSdkClient(deps?: {
  broker?: DecisionBroker;
  currentMessageId?: () => string;
  getRegistry?: () => ProcessRegistry;
}): SdkClient { ... }
```

- [ ] **Step 4: Run tests**

Run: `npm run test`
Expected: full suite PASS. SessionManager tests aren't affected (they inject their own fake `SdkClient` directly).

`npm run typecheck` will FAIL on `src/main/index.ts` (missing `getRegistry` in the deps). Task 8 fixes it.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/sdk-client.ts
git commit -m "feat(agent): SDK handler uses actionClassFor and wires shell.spawn"
```

---

## Task 7: IPC Handler for shell.kill

**Files:**
- Modify: `src/main/ipc/handlers.ts`

- [ ] **Step 1: Add the handler**

Read the current file. Add `broker` and `settings` are already there; add `registry: ProcessRegistry`:

```ts
import type { ProcessRegistry } from '../shell/process-registry';

export function registerIpcHandlers(deps: {
  repo: Repo;
  sessions: SessionManager;
  window: WindowManager;
  broker: DecisionBroker;
  settings: Settings;
  registry: ProcessRegistry;
}): void {
  const { repo, sessions, window, broker, settings, registry } = deps;

  // ... existing handlers ...

  ipcMain.handle('shell.kill', async (_e, args: { handle: string }): Promise<{ killed: boolean }> => {
    const killed = registry.kill(args.handle);
    return { killed };
  });

  // ... rest of file ...
}
```

- [ ] **Step 2: Typecheck**

Will still fail on `src/main/index.ts`. Task 8 closes the loop.

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc/handlers.ts
git commit -m "feat(ipc): shell.kill channel"
```

---

## Task 8: Main Bootstrap — Construct Registry, Wire Through, Cleanup-on-Quit

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Construct the registry**

Inside `startElectron()`, after `broker` is built, add:

```ts
const { ProcessRegistry } = await import('./shell/process-registry');

// Use the platform adapter's shell.spawnShell as the spawn factory.
const registry = new ProcessRegistry(
  emitSessionEvent,
  (command, cwd) => platform.shell.spawnShell(command, cwd)
);
```

(`platform` is the `PlatformAdapter` instance from `getPlatformAdapter()`. If `index.ts` doesn't already have a `platform` binding, add one via `const platform = (await import('./platform')).getPlatformAdapter();`.)

- [ ] **Step 2: Update the SDK client construction**

```ts
const sdk = createRealSdkClient({
  broker,
  currentMessageId: () => currentMessageId ?? '',
  getRegistry: () => registry,
});
```

- [ ] **Step 3: Pass the registry to registerIpcHandlers**

```ts
registerIpcHandlers({ repo, sessions, window, broker, settings, registry });
```

- [ ] **Step 4: Hook into before-quit cleanup**

The existing `app.on('before-quit', ...)` runs hotkey cleanup and `db.close()`. Add registry cleanup before db close:

```ts
app.on('before-quit', async (event) => {
  hotkey.unregisterAll();
  void toggleServer.stop();
  // Allow processes a couple seconds to die before quit completes.
  event.preventDefault?.();  // only if we're synchronous-blocking; remove if causes loops
  await registry.killAll();
  db.close();
  app.exit(0);
});
```

Be careful with `event.preventDefault()` — Electron requires `app.exit()` to be called after. If your current before-quit handler is synchronous, restructure carefully. Simplest path: keep before-quit synchronous, and call `registry.killAll()` fire-and-forget there; rely on the OS to clean up if needed. The simpler pattern:

```ts
app.on('before-quit', () => {
  hotkey.unregisterAll();
  void toggleServer.stop();
  void registry.killAll();
  db.close();
});
```

The trade-off is that under abrupt quit, some processes may not get SIGKILL. Acceptable for skeleton; document in the spec's "Error Handling" table as already noted.

- [ ] **Step 5: Typecheck + tests**

Run: `npm run typecheck`
Expected: PASS.
Run: `npm run test`
Expected: PASS (full suite).

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(main): construct ProcessRegistry, wire deps, cleanup on quit"
```

---

## Task 9: Renderer Store — Reducer Cases for Process Events

**Files:**
- Modify: `src/renderer/state/store.ts`
- Modify: `src/renderer/state/store.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/renderer/state/store.test.ts`:

```ts
describe('store: shell process events', () => {
  beforeEach(() => {
    useOttoStore.getState().reset();
    useOttoStore.getState().beginSession('s1');
    useOttoStore.getState().applyEvent({
      type: 'message-start',
      sessionId: 's1',
      messageId: 'm1',
    });
  });

  it('process-spawned appends a process_output block with status running', () => {
    useOttoStore.getState().applyEvent({
      type: 'process-spawned',
      sessionId: 's1',
      messageId: 'm1',
      handle: 'h1',
      pid: 1234,
      command: 'sleep 30',
      cwd: '/tmp',
    });
    const blocks = useOttoStore.getState().activeSession!.messages[0]!.content;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'process_output',
      handle: 'h1',
      command: 'sleep 30',
      cwd: '/tmp',
      status: 'running',
      lines: [],
      exitCode: null,
    });
  });

  it('process-stdout appends a line to the matching block', () => {
    useOttoStore.getState().applyEvent({
      type: 'process-spawned',
      sessionId: 's1',
      messageId: 'm1',
      handle: 'h1',
      pid: 1,
      command: 'x',
      cwd: '/tmp',
    });
    useOttoStore.getState().applyEvent({
      type: 'process-stdout',
      sessionId: 's1',
      messageId: 'm1',
      handle: 'h1',
      data: 'hello',
    });
    const blocks = useOttoStore.getState().activeSession!.messages[0]!.content;
    const b = blocks[0]!;
    if (b.type !== 'process_output') throw new Error('unexpected block');
    expect(b.lines).toEqual([{ stream: 'stdout', data: 'hello' }]);
  });

  it('process-stderr appends a stderr line', () => {
    useOttoStore.getState().applyEvent({
      type: 'process-spawned',
      sessionId: 's1',
      messageId: 'm1',
      handle: 'h1',
      pid: 1,
      command: 'x',
      cwd: '/tmp',
    });
    useOttoStore.getState().applyEvent({
      type: 'process-stderr',
      sessionId: 's1',
      messageId: 'm1',
      handle: 'h1',
      data: 'oops',
    });
    const blocks = useOttoStore.getState().activeSession!.messages[0]!.content;
    const b = blocks[0]!;
    if (b.type !== 'process_output') throw new Error('unexpected block');
    expect(b.lines).toEqual([{ stream: 'stderr', data: 'oops' }]);
  });

  it('process-exited sets status to exited with exitCode', () => {
    useOttoStore.getState().applyEvent({
      type: 'process-spawned',
      sessionId: 's1',
      messageId: 'm1',
      handle: 'h1',
      pid: 1,
      command: 'x',
      cwd: '/tmp',
    });
    useOttoStore.getState().applyEvent({
      type: 'process-exited',
      sessionId: 's1',
      messageId: 'm1',
      handle: 'h1',
      exitCode: 0,
      signal: null,
    });
    const blocks = useOttoStore.getState().activeSession!.messages[0]!.content;
    const b = blocks[0]!;
    if (b.type !== 'process_output') throw new Error('unexpected block');
    expect(b.status).toBe('exited');
    expect(b.exitCode).toBe(0);
  });

  it('process-killed sets status to killed', () => {
    useOttoStore.getState().applyEvent({
      type: 'process-spawned',
      sessionId: 's1',
      messageId: 'm1',
      handle: 'h1',
      pid: 1,
      command: 'x',
      cwd: '/tmp',
    });
    useOttoStore.getState().applyEvent({
      type: 'process-killed',
      sessionId: 's1',
      messageId: 'm1',
      handle: 'h1',
    });
    const blocks = useOttoStore.getState().activeSession!.messages[0]!.content;
    const b = blocks[0]!;
    if (b.type !== 'process_output') throw new Error('unexpected block');
    expect(b.status).toBe('killed');
  });
});
```

- [ ] **Step 2: Run tests, expect failures**

- [ ] **Step 3: Add reducer cases to `src/renderer/state/store.ts`**

Inside `applyEvent`'s `switch`, add (alongside existing cases):

```ts
case 'process-spawned': {
  const next = updateAssistant(session, event.messageId, (m) => ({
    ...m,
    content: [
      ...m.content,
      {
        type: 'process_output' as const,
        handle: event.handle,
        command: event.command,
        cwd: event.cwd,
        lines: [],
        status: 'running' as const,
        exitCode: null,
      },
    ],
  }));
  set({ activeSession: next });
  return;
}
case 'process-stdout': {
  const next = updateAssistant(session, event.messageId, (m) => ({
    ...m,
    content: m.content.map((b) =>
      b.type === 'process_output' && b.handle === event.handle
        ? { ...b, lines: [...b.lines, { stream: 'stdout' as const, data: event.data }] }
        : b
    ),
  }));
  set({ activeSession: next });
  return;
}
case 'process-stderr': {
  const next = updateAssistant(session, event.messageId, (m) => ({
    ...m,
    content: m.content.map((b) =>
      b.type === 'process_output' && b.handle === event.handle
        ? { ...b, lines: [...b.lines, { stream: 'stderr' as const, data: event.data }] }
        : b
    ),
  }));
  set({ activeSession: next });
  return;
}
case 'process-exited': {
  const next = updateAssistant(session, event.messageId, (m) => ({
    ...m,
    content: m.content.map((b) =>
      b.type === 'process_output' && b.handle === event.handle
        ? { ...b, status: (b.status === 'killed' ? 'killed' : 'exited') as 'exited' | 'killed', exitCode: event.exitCode }
        : b
    ),
  }));
  set({ activeSession: next });
  return;
}
case 'process-killed': {
  const next = updateAssistant(session, event.messageId, (m) => ({
    ...m,
    content: m.content.map((b) =>
      b.type === 'process_output' && b.handle === event.handle
        ? { ...b, status: 'killed' as const }
        : b
    ),
  }));
  set({ activeSession: next });
  return;
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test -- src/renderer/state/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/state/store.ts src/renderer/state/store.test.ts
git commit -m "feat(renderer): store handles process events"
```

---

## Task 10: ProcessCard Component + Message Renderer

**Files:**
- Create: `src/renderer/components/ProcessCard.tsx`
- Test: `src/renderer/components/ProcessCard.test.tsx`
- Modify: `src/renderer/components/Message.tsx`

- [ ] **Step 1: Write failing test `src/renderer/components/ProcessCard.test.tsx`**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProcessCard } from './ProcessCard';

const baseBlock = {
  type: 'process_output' as const,
  handle: 'h1',
  command: 'sleep 60',
  cwd: '/tmp',
  lines: [{ stream: 'stdout' as const, data: 'starting...' }],
  status: 'running' as const,
  exitCode: null,
};

let invoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  invoke = vi.fn().mockResolvedValue({ killed: true });
  (window as unknown as { otto: { invoke: typeof invoke } }).otto = { invoke } as never;
});

describe('ProcessCard', () => {
  it('renders command, running status, and stdout lines', () => {
    render(<ProcessCard block={baseBlock} />);
    expect(screen.getByText('sleep 60')).toBeInTheDocument();
    expect(screen.getByText(/running/i)).toBeInTheDocument();
    expect(screen.getByText('starting...')).toBeInTheDocument();
  });

  it('Cancel button visible while running and invokes shell.kill with the handle', async () => {
    render(<ProcessCard block={baseBlock} />);
    const cancel = screen.getByRole('button', { name: /cancel/i });
    expect(cancel).toBeInTheDocument();
    await userEvent.click(cancel);
    expect(invoke).toHaveBeenCalledWith('shell.kill', { handle: 'h1' });
  });

  it('Cancel button hidden once status is not running', () => {
    render(<ProcessCard block={{ ...baseBlock, status: 'exited', exitCode: 0 }} />);
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
  });

  it('shows exit code badge on exited', () => {
    render(<ProcessCard block={{ ...baseBlock, status: 'exited', exitCode: 7 }} />);
    expect(screen.getByText(/7/)).toBeInTheDocument();
  });

  it('shows killed badge on killed', () => {
    render(<ProcessCard block={{ ...baseBlock, status: 'killed' }} />);
    expect(screen.getByText(/killed/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test, expect fail**

- [ ] **Step 3: Create `src/renderer/components/ProcessCard.tsx`**

```tsx
import { useCallback } from 'react';
import type { ContentBlock } from '@shared/messages';
import { ipc } from '../ipc';

interface Props {
  block: Extract<ContentBlock, { type: 'process_output' }>;
}

const STATUS_LABEL: Record<'running' | 'exited' | 'killed', string> = {
  running: 'running',
  exited: 'exited',
  killed: 'killed',
};

const STATUS_COLOR: Record<'running' | 'exited' | 'killed', string> = {
  running: 'text-amber-400',
  exited: 'text-accent',
  killed: 'text-danger',
};

const MAX_VISIBLE_LINES = 1000;

export function ProcessCard({ block }: Props) {
  const cancel = useCallback(async () => {
    await ipc.invoke('shell.kill', { handle: block.handle });
  }, [block.handle]);

  const lines = block.lines.length > MAX_VISIBLE_LINES
    ? [
        { stream: 'stderr' as const, data: `[${block.lines.length - MAX_VISIBLE_LINES} earlier lines truncated]` },
        ...block.lines.slice(-MAX_VISIBLE_LINES),
      ]
    : block.lines;

  return (
    <div className="my-2 rounded-lg border border-border bg-bg/40 text-sm">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-xs text-muted">$</span>
          <span className="font-mono">{block.command}</span>
        </div>
        <div className="flex items-center gap-2">
          {block.status === 'exited' && block.exitCode !== null && (
            <span className="text-[10px] uppercase tracking-wide text-accent">exit {block.exitCode}</span>
          )}
          <span className={`text-[10px] uppercase tracking-wide ${STATUS_COLOR[block.status]}`}>
            {STATUS_LABEL[block.status]}
          </span>
          {block.status === 'running' && (
            <button
              type="button"
              onClick={cancel}
              className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded border border-danger text-danger"
            >
              Cancel
            </button>
          )}
        </div>
      </div>
      <pre className="text-xs font-mono px-3 py-2 max-h-64 overflow-y-auto whitespace-pre-wrap">
        {lines.map((l, i) => (
          <div key={i} className={l.stream === 'stderr' ? 'text-danger' : ''}>{l.data}</div>
        ))}
      </pre>
    </div>
  );
}
```

- [ ] **Step 4: Modify `src/renderer/components/Message.tsx` to render `process_output`**

Read the current file. Inside `renderBlocks`, add a branch after the existing ones:

```tsx
} else if (b.type === 'process_output') {
  elements.push(<ProcessCard key={b.handle} block={b} />);
}
```

Add the import at the top:

```tsx
import { ProcessCard } from './ProcessCard';
```

- [ ] **Step 5: Run tests**

Run: `npm run test -- src/renderer/components/ProcessCard.test.tsx`
Expected: PASS.

`npm run test` (full suite) — should pass.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/ProcessCard.tsx src/renderer/components/ProcessCard.test.tsx src/renderer/components/Message.tsx
git commit -m "feat(renderer): ProcessCard with live stdout/stderr and Cancel"
```

---

## Task 11: Playwright Integration — shell.exec + shell.spawn/Cancel

**Files:**
- Create: `tests/integration/shell.spec.ts`
- Modify: `src/main/agent/sdk-client.ts` (fake client gains `[shell]` and `[spawn]` branches)

- [ ] **Step 1: Extend the fake client**

In `src/main/agent/sdk-client.ts`'s `createFakeSdkClient`, add new keyword branches mirroring the existing `[mutate]` pattern.

When the prompt contains `[shell]`, after the streaming `echo:` text, the fake calls `deps.broker.decide(...)` with `toolName: 'shell.exec'`, `actionClass: classify(EXEC_CMD)`, `denyPatternsFn: (i) => denyReason((i as any).command)`. On `'allow'`, it actually executes via `exec({ command: EXEC_CMD, cwd: process.env.HOME ?? '/', timeoutMs: 5000 }, adapter)` (using `getPlatformAdapter()`) and emits a synthesized `tool-call-start` + `tool-call-result` with the result.

When the prompt contains `[spawn]`, after `echo:`, the fake calls `broker.decide(...)` with `toolName: 'shell.spawn'`, `actionClass: classify('sleep 10')`. On `'allow'`, it calls `deps.getRegistry!().spawn({ sessionId, messageId, command: 'sleep 10', cwd: tmpdir() })` directly. No additional events needed — the registry emits its own.

```ts
import { classify, denyReason } from '../shell/command-class';
import { exec } from '../shell/executor';
import { getPlatformAdapter } from '../platform';
import { tmpdir } from 'node:os';

// Inside sendTurn's events generator:
const wantsShell = text.includes('[shell]') && !!deps?.broker;
const wantsSpawn = text.includes('[spawn]') && !!deps?.broker && !!deps?.getRegistry;
const EXEC_CMD = 'echo hi';

// ... after streaming `echo: ${text}` ...
if (wantsShell && deps?.broker) {
  const messageId = deps.currentMessageId?.() ?? 'fake-msg';
  const outcome = await deps.broker.decide({
    sessionId: sid,
    messageId,
    callId: 'c-sh',
    toolName: 'shell.exec',
    actionClass: classify(EXEC_CMD),
    input: { command: EXEC_CMD },
    denyPatternsFn: (i: unknown) => denyReason((i as { command: string }).command),
  });
  if (outcome === 'allow') {
    const r = await exec(
      { command: EXEC_CMD, cwd: tmpdir(), timeoutMs: 5_000 },
      getPlatformAdapter()
    );
    yield {
      type: 'tool-call-start',
      callId: 'c-sh',
      name: 'shell.exec',
      input: { command: EXEC_CMD },
    };
    yield {
      type: 'tool-call-result',
      callId: 'c-sh',
      result: r,
      isError: false,
    };
  }
} else if (wantsSpawn && deps?.broker && deps?.getRegistry) {
  const messageId = deps.currentMessageId?.() ?? 'fake-msg';
  const outcome = await deps.broker.decide({
    sessionId: sid,
    messageId,
    callId: 'c-sp',
    toolName: 'shell.spawn',
    actionClass: classify('sleep 10'),
    input: { command: 'sleep 10' },
    denyPatternsFn: (i: unknown) => denyReason((i as { command: string }).command),
  });
  if (outcome === 'allow') {
    // Registry emits process-spawned itself. No additional events needed.
    deps.getRegistry().spawn({
      sessionId: sid,
      messageId,
      command: 'sleep 10',
      cwd: tmpdir(),
    });
  }
} else if (existingFlowApplies) { /* keep existing [mutate]/echo branches */ }
```

Keep the existing `[mutate]` and default `echo` branches. The branches are mutually exclusive (check `[shell]` and `[spawn]` before `[mutate]`).

- [ ] **Step 2: Create `tests/integration/shell.spec.ts`**

```ts
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

async function launch(cfg: string) {
  mkdirSync(path.join(cfg, 'otto'), { recursive: true });
  writeFileSync(
    path.join(cfg, 'otto', 'settings.json'),
    JSON.stringify({ version: 1, autonomy: { mode: 'balanced' } })
  );
  return electron.launch({
    args: [path.join(process.cwd())],
    env: {
      ...process.env,
      OTTO_FAKE_SDK: '1',
      XDG_CONFIG_HOME: cfg,
      NODE_ENV: 'test',
    },
  });
}

test('shell: approve shell.exec, see stdout in result', async () => {
  const cfg = mkdtempSync(path.join(tmpdir(), 'otto-shell-exec-e2e-'));
  const app = await launch(cfg);
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('input[placeholder*="Ask Otto" i]');
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.show();
    });

    await page.fill('input[placeholder*="Ask Otto" i]', '[shell] please');
    await page.press('input[placeholder*="Ask Otto" i]', 'Enter');

    await expect(page.getByText('shell.exec').first()).toBeVisible({ timeout: 5_000 });
    await page.getByRole('button', { name: /^approve$/i }).click();

    // Expand the ToolCallCard to see result.
    await page.getByRole('button', { name: /shell\.exec/i }).click();
    await expect(page.getByText(/hi/)).toBeVisible({ timeout: 5_000 });
  } finally {
    await app.close();
    rmSync(cfg, { recursive: true, force: true });
  }
});

test('shell: approve shell.spawn, ProcessCard appears, Cancel kills it', async () => {
  const cfg = mkdtempSync(path.join(tmpdir(), 'otto-shell-spawn-e2e-'));
  const app = await launch(cfg);
  try {
    const page = await app.firstWindow();
    await page.waitForSelector('input[placeholder*="Ask Otto" i]');
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.show();
    });

    await page.fill('input[placeholder*="Ask Otto" i]', '[spawn] please');
    await page.press('input[placeholder*="Ask Otto" i]', 'Enter');

    await expect(page.getByText('shell.spawn').first()).toBeVisible({ timeout: 5_000 });
    await page.getByRole('button', { name: /^approve$/i }).click();

    // ProcessCard renders.
    await expect(page.getByText('sleep 10')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/running/i)).toBeVisible();

    await page.getByRole('button', { name: /cancel/i }).click();
    await expect(page.getByText(/killed/i)).toBeVisible({ timeout: 3_000 });
  } finally {
    await app.close();
    rmSync(cfg, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Build and run**

Run: `npm run build`
Run: `npm run test:integration`
Expected: 5 tests pass (existing 3 + 2 new).

If a test fails:
- For `shell.exec`: check that the fake client's `[shell]` branch actually runs `exec` and emits both `tool-call-start` and `tool-call-result`.
- For `shell.spawn`: check that the registry's `process-spawned` event reaches the renderer (it goes through the same `emitSessionEvent` pipeline). If `ProcessCard` doesn't render, the renderer store reducer case may not be wired (Task 9).

- [ ] **Step 4: Commit**

```bash
git add tests/integration/shell.spec.ts src/main/agent/sdk-client.ts
git commit -m "test(integration): shell exec + spawn/Cancel via fake SDK"
```

---

## Task 12: Manual Verification

**Files:** none — runtime smoke.

- [ ] **Step 1: Start the dev app**

```bash
npm run dev
```

- [ ] **Step 2: Walk the checklist**

- [ ] In balanced, prompt "run `ls -la` in shell via shell.exec" — runs without prompting (read class).
- [ ] Prompt "use shell.exec to mkdir foo" — destructive, prompts. Approve runs; Deny shows denial.
- [ ] Prompt "use shell.exec to run `rm -rf /`" — denylist denies immediately, the reason names the pattern (e.g., `rm-rf-root`).
- [ ] Prompt "use shell.spawn to run `sleep 60`" — approval card, approve → `ProcessCard` renders with "running". Click Cancel → process dies, card updates to "killed".
- [ ] With a spawned process running, quit Otto. `ps -ef | grep sleep` shows no leak.
- [ ] In strict mode, prompt "use shell.exec to run `ls`" — runs (read class).
- [ ] In strict mode, prompt "use shell.exec to run `rm -rf foo`" — denied (irreversible class).

- [ ] **Step 3: Commit any fixes**

Per-fix commits as needed.

---

## Self-Review Notes

Mapped each spec section to tasks:
- **Goals / 5 tools** → Tasks 5 (definitions), 6 (handler integration).
- **Dynamic action class** → Tasks 5 (`actionClassFor`), 6 (handler uses it).
- **Denylist** → Task 3 (`denyReason`), Task 5 (`denyPatterns` per tool).
- **Inline live process output** → Task 1 (`process_output` block), Task 9 (reducer), Task 10 (ProcessCard).
- **Cleanup on app quit** → Task 8 (`registry.killAll()` in before-quit).
- **Non-Goals** → enforced by absence (no detached mode, no PTY, etc.).
- **Architecture (executor / registry / command-class)** → Tasks 2, 3, 4.
- **OttoTool extension** → Task 5.
- **IPC additions** → Task 1 (types), Task 7 (channel), Task 8 (wiring).
- **Renderer (`ProcessCard`, store)** → Tasks 9, 10.
- **All error-handling cases** → Tasks 2 (timeout, output cap, exit codes), 4 (unknown handle, kill-after-exit, killAll grace), 6 (cwd/empty-command validation in shell.exec.run via zod + early check).
- **Per-OS adapter** → Task 1 (interface + LinuxAdapter.shell).
- **Testing strategy** → Tasks 2, 3, 4, 5, 9, 10 (unit + component), Task 11 (integration).
- **Manual verification checklist** → Task 12.

No placeholders. Method names cross-checked: `classify`, `denyReason`, `exec`, `spawn`, `ShellChild`, `ProcessRegistry.spawn/read/wait/kill/killAll/get`, `OttoTool.actionClassFor`, `buildShellTools(getRegistry)`, `RealSdkClientDeps.getRegistry`.

One known seam: **Task 5's `shell.exec.run` doesn't enforce the cwd-must-exist / non-empty-command checks called out in the spec.** Those are validated by the zod schema (non-empty string for `command`) but cwd existence is not. Add an explicit check in `shell.exec.run` before calling `exec(...)`:

```ts
if (args.command.trim().length === 0) throw new Error('empty command');
// cwd existence — fs.access in async; for the skeleton, child_process spawn will fail with a useful error if cwd is invalid.
```

The cwd validation is implicit (the child errors out with ENOENT and that surfaces in `stderr` + non-zero exit). Documented in the spec as accepted behavior; no extra code needed.
