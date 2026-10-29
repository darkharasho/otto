import type { ContentBlock } from '@shared/messages';
import { exec as execInput, type InputAction } from '../input/executor';
import { getPlatformAdapter, type CaptureOptions, type PlatformAdapter } from '../platform';
import { capture } from '../screenshot/executor';
import { withSelfHidden } from '../screenshot/self-mask';
import { tileIfNeeded } from '../screenshot/processor';
import { captureVerifyCrop } from '../screenshot/verify-crop';
import { save } from '../screenshot/store';
import { uiAct, uiTree, type UiOp } from '../a11y';
import type { ActStep } from './tools';

/**
 * Handlers behind the screenshot / act / ui_* tools: everything that turns a
 * capture into an MCP tool result (API-bound JPEG blocks + on-disk image-refs
 * for the renderer), and the batch runner that executes many input steps
 * under a single approval with one observation at the end.
 */

// Tile edge cap for what we send to the model. Smaller = more screenshots fit
// in conversation history before tripping Anthropic's ~32MB request cap.
// 1280 keeps UI text legible while shrinking each tile ~2.3× vs. 1920.
const MAX_SCREENSHOT_EDGE = 1280;
// Hard ceiling on tiles per capture: prevents an absurd capture (e.g., 8000px+
// across, 4+ stacked monitors) from blowing up the per-turn request payload.
const MAX_SCREENSHOT_TILES = 8;
// JPEG quality for API-bound tiles. 70 is the sweet spot for screenshot legibility
// vs. payload size — a typical 1280px tile shrinks ~8× from PNG.
const SCREENSHOT_JPEG_QUALITY = 70;
const DEFAULT_STEP_DELAY_MS = 80;
// Minimum pause after the last step before observing, so the UI has reacted.
const SETTLE_BEFORE_OBSERVE_MS = 150;
const DEFAULT_TREE_NODES = 300;

export type McpBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: 'image/jpeg' };

export interface GuiCtx {
  sessionId: string;
  getConfigDir: () => string;
  /** Record the on-disk refs replacing this call's image blocks (positional). */
  setRefs: (callId: string, refs: ContentBlock[]) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function imageRef(ctx: GuiCtx, savedPath: string, width: number, height: number): ContentBlock {
  // Filename stem == id; derive from savedPath so disk + ref agree.
  const id = savedPath.split(/[\\/]/).pop()!.replace(/\.png$/, '');
  return {
    type: 'image-ref',
    id,
    sessionId: ctx.sessionId,
    path: savedPath,
    width,
    height,
    mimeType: 'image/png',
    source: 'screenshot',
  };
}

/** Full/region/window capture → tiled JPEG blocks + a JSON meta block. */
export async function screenshotContent(
  ctx: GuiCtx,
  callId: string,
  opts: CaptureOptions,
  adapter: PlatformAdapter = getPlatformAdapter()
): Promise<McpBlock[]> {
  const captured = await withSelfHidden(() => capture(opts, adapter), opts.region);
  // Tiles come out as API-ready JPEGs straight from the decoded capture —
  // no PNG re-encode/re-decode per tile.
  const tiled = await tileIfNeeded(captured.bytes, MAX_SCREENSHOT_EDGE, MAX_SCREENSHOT_TILES, {
    image: captured.image,
    jpegQuality: SCREENSHOT_JPEG_QUALITY,
  });
  const savedPath = await save(captured.bytes, ctx.sessionId, ctx.getConfigDir());
  const ref = imageRef(ctx, savedPath, captured.width, captured.height);
  ctx.setRefs(callId, tiled.tiles.map(() => ref));
  const meta = {
    path: savedPath,
    width: captured.width,
    height: captured.height,
    monitors: captured.monitors,
    tiles: tiled.tiles.map((tile, index) => ({
      index,
      x: captured.origin.x + tile.x,
      y: captured.origin.y + tile.y,
      w: tile.w,
      h: tile.h,
    })),
  };
  return [
    ...tiled.tiles.map((tile) => ({
      type: 'image' as const,
      data: tile.bytes.toString('base64'),
      mimeType: 'image/jpeg' as const,
    })),
    { type: 'text' as const, text: JSON.stringify(meta) },
  ];
}

/** Native-res crop around a pointer target, with the crop rect for coordinate correction. */
export async function verifyCropContent(
  ctx: GuiCtx,
  callId: string,
  target: { x: number; y: number },
  extra: Record<string, unknown> = {}
): Promise<McpBlock[]> {
  const crop = await captureVerifyCrop(getPlatformAdapter(), target);
  const savedPath = await save(crop.png, ctx.sessionId, ctx.getConfigDir());
  ctx.setRefs(callId, [imageRef(ctx, savedPath, crop.rect.w, crop.rect.h)]);
  return [
    { type: 'image', data: crop.jpeg.toString('base64'), mimeType: 'image/jpeg' },
    {
      type: 'text',
      text: JSON.stringify({
        ok: true,
        ...extra,
        verify: crop.rect,
        note: 'native-res crop centered on the action endpoint, captured after the action; the rendered cursor shows exactly where it landed',
      }),
    },
  ];
}

/**
 * Pointer actions that commit something get a post-action verification crop
 * centered on their endpoint. Moves/scrolls/keys don't — they're either
 * non-committal or have no meaningful screen anchor.
 */
export function verifyTargetFor(action: InputAction): { x: number; y: number } | null {
  switch (action.kind) {
    case 'click':
    case 'doubleClick':
      return { x: action.x, y: action.y };
    case 'drag':
      return { x: action.x2, y: action.y2 };
    default:
      return null;
  }
}

const SELECT_ALL = process.platform === 'darwin' ? 'cmd+a' : 'ctrl+a';

/**
 * Operate an accessibility element, finishing in the input adapter when the
 * backend can only offer a coordinate click or a focus-then-type fallback.
 */
export async function performUiOp(
  id: string,
  op: UiOp,
  text: string | undefined,
  adapter: PlatformAdapter = getPlatformAdapter()
): Promise<{ method: string; pointer?: { x: number; y: number } }> {
  const r = await uiAct(id, op, text);
  if (r.pointer) {
    await adapter.input.click(r.pointer.x, r.pointer.y, 'left');
    if (op === 'set_text' && text !== undefined) {
      await adapter.input.key(SELECT_ALL);
      await adapter.input.type(text);
      return { method: 'pointer-click+type', pointer: r.pointer };
    }
  } else if (r.method === 'focus-then-type' && text !== undefined) {
    await adapter.input.key(SELECT_ALL);
    await adapter.input.type(text);
  }
  return r;
}

export function stepToInputAction(step: ActStep): InputAction | null {
  switch (step.action) {
    case 'click': return { kind: 'click', x: step.x, y: step.y, button: step.button ?? 'left' };
    case 'double_click': return { kind: 'doubleClick', x: step.x, y: step.y, button: step.button ?? 'left' };
    case 'move': return { kind: 'move', x: step.x, y: step.y };
    case 'scroll': return { kind: 'scroll', dx: step.dx, dy: step.dy, x: step.x, y: step.y };
    case 'drag': return { kind: 'drag', x1: step.x1, y1: step.y1, x2: step.x2, y2: step.y2, button: step.button ?? 'left' };
    case 'type': return { kind: 'type', text: step.text };
    case 'key': return { kind: 'key', combo: step.combo };
    default: return null;
  }
}

export interface ActArgs {
  steps: ActStep[];
  focus?: string;
  observe?: 'none' | 'crop' | 'window' | 'screen' | 'region' | 'tree';
  window?: string;
  region?: { x: number; y: number; w: number; h: number };
  step_delay_ms?: number;
}

export interface StepRunResult {
  completed: number;
  error?: string;
  /** Last place a step put the pointer (for the default crop observation). */
  lastPointer: { x: number; y: number } | null;
  /** Per-step notes worth reporting (element-op methods, cursor reads). */
  notes: string[];
}

/** Execute steps in order; stops at the first failure or cancellation. */
export async function runSteps(
  args: Pick<ActArgs, 'steps' | 'focus' | 'step_delay_ms'>,
  deps: {
    adapter: PlatformAdapter;
    isCancelled: () => boolean;
    uiOp?: typeof performUiOp;
  }
): Promise<StepRunResult> {
  const delay = args.step_delay_ms ?? DEFAULT_STEP_DELAY_MS;
  const uiOp = deps.uiOp ?? performUiOp;
  const out: StepRunResult = { completed: 0, lastPointer: null, notes: [] };
  const activate = async (name: string): Promise<void> => {
    if (!deps.adapter.activateWindow) throw new Error('window focus is not supported on this platform');
    await deps.adapter.activateWindow(name);
  };
  try {
    if (args.focus) {
      await activate(args.focus);
      await sleep(delay);
    }
    for (const [i, step] of args.steps.entries()) {
      if (deps.isCancelled()) {
        out.error = `stopped by user before step ${i + 1}`;
        return out;
      }
      try {
        if (step.action === 'wait') {
          await sleep(step.ms);
        } else if (step.action === 'focus') {
          await activate(step.window);
        } else if (step.action === 'ui') {
          const r = await uiOp(step.id, step.op ?? 'press', step.text, deps.adapter);
          out.notes.push(`step ${i + 1} (${step.id} ${step.op ?? 'press'}): ${r.method}`);
          if (r.pointer) out.lastPointer = r.pointer;
        } else {
          const action = stepToInputAction(step)!;
          await execInput(action, deps.adapter, 0);
          const target = verifyTargetFor(action);
          if (target) out.lastPointer = target;
          else if (action.kind === 'move') out.lastPointer = { x: action.x, y: action.y };
        }
      } catch (err) {
        out.error = `step ${i + 1} (${step.action}) failed: ${err instanceof Error ? err.message : String(err)}`;
        return out;
      }
      out.completed = i + 1;
      if (i < args.steps.length - 1 && step.action !== 'wait') await sleep(delay);
    }
  } catch (err) {
    out.error = `focus "${args.focus}" failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  return out;
}

export async function runAct(
  ctx: GuiCtx,
  callId: string,
  args: ActArgs,
  isCancelled: () => boolean
): Promise<{ content: McpBlock[]; isError: boolean }> {
  const adapter = getPlatformAdapter();
  const result = await runSteps(args, { adapter, isCancelled });
  const summary: Record<string, unknown> = {
    ok: !result.error,
    completed: `${result.completed}/${args.steps.length}`,
    ...(result.error ? { error: result.error } : {}),
    ...(result.notes.length ? { notes: result.notes } : {}),
  };

  // Observe even after a failure: the model needs to see the state it left.
  const observe = args.observe ?? 'crop';
  await sleep(Math.max(args.step_delay_ms ?? DEFAULT_STEP_DELAY_MS, SETTLE_BEFORE_OBSERVE_MS));
  let observation: McpBlock[] = [];
  try {
    if (observe === 'crop' && result.lastPointer) {
      observation = await verifyCropContent(ctx, callId, result.lastPointer);
    } else if (observe === 'screen') {
      observation = await screenshotContent(ctx, callId, {}, adapter);
    } else if (observe === 'window') {
      const win = args.window ?? args.focus;
      if (!win) throw new Error('observe "window" needs `window` (or `focus`)');
      observation = await screenshotContent(ctx, callId, { window: win }, adapter);
    } else if (observe === 'region') {
      if (!args.region) throw new Error('observe "region" needs `region`');
      observation = await screenshotContent(ctx, callId, { region: args.region }, adapter);
    } else if (observe === 'tree') {
      const tree = await uiTree({ window: args.window ?? args.focus, maxNodes: DEFAULT_TREE_NODES });
      observation = [{ type: 'text', text: tree.text }];
    }
  } catch (err) {
    summary.observe_error = err instanceof Error ? err.message : String(err);
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(summary) }, ...observation],
    isError: !!result.error,
  };
}
