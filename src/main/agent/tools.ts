import { z } from 'zod';
import type { ActionClass } from '@shared/messages';
import type { ProcessRegistry } from '../shell/process-registry';
import { exec } from '../shell/executor';
import { classify, denyMatch, type DenyMatch } from '../shell/command-class';
import { getPlatformAdapter } from '../platform';

/** Side-channels a tool run may use while executing (all optional). */
export interface ToolRunIO {
  /** Stream incremental output to the renderer while the call is still running. */
  emitOutput?(stream: 'stdout' | 'stderr', data: string): void;
  /** Publish a partial-result snapshot (observe tool) so the running card fills live. */
  emitSnapshot?(snapshot: unknown): void;
  /** Expose a kill switch for the in-flight call (Stop button on the streaming card). */
  registerKill?(kill: () => void): void;
}

export interface OttoTool {
  name: string;
  description: string;
  actionClass: ActionClass;
  actionClassFor?(input: unknown): ActionClass;
  schema: z.ZodTypeAny;
  denyMatch?(input: unknown): DenyMatch | null;
  run(input: unknown, io?: ToolRunIO): Promise<unknown>;
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
      name: 'shell_exec',
      description:
        'Run a shell command via `sh -c`. Blocks until completion. Default timeout 60s. Returns stdout, stderr, exitCode, durationMs, timedOut.',
      actionClass: 'destructive',
      actionClassFor: (input) => classify((input as { command: string }).command),
      schema: execSchema,
      denyMatch: (input) => denyMatch((input as { command: string }).command),
      async run(input, io) {
        const args = execSchema.parse(input);
        const cwd = args.cwd ?? defaultCwd();
        return exec(
          {
            command: args.command,
            cwd,
            timeoutMs: args.timeout_ms ?? 60_000,
            ...(io?.emitOutput ? { onChunk: io.emitOutput } : {}),
            ...(io?.registerKill
              ? { onSpawn: (proc: { kill: () => void }) => io.registerKill!(proc.kill) }
              : {}),
          },
          getPlatformAdapter()
        );
      },
    },
    {
      name: 'shell_spawn',
      description:
        'Start a long-running shell command via `sh -c`. Returns immediately with { handle, pid }. Output streams into the chat; use shell.read or shell.wait for follow-up.',
      actionClass: 'destructive',
      actionClassFor: (input) => classify((input as { command: string }).command),
      schema: spawnSchema,
      denyMatch: (input) => denyMatch((input as { command: string }).command),
      async run(_input) {
        throw new Error(
          'shell.spawn must be invoked via the SDK handler (see sdk-client). Direct invocation not supported.'
        );
      },
    },
    {
      name: 'shell_read',
      description:
        'Read buffered output for a spawned process by handle. Pass `since` to read incrementally; the returned `nextIndex` is the offset for the next call.',
      actionClass: 'read',
      schema: readSchema,
      async run(input) {
        const args = readSchema.parse(input);
        return getRegistry().read(args.handle, args.since ?? 0);
      },
    },
    {
      name: 'shell_wait',
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
      name: 'shell_kill',
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

export function buildKnowledgeTool(): OttoTool {
  return {
    name: 'knowledge_append',
    description:
      'Save a durable fact or preference to Otto\'s memory. Stable preferences (browser of choice, hardware quirks, always-do rules) get prioritized for inclusion in future system prompts. Use sparingly — one short line per call. Do NOT use for ephemeral task state.',
    actionClass: 'reversible',
    schema: z.object({ note: z.string().min(1) }),
    async run(_input) {
      throw new Error('knowledge_append must be invoked via the SDK handler');
    },
  };
}

export function buildScreenshotTool(): OttoTool {
  return {
    name: 'screenshot',
    description:
      'Capture the entire virtual desktop (all monitors stitched) as a PNG. Returns { path, width, height, monitors: [{id,x,y,w,h,scale}] } so you know where each display lives. Optional `region` crops in virtual-desktop coords. Optional `window` (name pattern, e.g. "Firefox") resolves the matching window via kdotool and crops to its bounds — much faster than a full-desktop capture once a target is known. Pass only one of `region`/`window`. The captured image is attached so the model can see it.',
    actionClass: 'read',
    schema: z.object({
      region: z
        .object({
          x: z.number().int().nonnegative(),
          y: z.number().int().nonnegative(),
          w: z.number().int().positive(),
          h: z.number().int().positive(),
        })
        .optional(),
      window: z.string().min(1).optional(),
    }),
    async run(_input) {
      throw new Error('screenshot must be invoked via the SDK handler');
    },
  };
}

const coord = z.number().int().nonnegative();
const buttonSchema = z.enum(['left', 'right', 'middle']).default('left');
const delayMs = z.number().int().nonnegative().optional();

const cursorPositionSchema = z.object({});
const moveSchema = z.object({ x: coord, y: coord });
const scrollSchema = z.object({
  dx: z.number().int(),
  dy: z.number().int(),
  x: coord.optional(),
  y: coord.optional(),
});
const clickSchema = z.object({ x: coord, y: coord, button: buttonSchema, delay_ms: delayMs });
const doubleClickSchema = z.object({ x: coord, y: coord, button: buttonSchema });
const dragSchema = z.object({
  x1: coord, y1: coord, x2: coord, y2: coord, button: buttonSchema,
});
const typeSchema = z.object({ text: z.string(), delay_ms: delayMs });
const keySchema = z.object({ combo: z.string(), delay_ms: delayMs });

const INPUT_HANDLER_THROW = 'must be invoked via the SDK handler';

export function buildInputTools(): OttoTool[] {
  return [
    {
      name: 'get_cursor_position',
      description: 'Return the current cursor position in virtual-desktop pixels (origin at the top-left of the leftmost display): { x, y }. On Wayland this is where Otto last placed the pointer (the OS does not expose reads); it does not reflect the user physically moving the mouse.',
      actionClass: 'read',
      schema: cursorPositionSchema,
      async run(_input) { throw new Error(`get_cursor_position ${INPUT_HANDLER_THROW}`); },
    },
    {
      name: 'move',
      description: 'Move the cursor to (x, y) in virtual-desktop pixels (origin at the top-left of the leftmost display).',
      actionClass: 'reversible',
      schema: moveSchema,
      async run(_input) { throw new Error(`move ${INPUT_HANDLER_THROW}`); },
    },
    {
      name: 'scroll',
      description: 'Scroll by (dx, dy). Optional (x, y) moves the cursor there first.',
      actionClass: 'reversible',
      schema: scrollSchema,
      async run(_input) { throw new Error(`scroll ${INPUT_HANDLER_THROW}`); },
    },
    {
      name: 'click',
      description: 'Click at (x, y) in virtual-desktop pixels (origin at the top-left of the leftmost display). button: left|right|middle. Optional delay_ms. The result attaches a native-resolution image crop centered on (x, y), captured just after the click with the cursor rendered — inspect it to confirm the click landed and the UI reacted before doing anything else.',
      actionClass: 'destructive',
      schema: clickSchema,
      async run(_input) { throw new Error(`click ${INPUT_HANDLER_THROW}`); },
    },
    {
      name: 'double_click',
      description: 'Double-click at (x, y) in virtual-desktop pixels (origin at the top-left of the leftmost display). The result attaches a native-resolution verification crop centered on (x, y), like click.',
      actionClass: 'destructive',
      schema: doubleClickSchema,
      async run(_input) { throw new Error(`double_click ${INPUT_HANDLER_THROW}`); },
    },
    {
      name: 'drag',
      description: 'Drag from (x1, y1) to (x2, y2) with the given button held down. The result attaches a native-resolution verification crop centered on the endpoint (x2, y2).',
      actionClass: 'destructive',
      schema: dragSchema,
      async run(_input) { throw new Error(`drag ${INPUT_HANDLER_THROW}`); },
    },
    {
      name: 'type',
      description: 'Type literal text into the focused window. Optional delay_ms.',
      actionClass: 'destructive',
      schema: typeSchema,
      async run(_input) { throw new Error(`type ${INPUT_HANDLER_THROW}`); },
    },
    {
      name: 'key',
      description:
        'Send a key combo to the focused window (e.g. "Control+S", "F5", "Return"). xdotool-style naming.',
      actionClass: 'destructive',
      schema: keySchema,
      async run(_input) { throw new Error(`key ${INPUT_HANDLER_THROW}`); },
    },
  ];
}

export function buildRecallTool(): OttoTool {
  return {
    name: 'recall',
    description:
      "Search Otto's durable memory from prior sessions on this machine. Returns matching facts (short standalone notes about the machine or user) and structured artifacts (playbooks, anti-patterns, heuristics). Call this at the START of any task that resembles past work — fixing a recurring problem, automating a familiar app, dealing with a known quirk of this machine — before deciding on an approach. Each hit carries provenance (`learned_at`, `last_used_at`, `times_used`, `sessions_seen`): trust memories reused across many recent sessions; treat old-and-never-reused ones as possibly stale and verify before relying on them. Returns empty arrays when nothing matches; that is fine, proceed normally.",
    actionClass: 'read',
    schema: z.object({
      query: z.string().min(1),
      kinds: z.array(z.enum(['fact', 'playbook', 'anti_pattern', 'heuristic'])).optional(),
      limit: z.number().int().positive().max(20).optional(),
    }),
    async run(_input) {
      throw new Error('recall must be invoked via the SDK handler');
    },
  };
}

export function buildAnnotateTool(): OttoTool {
  return {
    name: 'annotate_result',
    description:
      "Attach a one-line plain-language annotation to the tool call that just finished (or a specific `call_id`). `takeaway` (one sentence, ≤90 chars): the single fact the output revealed — information, not status (\"indexer reading 212 MB/s during the hitch\", not \"command succeeded\"). `why` (failed calls only): why it failed and what you'll do next. The annotation renders inline on that tool's card in the chat. Use it when the output contains a real finding or after a failure; skip routine successes.",
    actionClass: 'read',
    schema: z.object({
      takeaway: z.string().min(1).max(140).optional(),
      why: z.string().min(1).max(240).optional(),
      call_id: z.string().optional(),
    }),
    async run(_input) {
      // The annotation is applied by SessionManager when it observes this
      // call in the event stream; the tool itself has nothing to do.
      return 'noted';
    },
  };
}

export function buildMarkTaskCompleteTool(): OttoTool {
  return {
    name: 'mark_task_complete',
    description:
      "Call this when you believe the user's request is fully addressed and you are about to stop. Provide a one-sentence `summary` of what was accomplished; this triggers Otto's background reflection pass. When the task fixed a concrete problem, ALSO supply the structured fields — they render an outcome card in the chat: `title` (one line, what got fixed), `cause` (what was wrong), `fix` (the exact command or change, shown in mono), `verified` (how you confirmed it worked), `undo_command` (only if the fix is cleanly reversible). Do NOT call between sub-steps of an ongoing task — only at true completion.",
    actionClass: 'read',
    schema: z.object({
      summary: z.string().min(1).max(500),
      title: z.string().min(1).max(80).optional(),
      cause: z.string().min(1).max(140).optional(),
      fix: z.string().min(1).max(200).optional(),
      verified: z.string().min(1).max(140).optional(),
      undo_command: z.string().min(1).max(200).optional(),
    }),
    async run(_input) {
      throw new Error('mark_task_complete must be invoked via the SDK handler');
    },
  };
}

const observeSchema = z.object({
  label: z.string().min(1).max(60),
  command: z.string().min(1),
  unit: z.string().min(1).max(12),
  interval_s: z.number().min(0.5).max(60).optional(),
  duration_s: z.number().min(1).max(1800).optional(),
  threshold: z.number().optional(),
  alert_when: z.enum(['above', 'below']).optional(),
});

/** First finite number anywhere in the sample output. */
function firstNumber(s: string): number | null {
  const m = /-?\d+(?:\.\d+)?/.exec(s);
  if (!m) return null;
  const v = Number.parseFloat(m[0]);
  return Number.isFinite(v) ? v : null;
}

function formatSpan(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Live snapshots are throttled to ≤1/s regardless of sample interval (spec:
// re-render at most 1 fps).
const SNAPSHOT_MIN_GAP_MS = 1_000;

/**
 * Watch a numeric metric over time: run `command` every `interval_s`, read the
 * first number in its stdout, flag threshold crossings, and conclude with a
 * verdict. Blocks for `duration_s`. `deps.exec` is a test seam.
 */
export function buildObserveTool(deps?: { exec?: typeof exec }): OttoTool {
  const runExec = deps?.exec ?? exec;
  return {
    name: 'observe',
    description:
      'Watch a numeric metric over time. Runs `command` every interval_s (default 2s) for duration_s (default 60s, max 1800), reading the FIRST number in its stdout as the sample. `threshold` + `alert_when` (default "above") flag spikes as alert events. The chat shows a live chart while watching; the result carries {series, events, verdict}. A watch never just ends — it concludes with a verdict you should act on. Use it to catch intermittent problems (frame hitches, IO bursts, CPU spikes) instead of eyeballing repeated shell_exec calls.',
    actionClass: 'destructive',
    actionClassFor: (input) => classify((input as { command: string }).command),
    denyMatch: (input) => denyMatch((input as { command: string }).command),
    schema: observeSchema,
    async run(input, io) {
      const args = observeSchema.parse(input);
      const intervalMs = Math.round((args.interval_s ?? 2) * 1000);
      const durationMs = Math.round((args.duration_s ?? 60) * 1000);
      const alertWhen = args.alert_when ?? 'above';
      const startedAt = Date.now();
      const series: number[] = [];
      const events: Array<{ t: number; text: string; level: 'info' | 'alert' }> = [];
      let alerts = 0;
      let inAlert = false; // one alert event per excursion, not per sample
      let failStreak = 0;
      let lastSnapshotAt = 0;

      const base = {
        kind: 'observe' as const,
        label: args.label,
        unit: args.unit,
        startedAt,
        ...(args.threshold !== undefined ? { threshold: args.threshold, alertWhen } : {}),
      };

      while (Date.now() - startedAt < durationMs) {
        const tickStart = Date.now();
        const res = await runExec(
          {
            command: args.command,
            cwd: defaultCwd(),
            timeoutMs: Math.max(1_000, Math.min(intervalMs, 30_000)),
          },
          getPlatformAdapter()
        );
        const value = res.exitCode === 0 ? firstNumber(res.stdout) : null;
        const t = Date.now();
        if (value !== null) {
          failStreak = 0;
          series.push(value);
          const crossed =
            args.threshold !== undefined
            && (alertWhen === 'above' ? value > args.threshold : value < args.threshold);
          if (crossed) {
            alerts += 1;
            if (!inAlert) {
              events.push({
                t,
                text: `${value} ${args.unit} — ${alertWhen === 'above' ? 'over' : 'under'} ${args.threshold} ${args.unit}`,
                level: 'alert',
              });
            }
            inAlert = true;
          } else {
            inAlert = false;
          }
        } else {
          failStreak += 1;
          if (failStreak === 1) {
            events.push({
              t,
              text: res.exitCode !== 0 ? `sample failed (exit ${res.exitCode})` : 'no number in sample output',
              level: 'info',
            });
          }
          // Never produced a single sample after several tries — the command is
          // wrong; bail instead of burning the whole watch window.
          if (failStreak >= 5 && series.length === 0) break;
        }
        if (io?.emitSnapshot && Date.now() - lastSnapshotAt >= SNAPSHOT_MIN_GAP_MS) {
          lastSnapshotAt = Date.now();
          io.emitSnapshot({ ...base, series: [...series], events: [...events] });
        }
        const remaining = durationMs - (Date.now() - startedAt);
        if (remaining <= 0) break;
        const wait = Math.min(Math.max(intervalMs - (Date.now() - tickStart), 0), remaining);
        if (wait > 0) await sleep(wait);
      }

      const endedAt = Date.now();
      const span = formatSpan(endedAt - startedAt);
      let verdict: { ok: boolean; text: string };
      if (series.length === 0) {
        verdict = { ok: false, text: `No data — "${args.command}" produced no numeric output` };
      } else if (args.threshold === undefined) {
        const last = series[series.length - 1]!;
        const peak = alertWhen === 'below' ? Math.min(...series) : Math.max(...series);
        verdict = {
          ok: true,
          text: `Watch ended — ${series.length} samples over ${span} · last ${last} ${args.unit} · peak ${peak} ${args.unit}`,
        };
      } else if (alerts === 0) {
        verdict = {
          ok: true,
          text: `Resolved — 0 of ${series.length} samples ${alertWhen === 'above' ? 'over' : 'under'} ${args.threshold} ${args.unit} in ${span}`,
        };
      } else {
        verdict = {
          ok: false,
          text: `Still occurring — ${alerts} of ${series.length} samples ${alertWhen === 'above' ? 'over' : 'under'} ${args.threshold} ${args.unit} in ${span}`,
        };
      }
      return { ...base, endedAt, series, events, verdict };
    },
  };
}
