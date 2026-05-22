# Otto Shell / Process Adapter — Design

**Date:** 2026-05-22
**Sub-project:** 3 of 6 (Shell)
**Status:** Spec, awaiting user review

## Context

Sub-projects 1 (Skeleton) and 2 (Autonomy) are live. The agent can chat, persist sessions, and the framework gates tool calls by action class (`read | reversible | destructive | irreversible`) with inline approval cards. The only tools so far are stubs (`echo`, `fake-mutate`, `fake-wipe`).

This sub-project ships **real** tools: a Linux shell adapter with five commands. It's the first time the autonomy framework gates something dangerous, and it's the first time the per-OS `PlatformAdapter` does meaningful OS-specific work.

## Goals

Five tools, all running through `sh -c`:

- **`shell.exec`** — `{ command, cwd?, timeout_ms? }` → `{ stdout, stderr, exitCode, durationMs, timedOut }`. Blocks the turn. Default timeout 60 s.
- **`shell.spawn`** — `{ command, cwd? }` → `{ handle, pid }`. Starts a long-running process; output streams as session events into an inline `process_output` content block with a Cancel button.
- **`shell.read`** — `{ handle, since? }` → `{ entries, nextIndex, status, exitCode? }`. Poll output by offset.
- **`shell.wait`** — `{ handle, timeout_ms? }` → `{ exitCode, signal, timedOut }`. Blocks until the spawned process exits.
- **`shell.kill`** — `{ handle }` → `{ killed }`. Sends SIGTERM. Class always `destructive`.

**Dynamic action class.** `OttoTool` gains optional `actionClassFor(input): ActionClass`. The four command-taking shell tools (`exec`, `spawn`, `read`, `wait`) use this. `command-class.ts`'s `classify(command)` maps:

- Allowlist of clearly-read commands (`ls`, `cat`, `grep`, `find -type f`, `head`, `tail` without `-f`, `wc`, `pwd`, `which`, `echo`, `printf`, `date`, `whoami`, `id`, `uname`, `ps`, `top -bn1`, `df`, `du`, `stat`, `file`, `git status|log|diff|show|branch|remote|rev-parse`) → `read`.
- Irreversible patterns (`rm -rf`/`rm -R`, `dd of=`, `mkfs.`) → `irreversible`.
- Default → `destructive`.

`classify` is anchored to the start of the command after a small normalization pass (strip leading `sudo`/`nice`/`env VAR=…` prefixes; the autonomy framework still sees the unstripped command for the deny check). `shell.kill` keeps the static `actionClass: 'destructive'` — there's no command string to classify.

**Denylist** (regex over the full `command`):

- `\brm\s+-rf\s+/` (and `--no-preserve-root /` variant)
- `\bdd\b.*\bof=/dev/(sd|nvme|hd|vd)`
- `\bmkfs\.`
- `\bshred\b.*\s/dev/`
- `:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:` (fork bomb)
- `>\s*/dev/(sd|nvme|hd|vd)`
- `\bchmod\s+-R\s+0?00\s+/`

`denyReason(command)` returns the matched pattern's name (e.g. `"rm-rf-root"`) or null. The shell tools' `denyPatterns(input)` proxies to `denyReason(input.command)`.

**Inline live process output.** New content block kind `process_output { handle, command, cwd, lines: [{ stream, data }], status: 'running' | 'exited' | 'killed', exitCode }`. New session events `process-spawned`, `process-stdout`, `process-stderr`, `process-exited`, `process-killed`. Renderer renders a `ProcessCard` with live tail and a Cancel button.

**Cleanup on app quit.** `registry.killAll()` runs from `app.on('before-quit')`: SIGTERM all live processes; SIGKILL stragglers after 2 s.

## Non-Goals

- Non-Linux adapters (macOS, Windows). Stubbed at the interface level only.
- Process **tree** management — we SIGTERM only the direct child; descendants may leak.
- Pseudo-TTY allocation. No interactive programs.
- Persistent process handles across app restarts.
- Stdin to running processes.
- Per-tool resource limits (`ulimit`, cgroups).
- Per-tool quotas or rate limits.
- User-configurable allowlist/denylist (edit source for v1).
- A `shell` action class as a fifth value — we reuse the existing four.
- Sticky per-session cwd.
- Argv-array form (`{ executable, args[] }`); we go shell-string only.

## Architecture

A new `src/main/shell/` module owns the shell mechanics. Three units:

- **`executor.ts`** — pure-ish low-level `exec(opts, adapter) → Promise<ExecResult>` and `spawn(command, cwd, adapter) → ShellChild`. Thin wrapper over `node:child_process`. No knowledge of sessions or autonomy.
- **`process-registry.ts`** — in-memory `Map<handle, RunningProcess>`. Owns lifecycle, emits session events through a passed-in `emit` callback (the same `emitSessionEvent` everything else uses).
- **`command-class.ts`** — pure `classify(command)` and `denyReason(command)`. All rules are immutable arrays in this file.

`OttoTool` gains `actionClassFor?(input): ActionClass`. The handler in `sdk-client.ts` picks `actionClassFor(args)` when present, else the static `actionClass`. Otherwise the autonomy gate is unchanged.

The `PlatformAdapter` interface gains a `shell` namespace:

```ts
interface PlatformAdapter {
  // ... existing fields ...
  shell: {
    spawnShell(command: string, cwd: string): ShellChild;
    composeEnv(): NodeJS.ProcessEnv;
  };
}
```

`LinuxAdapter` implements it. `executor.ts` consumes the adapter through `getPlatformAdapter()`. Future macOS/Windows adapters fit the same shape.

### Directory Layout

```
src/main/shell/
  executor.ts
  executor.test.ts
  process-registry.ts
  process-registry.test.ts
  command-class.ts
  command-class.test.ts
src/main/agent/tools.ts                  # +5 shell tools, OttoTool.actionClassFor
src/main/agent/sdk-client.ts             # use actionClassFor when present
src/main/ipc/handlers.ts                 # shell.kill IPC channel
src/main/platform/index.ts               # PlatformAdapter.shell interface
src/main/platform/linux.ts               # shell impl
src/main/index.ts                        # registry construction + before-quit cleanup
src/shared/ipc-contract.ts               # +5 SessionEvent variants, shell.kill channel
src/shared/messages.ts                   # process_output ContentBlock
src/renderer/state/store.ts              # reducer for process events
src/renderer/components/ProcessCard.tsx
src/renderer/components/ProcessCard.test.tsx
src/renderer/components/Message.tsx      # render process_output
tests/integration/shell.spec.ts          # exec + spawn/Cancel smoke
```

## Components

### `executor.ts`

```ts
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

export interface ShellChild {
  pid: number;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal: NodeJS.Signals): boolean;
  exited: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
}

export async function exec(opts: ExecOptions, adapter: PlatformAdapter): Promise<ExecResult>;
export function spawn(command: string, cwd: string, adapter: PlatformAdapter): ShellChild;
```

- `exec` caps `stdout` and `stderr` at 1 MB each. Truncation appends `\n[output truncated]` to the offending stream.
- Timeout: SIGTERM then SIGKILL after a 2 s grace window. `timedOut: true` if SIGTERM fired.
- `ExecResult.exitCode` is `-1` on SIGKILL after timeout, otherwise the child's actual exit code.

### `process-registry.ts`

```ts
interface RunningProcess {
  handle: string;       // uuid
  pid: number;
  command: string;
  cwd: string;
  sessionId: string;
  messageId: string;
  startedAt: number;
  outputBuffer: OutputEntry[];
  status: 'running' | 'exited' | 'killed';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

interface OutputEntry {
  stream: 'stdout' | 'stderr';
  data: string;
  at: number;     // index within outputBuffer
}

class ProcessRegistry {
  constructor(emit: (event: SessionEvent) => void, adapter: PlatformAdapter);

  spawn(args: { sessionId: string; messageId: string; command: string; cwd: string }): RunningProcess;
  read(handle: string, sinceIndex?: number): { entries: OutputEntry[]; nextIndex: number; status; exitCode: number | null };
  wait(handle: string, timeoutMs?: number): Promise<{ exitCode: number | null; signal: string | null; timedOut: boolean }>;
  kill(handle: string): boolean;
  killAll(): Promise<void>;     // before-quit cleanup
  get(handle: string): RunningProcess | null;
}
```

- `outputBuffer` is capped at 4 MB total bytes per process. When the cap is exceeded, drop the oldest entries; on the next renderer read, prepend a synthetic `[output truncated]` entry so the UI can mark the gap.
- `kill` records `status: 'killed'` and emits a `process-killed` event in addition to the later `process-exited`. The renderer treats `killed` as the terminal status.
- `killAll` is idempotent and safe to call from `before-quit`.

### `command-class.ts`

```ts
export function classify(command: string): ActionClass;
export function denyReason(command: string): string | null;
```

Rules live as named immutable arrays in this file:

- `READ_ALLOWLIST`: array of `RegExp` anchored at command start (after stripping `sudo`/`nice`/`env …` prefixes).
- `IRREVERSIBLE_PATTERNS`: array of `RegExp`.
- `DENY_RULES`: array of `{ name: string; pattern: RegExp }`.

Order of evaluation in `classify`:
1. If any `IRREVERSIBLE_PATTERNS` matches → `'irreversible'`.
2. If any `READ_ALLOWLIST` matches → `'read'`.
3. Default → `'destructive'`.

`denyReason` scans `DENY_RULES`; returns the first match's `name` or null.

### `OttoTool` extension

```ts
export interface OttoTool {
  name: string;
  description: string;
  actionClass: ActionClass;
  actionClassFor?(input: unknown): ActionClass;
  schema: z.ZodTypeAny;
  denyPatterns?(input: unknown): string | null;
  run(input: unknown): Promise<unknown>;
}
```

In `sdk-client.ts`'s tool wrapper:

```ts
const cls = t.actionClassFor ? t.actionClassFor(args) : t.actionClass;
const outcome = await ctx.broker.decide({ ..., actionClass: cls, ... });
```

### Shell tool definitions

All five live in `src/main/agent/tools.ts`. `shell.exec`, `shell.spawn`, `shell.read`, `shell.wait` use `actionClassFor`; `shell.kill` uses static `actionClass: 'destructive'`. Only the command-taking ones declare `denyPatterns`.

```ts
import { exec, spawn } from '../shell/executor';
import { classify, denyReason } from '../shell/command-class';
import { ProcessRegistry } from '../shell/process-registry';
import { getPlatformAdapter } from '../platform';

// (registry is created in main bootstrap and injected via a getter at registration)

export function buildShellTools(getRegistry: () => ProcessRegistry): OttoTool[] {
  return [
    {
      name: 'shell.exec',
      description: 'Run a shell command (via sh -c). Blocks until completion. Default timeout 60s.',
      actionClass: 'destructive',
      actionClassFor: (input) => classify((input as { command: string }).command),
      schema: z.object({ command: z.string(), cwd: z.string().optional(), timeout_ms: z.number().optional() }),
      denyPatterns: (input) => denyReason((input as { command: string }).command),
      async run(input) {
        const args = this.schema.parse(input) as { command: string; cwd?: string; timeout_ms?: number };
        const result = await exec(
          {
            command: args.command,
            cwd: args.cwd ?? process.env.HOME ?? '/',
            timeoutMs: args.timeout_ms ?? 60_000,
          },
          getPlatformAdapter()
        );
        return result;
      },
    },
    // ... shell.spawn, shell.read, shell.wait, shell.kill ...
  ];
}
```

`shell.spawn` calls `registry.spawn(...)` (which itself calls `executor.spawn`) and returns `{ handle, pid }`. `shell.read` and `shell.wait` look up by handle. `shell.kill` calls `registry.kill(handle)`.

### Renderer

- **New content block** `process_output` (see Section 3 of brainstorm). Persisted in DB as part of the assistant message JSON, same as other tool blocks. Live state (the `lines` array) is built up by reducer cases and effectively snapshotted into the row at `message-end`.
- **`ProcessCard.tsx`** renders the live block:
  - Header: command, status badge (running/exited(code)/killed).
  - Body: scrolling list of last N lines, stream-colored. Auto-scrolls while running unless the user scrolls up.
  - Cancel button visible only while `status === 'running'`. Invokes `shell.kill` IPC.
- **`Message.tsx`** adds a `process_output` branch in its block renderer.
- **Store reducer cases** for the five new session events.

## Data Flow

### `shell.exec`

1. Model calls `shell.exec({ command, cwd?, timeout_ms? })`.
2. MCP handler computes `actionClass = classify(command)`, `denyReason = denyReason(command)`.
3. `broker.decide` runs.
   - Deny (matrix or denylist) → tool returns `{ isError: true, content: "Denied by Otto autonomy policy" }`.
   - Allow (incl. through confirm) → proceed.
4. Handler calls `executor.exec(...)`. Result serialized to the SDK tool-result envelope.
5. Renderer's existing `tool_result` block displays it.

### `shell.spawn` + live output

1. Model calls `shell.spawn({ command, cwd? })`.
2. Broker → decide on `classify(command)`. Approval flow as normal.
3. Handler calls `registry.spawn(...)`.
4. Registry emits `process-spawned` synchronously → renderer pushes a new `process_output` block onto the active assistant message.
5. As stdout/stderr arrive, registry emits `process-stdout`/`process-stderr` → reducer appends `OutputEntry` records into the block's `lines`.
6. On exit, registry emits `process-exited` → reducer marks `status: 'exited'`, sets `exitCode`.
7. Cancel: user clicks → renderer invokes `shell.kill` IPC → registry kills the process → emits `process-killed` then later `process-exited`.

### `shell.read` / `shell.wait`

Synchronous registry lookups. Both classified as `'read'` so they never prompt. Tool returns whatever the registry has at the moment of the call.

### `shell.kill`

Class always `'destructive'`. Calls `registry.kill(handle)`. Returns `{ killed }`.

### App quit

`app.on('before-quit', async () => { await registry.killAll(); /* existing cleanup */ })`. SIGTERM, await with 2 s deadline, SIGKILL survivors.

## Error Handling

| Case | Behavior |
|------|----------|
| `cwd` doesn't exist / not a directory | Tool returns `{ isError: true, content: "cwd not found: <path>" }`. No broker invocation. |
| `command` is empty / whitespace | Tool returns `{ isError: true, content: "empty command" }`. No broker invocation. |
| Denylist hit | Broker emits `tool-call-denied` with the matched pattern name. Tool returns the standard denial envelope. |
| `exec` timeout | SIGTERM → SIGKILL after 2 s. Returns `{ exitCode: -1, timedOut: true, stdout, stderr }`. |
| `exec` output > 1 MB | Truncate; append `\n[output truncated]`. |
| `spawn` child exits before `read`/`wait` | Registry retains exit info; subsequent reads succeed. |
| `read`/`wait`/`kill` with unknown handle | Tool returns `{ isError: true, content: "unknown handle: <h>" }`. Class is `'read'` for `read`/`wait`. |
| User cancels after exit | `shell.kill` returns `{ killed: false }`. Renderer hides the button once `status !== 'running'`. |
| Process leaks grandchildren | Documented limitation. Future work: detached process groups. |
| App quit with live processes | `killAll()` SIGTERMs, SIGKILLs after 2 s. |
| `spawn` fails (ENOENT, EACCES on shell binary) | Tool returns `{ isError: true, content: <errno message> }`. No `process-spawned` event. |
| Stream backpressure | No flow control. Renderer is local; reducer is fast. Each chunk → one event. |
| Renderer crash mid-stream | Main keeps state; on next load the assistant message renders frozen at the last-persisted snapshot. |

**Logging:** registry logs `spawn pid=<p> handle=<h> command=<c>`, `process exited pid=<p> code=<c>`, and `process killed pid=<p> reason=<r>` at info level. Exec timeouts logged at warn.

## Testing

### Unit (Vitest)

- **`executor.test.ts`**:
  - `exec` returns expected `exitCode`/`stdout`/`stderr` for `echo`, redirected stderr, `false`, custom `cwd` (run `pwd`).
  - `exec` times out and SIGKILLs after the 2 s grace; `timedOut: true`.
  - `exec` truncates output past 1 MB; truncation marker present.
  - `spawn`'s `exited` resolves on natural exit.
  - `spawn` stdout/stderr streams emit data.

- **`process-registry.test.ts`** (with a fake `executor.spawn` factory injected to avoid real child processes):
  - `spawn` registers, emits `process-spawned`.
  - stdout/stderr chunks emit events and append to `outputBuffer`.
  - `read(handle, sinceIndex)` returns slices and correct `nextIndex`.
  - `wait` resolves when fake child resolves.
  - `kill(handle)` returns true, emits `process-killed` then `process-exited`.
  - `kill(unknown)` returns false, no events.
  - `killAll` cleans up; survivors get SIGKILL after 2 s.
  - 4 MB output cap drops oldest entries; truncation marker prepended on next read.

- **`command-class.test.ts`**:
  - Allowlist samples → `'read'`: `ls`, `ls -la`, `cat foo.txt`, `grep -r foo .`, `git status`, `pwd`, `which node`, `find . -type f`, `head -n 20 a.log`, `tail -n 50 b.log`, `wc -l c.txt`.
  - Irreversible samples → `'irreversible'`: `rm -rf foo`, `rm -R bar`, `dd if=a of=/dev/sdb`, `mkfs.ext4 /dev/sdb1`.
  - Destructive default: `npm install`, `mv a b`, `chmod 777 foo`.
  - `denyReason` returns names for: `rm -rf /`, `rm -rf --no-preserve-root /`, `dd of=/dev/sda`, `mkfs.ext4 /dev/sda`, `:(){ :|:& };:`, `> /dev/sdc`, `chmod -R 000 /`.
  - `denyReason` returns null for normal commands.

- **`tools.test.ts`** (new file):
  - Each new tool's `schema` parses well-formed args.
  - `shell.exec.actionClassFor({ command: 'ls' })` → `'read'`.
  - `shell.exec.actionClassFor({ command: 'rm -rf foo' })` → `'irreversible'`.
  - `shell.exec.denyPatterns({ command: 'rm -rf /' })` returns the pattern name; null for benign.
  - `shell.kill.actionClass === 'destructive'`.
  - `shell.kill.actionClassFor === undefined` (intentional — no command to classify).

- **Renderer store**: reducer cases for `process-spawned`, `process-stdout`, `process-stderr`, `process-exited`, `process-killed`; line append, status transitions, cap behavior.

### Component (Vitest + RTL)

- **`ProcessCard.test.tsx`**:
  - Renders command, "running" badge, stdout lines.
  - Cancel visible while running; click invokes `shell.kill` IPC with the handle.
  - Cancel disappears once `status !== 'running'`.
  - Exit code badge on exited; "killed" badge on killed.
  - Output cap test: > 1000 lines → "[output truncated]" marker.

### Integration (Playwright)

- **Test 1 — `shell.exec` happy path.** Fake SDK gains a `[shell]` branch that calls `broker.decide` for `actionClass: 'destructive'` with `toolName: 'shell.exec'`. On approve, the fake calls `executor.exec({ command: 'echo hi', cwd: <tmp> })` and emits the real result. Test approves the card, asserts the result block contains `hi`.

- **Test 2 — `shell.spawn` + Cancel.** Fake SDK `[spawn]` branch calls `registry.spawn({ command: 'sleep 30', ... })`. Test approves, asserts a `ProcessCard` with "running" appears, clicks Cancel, asserts status becomes "killed" within 3 s.

### Manual Verification Checklist

- [ ] In balanced, prompt "run `ls -la` in shell" — runs without prompting (read class).
- [ ] Prompt "make a dir foo with mkdir" — destructive, prompts. Approve runs; Deny shows denial.
- [ ] Prompt "rm -rf /" — denied immediately; the reason names the pattern.
- [ ] Prompt "spawn `sleep 60` and tell me the pid" — approval, approve, `ProcessCard` renders "running", click Cancel, becomes "killed".
- [ ] Quit Otto while a spawned process is running; `ps -ef | grep <command>` after quit shows no leak.
- [ ] In strict, even `ls` runs (read class is always allow). `rm -rf foo` (irreversible) is denied.

## Open Questions

None blocking. Known future-deferred items:

- Process-tree kill (kill the child's descendants too).
- Pseudo-TTY allocation for interactive programs.
- User-configurable allowlist/denylist.
- Sticky per-session cwd.
- Stdin to running processes.
