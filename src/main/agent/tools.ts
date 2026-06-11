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
      name: 'shell_exec',
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
      name: 'shell_spawn',
      description:
        'Start a long-running shell command via `sh -c`. Returns immediately with { handle, pid }. Output streams into the chat; use shell.read or shell.wait for follow-up.',
      actionClass: 'destructive',
      actionClassFor: (input) => classify((input as { command: string }).command),
      schema: spawnSchema,
      denyPatterns: (input) => denyReason((input as { command: string }).command),
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
      description: 'Return the current cursor position in virtual-desktop pixels (origin at the top-left of the leftmost display): { x, y }.',
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
      "Search Otto's durable memory from prior sessions on this machine. Returns matching facts (short standalone notes about the machine or user) and structured artifacts (playbooks, anti-patterns, heuristics). Call this at the START of any task that resembles past work — fixing a recurring problem, automating a familiar app, dealing with a known quirk of this machine — before deciding on an approach. Returns empty arrays when nothing matches; that is fine, proceed normally.",
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

export function buildMarkTaskCompleteTool(): OttoTool {
  return {
    name: 'mark_task_complete',
    description:
      "Call this when you believe the user's request is fully addressed and you are about to stop. Provide a one-sentence `summary` of what was accomplished. This triggers Otto's background reflection pass; it does not affect the user-visible chat. Do NOT call between sub-steps of an ongoing task — only at true completion.",
    actionClass: 'read',
    schema: z.object({ summary: z.string().min(1).max(500) }),
    async run(_input) {
      throw new Error('mark_task_complete must be invoked via the SDK handler');
    },
  };
}
