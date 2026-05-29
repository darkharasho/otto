import type { SdkClient, SdkStreamEvent, SessionStreamHandle, TaggedSdkStreamEvent } from './session';
import { createSessionStream, type QueryFactory } from './session-stream';
import type { SDKMessage, SDKUserMessage, Options, Query } from '@anthropic-ai/claude-agent-sdk';
import {
  buildInputTools, buildKnowledgeTool, buildScreenshotTool, buildShellTools, stubTools,
  buildRecallTool, buildMarkTaskCompleteTool,
  type OttoTool,
} from './tools';
import { exec as execInput, type InputAction } from '../input/executor';
import type { DecisionBroker } from '../autonomy/decision-broker';
import type { ProcessRegistry } from '../shell/process-registry';
import { logger } from '../logger';
import { classify, denyReason } from '../shell/command-class';
import { exec } from '../shell/executor';
import { getPlatformAdapter } from '../platform';
import { capture } from '../screenshot/executor';
import { withSelfHidden } from '../screenshot/self-mask';
import { tileIfNeeded } from '../screenshot/processor';

// Anthropic's many-image request cap is 2000px on either edge. Stay under it
// with margin so a HiDPI capture downscaled exactly to the limit doesn't trip
// the rounding boundary on the server side.
const MAX_SCREENSHOT_EDGE = 1920;
// Hard ceiling on tiles per capture: prevents an absurd capture (e.g., 8000px+
// across, 4+ stacked monitors) from blowing up the per-turn image budget.
const MAX_SCREENSHOT_TILES = 8;
import { save } from '../screenshot/store';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';

interface CallRefs { refs: import('@shared/messages').ContentBlock[]; }
const screenshotRefsByCall = new Map<string, CallRefs>();

export function consumeScreenshotRefs(callId: string): import('@shared/messages').ContentBlock[] | null {
  const entry = screenshotRefsByCall.get(callId);
  if (!entry) return null;
  screenshotRefsByCall.delete(callId);
  return entry.refs;
}

// Test seam: lets session.test.ts seed refs without running the full screenshot path.
export function __setScreenshotRefsForTest(callId: string, refs: import('@shared/messages').ContentBlock[]): void {
  screenshotRefsByCall.set(callId, { refs });
}

/**
 * In packaged builds, the @anthropic-ai/claude-agent-sdk is asarUnpacked so its
 * bundled cli.js can be read by a child process. We also can't rely on a `node`
 * binary being on PATH inside an AppImage/dmg/nsis — instead we spawn Electron
 * itself in node mode (ELECTRON_RUN_AS_NODE=1) and point it at the unpacked
 * cli.js explicitly. In dev (or when the SDK is still in node_modules normally),
 * we let the SDK auto-resolve its own paths and use the ambient `node`.
 */
type SdkSpawnOverrides = {
  // The SDK types only allow "bun" | "deno" | "node" for `executable`, but at
  // runtime it accepts any string and passes it straight to child_process.spawn.
  // Cast through unknown so the Electron binary path is accepted.
  executable: 'node';
  executableArgs: string[];
  pathToClaudeCodeExecutable: string;
  env: NodeJS.ProcessEnv;
};

function getSdkSpawnOverrides(): SdkSpawnOverrides | undefined {
  // Electron sets process.resourcesPath only when packaged. In dev,
  // `process.execPath` is `node`, so leaving overrides off is correct.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) return undefined;
  const unpacked = path.join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    'claude-agent-sdk',
    'cli.js'
  );
  if (!existsSync(unpacked)) {
    logger.warn(`Claude Agent SDK cli.js not found at expected unpacked path: ${unpacked}`);
    return undefined;
  }
  return {
    executable: process.execPath as unknown as 'node',
    executableArgs: [],
    pathToClaudeCodeExecutable: unpacked,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  };
}

// The Agent SDK ships as ESM; loading it via `require()` from the bundled
// CommonJS main process throws ERR_REQUIRE_ESM. Defer to a dynamic import so
// it's only evaluated when a real session actually runs. The fake client
// (OTTO_FAKE_SDK=1) skips the import entirely.
type AgentSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');
let sdkModulePromise: Promise<AgentSdkModule> | null = null;
function loadAgentSdk(): Promise<AgentSdkModule> {
  if (!sdkModulePromise) {
    sdkModulePromise = import('@anthropic-ai/claude-agent-sdk');
  }
  return sdkModulePromise;
}

const SYSTEM_PROMPT = [
  'You are Otto, a desktop coworking agent running on the user\'s Linux machine.',
  '',
  'Available tools:',
  '- shell_exec(command, cwd?, timeout_ms?): run a shell command via `sh -c`, blocking. Returns stdout/stderr/exitCode.',
  '- shell_spawn(command, cwd?): start a long-running command in the background, returns { handle, pid }. Output streams into the chat automatically.',
  '- shell_read(handle, since?): read buffered output for a spawned process.',
  '- shell_wait(handle, timeout_ms?): block until a spawned process exits.',
  '- shell_kill(handle): send SIGTERM to a spawned process.',
  '- screenshot(region?, window?): capture the virtual desktop as a PNG. Default is the full desktop (all monitors stitched); `region` crops by virtual-desktop coords; `window` (name pattern like "Firefox") crops to that window\'s bounds via kdotool — strongly preferred for iteration once a target window is identified, since it\'s much smaller and faster than a full capture. Result includes a `monitors` array with each display\'s {x, y, w, h} and a `tiles` array describing how the image was split.',
  '- get_cursor_position(): return the cursor position {x, y} in virtual-desktop pixels.',
  '- move(x, y): move the cursor to the given monitor-relative position.',
  '- scroll(dx, dy, x?, y?): scroll by (dx, dy); optional (x, y) moves cursor first.',
  '- click(x, y, button?, delay_ms?): left/right/middle click at the position.',
  '- double_click(x, y, button?): double-click at the position.',
  '- drag(x1, y1, x2, y2, button?): drag from start to end.',
  '- type(text, delay_ms?): type literal text into the focused window.',
  '- key(combo, delay_ms?): send a key combo (xdotool-style: "Control+S", "F5", "Return").',
  '- WebSearch(query): search the web; returns titles, urls, and snippets you can cite.',
  '- WebFetch(url, prompt): fetch a URL and extract readable content based on the prompt.',
  '- knowledge_append(note): save a durable fact or preference to Otto\'s memory. Stable preferences are prioritized for inclusion in future prompts. Use sparingly.',
  '- recall(query, kinds?, limit?): search Otto\'s durable memory from prior sessions on this machine. Returns matching facts and structured artifacts (playbooks, anti-patterns, heuristics). Call this at the START of any task that resembles past work before deciding on an approach.',
  '- mark_task_complete(summary): call ONCE when you believe the user\'s request is fully addressed. Triggers a background reflection pass that surfaces a memory-update card in the chat. Do not call between sub-steps.',
  '- echo(msg), fake-mutate(target), fake-wipe(target): test stubs; ignore unless explicitly asked.',
  '',
  'INLINE IMAGES: you can embed images in your responses with `![alt](url)`. Use this only when a visual materially helps the user — a screenshot from a guide, an in-game map, a diagram, a UI reference. Never decorative. The URL must come from a WebSearch/WebFetch result (or another tool that returned an image URL); do not invent URLs. Otto downloads, validates, and caches every image locally before rendering, so dead or non-image URLs fail silently.',
  '',
  'When a screenshot is too large for a single image, it is split into TILES. The meta\'s `tiles` array lists each tile\'s virtual-desktop rect: `[{ index, x, y, w, h }, ...]`, in the same order the image attachments appear. To convert a pixel you see at `(ix, iy)` inside tile N to virtual-desktop coords for clicking: `(tiles[N].x + ix, tiles[N].y + iy)`. The image pixel pitch is always 1:1 with virtual-desktop pixels (no DPR scaling) so no further math is needed. When `tiles.length === 1`, the offset is `(0, 0)` for full-desktop captures and the region/window origin for crops — translation still works the same way.',
  '',
  'GUI workflow — when the user asks you to type, click, or otherwise interact with their screen:',
  '1. Gather context with BOTH shell and vision before acting. Pick the cheapest tool that answers the question:',
  '   - `shell_exec("ps -ef | grep -i firefox | grep -v grep")` to confirm a process is running.',
  '   - `shell_exec("ls ~/Downloads")`, `shell_exec("cat /tmp/something")`, etc. to inspect filesystem state.',
  '   - On KDE Wayland (this machine), `kdotool` answers window questions precisely without vision:',
  '     - `kdotool search --name "<title pattern>"` returns matching window ids.',
  '     - `kdotool getwindowgeometry <id>` returns absolute x/y/w/h in pixels.',
  '     - `kdotool windowactivate <id>` focuses a window before typing into it.',
  '     - `kdotool windowmove <id> <x> <y>` moves a window to a known position.',
  '   - `screenshot` for anything visual — locating buttons inside a window, reading on-screen text, confirming an action.',
  '   Combine signals: e.g., "type into the browser" → `kdotool search --name firefox` + `kdotool windowactivate <id>` to focus it, then `type(...)`.',
  '',
  'CRITICAL focus discipline: when the user has to click "Approve" on an autonomy prompt for an input action, focus moves to Otto\'s window. To prevent typing into Otto:',
  '- Call `shell_exec("kdotool windowactivate <id>")` IMMEDIATELY before EACH `type`/`key`/`click` call, after any approval. Yes — re-activate every single time you fire an input tool.',
  '- Encourage the user to choose "Approve for session" the first time so subsequent input tools don\'t need new approvals (and don\'t steal focus).',
  '2. From the screenshot, note virtual-desktop pixel coordinates (the `monitors` array tells you which display each x/y is on).',
  '3. Click into the target (`click(x, y)`) BEFORE typing. Wait for the post-action delay to settle.',
  '4. Then `type("...")` or send a `key("Control+...")` combo.',
  '5. Take another screenshot to confirm the action landed where you expected. The cursor IS rendered in screenshots (Spectacle -p), so you can SEE where your last click landed relative to the target. If it missed, the cursor position in the new screenshot tells you the exact pixel error — adjust your next click coords by that vector and try again. Pixel estimation from screenshots is imperfect (~10–50px error is normal); use this feedback loop to converge.',
  '',
  'Things NOT to do:',
  '- Do NOT press `Escape` as a recovery action — it will close menus, lose work, or hide Otto itself. Only use Escape when the user explicitly asks.',
  '- Do NOT type or click into windows other than what the user asked for. If you can\'t find the target in the screenshot, say so and ask the user — don\'t guess.',
  '- Do NOT use input tools on Otto\'s own chat panel.',
  '',
  'The autonomy framework gates tool calls by action class. Some commands will pause for user approval before running — proceed normally, the user will see the prompt. Be concise.',
].join('\n');

export interface RealSdkClientDeps {
  broker: DecisionBroker;
  /** Returns the messageId of the assistant message being authored for the current turn. */
  currentMessageId: () => string;
  getRegistry: () => ProcessRegistry;
  getConfigDir: () => string;
  recall(args: {
    query: string;
    kinds?: Array<'fact' | 'playbook' | 'anti_pattern' | 'heuristic'>;
    limit?: number;
  }): Promise<{
    facts: string[];
    artifacts: Array<{
      id: string;
      kind: 'playbook' | 'anti_pattern' | 'heuristic';
      title: string;
      body: string;
      tags: string[];
      updated_at: number;
    }>;
  }>;
  memoryCounts(): { playbook: number; anti_pattern: number; heuristic: number; factsPinned: number; factsTotal: number };
  factsForPrompt(): { markdown: string; ids: string[] };
  bumpFactUse(ids: string[], sessionId: string): void;
  appendKnowledge(note: string, sessionId: string): Promise<void>;
  onMarkTaskComplete(sessionId: string, summary: string): void;
}

interface ToolCtx {
  broker: DecisionBroker;
  sessionId: string;
  // Lazy so the MCP tool callback reads the *current* assistant messageId at
  // invocation time. Capturing it at MCP-server build time was racy: the SDK
  // sometimes fired tools against the initial server (built with a placeholder
  // messageId) before `setMcpServers` swapped in a per-turn closure, so the
  // pending event arrived with a messageId the renderer couldn't match and the
  // ApprovalCard never rendered.
  getMessageId: () => string;
  getRegistry: () => ProcessRegistry;
  getConfigDir: () => string;
  recall: RealSdkClientDeps['recall'];
  factsForPrompt: RealSdkClientDeps['factsForPrompt'];
  bumpFactUse: RealSdkClientDeps['bumpFactUse'];
  appendKnowledge: RealSdkClientDeps['appendKnowledge'];
  onMarkTaskComplete: RealSdkClientDeps['onMarkTaskComplete'];
}

/**
 * Build the in-process MCP server that exposes Otto's stub tools to the SDK.
 *
 * The Agent SDK registers SDK-defined tools via `createSdkMcpServer` + `tool()`,
 * not via a direct `tools` option on `query()`. We wrap each {@link OttoTool}
 * in the SDK's `tool()` helper. The `tool()` factory expects a Zod raw shape
 * (object of zod schemas), so we extract `.shape` from the `z.object(...)`
 * schemas defined in `tools.ts`.
 *
 * Each handler consults the {@link DecisionBroker} before executing so the
 * autonomy policy can allow, prompt, or deny. The MCP server is rebuilt per
 * `sendTurn` so each invocation captures a fresh `{ sessionId, messageId }`
 * closure.
 *
 * NOTE: This uses `as any` in a couple of places to bridge between Otto's
 * generic `OttoTool` interface (`schema: ZodTypeAny`) and the SDK's stricter
 * `AnyZodRawShape`-based generics. The values are correct at runtime; this is
 * purely a TypeScript variance gap.
 */
const INPUT_TOOL_NAMES = new Set([
  'get_cursor_position', 'move', 'scroll', 'click', 'double_click',
  'drag', 'type', 'key',
]);

function toInputAction(name: string, args: unknown): InputAction {
  const a = args as Record<string, unknown>;
  switch (name) {
    case 'get_cursor_position':
      return { kind: 'cursorPosition' };
    case 'move':
      return { kind: 'move', x: a.x as number, y: a.y as number };
    case 'scroll':
      return {
        kind: 'scroll',
        dx: a.dx as number,
        dy: a.dy as number,
        x: a.x as number | undefined,
        y: a.y as number | undefined,
      };
    case 'click':
      return {
        kind: 'click',
        x: a.x as number,
        y: a.y as number,
        button: (a.button as 'left' | 'right' | 'middle') ?? 'left',
      };
    case 'double_click':
      return {
        kind: 'doubleClick',
        x: a.x as number,
        y: a.y as number,
        button: (a.button as 'left' | 'right' | 'middle') ?? 'left',
      };
    case 'drag':
      return {
        kind: 'drag',
        x1: a.x1 as number, y1: a.y1 as number,
        x2: a.x2 as number, y2: a.y2 as number,
        button: (a.button as 'left' | 'right' | 'middle') ?? 'left',
      };
    case 'type':
      return { kind: 'type', text: a.text as string };
    case 'key':
      return { kind: 'key', combo: a.combo as string };
    default:
      throw new Error(`unknown input tool: ${name}`);
  }
}

function buildOttoMcpServer(sdk: AgentSdkModule, ctx: ToolCtx) {
  const { createSdkMcpServer, tool } = sdk;
  const allTools: OttoTool[] = [
    ...stubTools,
    ...buildShellTools(ctx.getRegistry),
    buildScreenshotTool(),
    ...buildInputTools(),
    buildKnowledgeTool(),
    buildRecallTool(),
    buildMarkTaskCompleteTool(),
  ];
  const sdkTools = allTools.map((t) => {
    const shape = (t.schema as unknown as { shape?: Record<string, unknown> }).shape;
    if (!shape) {
      throw new Error(`OttoTool ${t.name} schema must be a z.object(...) so we can pull .shape`);
    }
    return tool(
      t.name,
      t.description,
      shape as Parameters<typeof tool>[2],
      async (args: unknown, _extra: unknown) => {
        const callId =
          (typeof _extra === 'object' && _extra && 'toolUseId' in _extra
            ? String((_extra as { toolUseId?: unknown }).toolUseId ?? '')
            : '') || `${t.name}-${Date.now().toString(36)}`;

        const messageId = ctx.getMessageId();
        const cls = t.actionClassFor ? t.actionClassFor(args) : t.actionClass;
        const outcome = await ctx.broker.decide({
          sessionId: ctx.sessionId,
          messageId,
          callId,
          toolName: t.name,
          actionClass: cls,
          input: args,
          denyPatternsFn: t.denyPatterns ? (i: unknown) => t.denyPatterns!(i) : null,
        });

        if (outcome === 'deny') {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Denied by Otto autonomy policy` }],
          };
        }

        if (t.name === 'shell_spawn') {
          const spawnArgs = args as { command: string; cwd?: string };
          const cwd = spawnArgs.cwd ?? process.env.HOME ?? '/';
          const p = ctx.getRegistry().spawn({
            sessionId: ctx.sessionId,
            messageId,
            command: spawnArgs.command,
            cwd,
          });
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify({ handle: p.handle, pid: p.pid }) },
            ],
          };
        }

        if (INPUT_TOOL_NAMES.has(t.name)) {
          const action = toInputAction(t.name, args);
          const delayMs = (args as { delay_ms?: number }).delay_ms ?? 100;
          const result = await execInput(action, getPlatformAdapter(), delayMs);
          return {
            content: [
              {
                type: 'text' as const,
                text: result === undefined ? 'ok' : JSON.stringify(result),
              },
            ],
          };
        }

        if (t.name === 'knowledge_append') {
          const { note } = args as { note: string };
          await ctx.appendKnowledge(note, ctx.sessionId);
          return { content: [{ type: 'text' as const, text: 'noted' }] };
        }

        if (t.name === 'screenshot') {
          const sArgs = args as { region?: { x: number; y: number; w: number; h: number }; window?: string };
          // eslint-disable-next-line no-console
          console.log('[otto/screenshot] tool input:', JSON.stringify(args));
          const captured = await withSelfHidden(() => capture(sArgs, getPlatformAdapter()));
          // eslint-disable-next-line no-console
          console.log('[otto/screenshot] captured:', captured.width, 'x', captured.height);
          const tiled = await tileIfNeeded(captured.bytes, MAX_SCREENSHOT_EDGE, MAX_SCREENSHOT_TILES);
          const savedPath = await save(captured.bytes, ctx.sessionId, ctx.getConfigDir());
          // Capture refs in the call map so session.ts can rewrite the published event.
          // Filename stem == id; derive from savedPath so disk + ref agree.
          const baseId = savedPath.split('/').pop()!.replace(/\.png$/, '');
          const refs: import('@shared/messages').ContentBlock[] = tiled.tiles.map(() => ({
            type: 'image-ref' as const,
            id: baseId,
            sessionId: ctx.sessionId,
            path: savedPath,
            width: captured.width,
            height: captured.height,
            mimeType: 'image/png' as const,
            source: 'screenshot' as const,
          }));
          screenshotRefsByCall.set(callId, { refs });
          // Bytes for the current turn's API call (transient — released after yield).
          const tilesForApi = tiled.tiles.map((tile) => ({
            type: 'image' as const,
            data: tile.bytes.toString('base64'),
            mimeType: 'image/png' as const,
          }));
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
          return {
            content: [
              ...tilesForApi,
              { type: 'text' as const, text: JSON.stringify(meta) },
            ],
          };
        }

        if (t.name === 'recall') {
          const out = await ctx.recall(args as { query: string; kinds?: Array<'fact' | 'playbook' | 'anti_pattern' | 'heuristic'>; limit?: number });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(out) }],
          };
        }

        if (t.name === 'mark_task_complete') {
          const { summary } = args as { summary: string };
          ctx.onMarkTaskComplete(ctx.sessionId, summary);
          return { content: [{ type: 'text' as const, text: 'noted' }] };
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

function createFakeSdkClient(deps?: {
  broker?: DecisionBroker;
  currentMessageId?: () => string;
  getRegistry?: () => ProcessRegistry;
  getConfigDir?: () => string;
  recall?: RealSdkClientDeps['recall'];
  memoryCounts?: RealSdkClientDeps['memoryCounts'];
  factsForPrompt?: RealSdkClientDeps['factsForPrompt'];
  bumpFactUse?: RealSdkClientDeps['bumpFactUse'];
  appendKnowledge?: RealSdkClientDeps['appendKnowledge'];
  onMarkTaskComplete?: RealSdkClientDeps['onMarkTaskComplete'];
}): SdkClient {
  let counter = 0;
  return {
    async startSession() {
      counter += 1;
      return { id: `fake-${counter}` };
    },
    openStream(sid, _resumeId, hooks): SessionStreamHandle {
      const fakeSdkId = `fake-sdk-${(counter += 1)}`;
      const abortController = new AbortController();
      type Enqueued = { messageId: string; text: string; attachments: Array<Extract<import('@shared/messages').ContentBlock, { type: 'image-ref' }>> };
      const inbox: Enqueued[] = [];
      const waiters: Array<(item: Enqueued | null) => void> = [];
      let closed = false;
      let firstTurn = true;
      function pumpNext(): Promise<Enqueued | null> {
        if (inbox.length > 0) return Promise.resolve(inbox.shift()!);
        if (closed) return Promise.resolve(null);
        return new Promise((resolve) => {
          waiters.push(resolve);
        });
      }
      function enqueue(m: Enqueued): void {
        if (closed) return;
        const w = waiters.shift();
        if (w) w(m);
        else inbox.push(m);
      }
      function closeAll(): void {
        closed = true;
        while (waiters.length > 0) waiters.shift()!(null);
      }
      async function* turnEvents(text: string, signal: AbortSignal): AsyncIterable<SdkStreamEvent> {
      const wantsShell = text.includes('[shell]') && !!deps?.broker;
      const wantsSpawn = text.includes('[spawn]') && !!deps?.broker && !!deps?.getRegistry;
      const wantsMutate = text.includes('[mutate]') && !!deps?.broker;
      const wantsScreenshot = text.includes('[screenshot]') && !!deps?.broker;
        if (firstTurn) {
          yield { type: 'session-id', id: fakeSdkId };
          firstTurn = false;
        }
        for (const ch of `echo: ${text}`) {
          if (signal.aborted) return;
          yield { type: 'text-delta', text: ch };
          await new Promise((r) => setTimeout(r, 5));
        }
        if (wantsShell && deps?.broker) {
          const messageId = deps.currentMessageId?.() ?? 'fake-msg';
          // Use sh -c so the command classifies as 'destructive' (not the
          // read-allowlisted bare `echo`), exercising the approval flow.
          const cmd = "sh -c 'echo hi'";
          const outcome = await deps.broker.decide({
            sessionId: sid,
            messageId,
            callId: 'c-sh',
            toolName: 'shell_exec',
            actionClass: classify(cmd),
            input: { command: cmd },
            denyPatternsFn: (i: unknown) => denyReason((i as { command: string }).command),
          });
          if (outcome === 'allow') {
            const r = await exec({ command: cmd, cwd: tmpdir(), timeoutMs: 5_000 }, getPlatformAdapter());
            yield { type: 'tool-call-start', callId: 'c-sh', name: 'shell_exec', input: { command: cmd } };
            yield { type: 'tool-call-result', callId: 'c-sh', result: r, isError: false };
          }
        } else if (wantsSpawn && deps?.broker && deps?.getRegistry) {
          const messageId = deps.currentMessageId?.() ?? 'fake-msg';
          const cmd = 'sleep 10';
          const outcome = await deps.broker.decide({
            sessionId: sid,
            messageId,
            callId: 'c-sp',
            toolName: 'shell_spawn',
            actionClass: classify(cmd),
            input: { command: cmd },
            denyPatternsFn: (i: unknown) => denyReason((i as { command: string }).command),
          });
          if (outcome === 'allow') {
            // Registry emits process-spawned + later process-stdout/exited.
            deps.getRegistry().spawn({
              sessionId: sid,
              messageId,
              command: cmd,
              cwd: tmpdir(),
            });
          }
        } else if (wantsMutate && deps?.broker) {
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
            yield { type: 'tool-call-start', callId: 'c-mut', name: 'fake-mutate', input: { target: 'X' } };
            yield { type: 'tool-call-result', callId: 'c-mut', result: 'Pretended to mutate X', isError: false };
          }
          // On deny: broker already emitted tool-call-denied; nothing more to do.
        } else if (wantsScreenshot && deps?.broker) {
          const messageId = deps.currentMessageId?.() ?? 'fake-msg';
          const outcome = await deps.broker.decide({
            sessionId: sid,
            messageId,
            callId: 'c-ss',
            toolName: 'screenshot',
            actionClass: 'read',
            input: {},
            denyPatternsFn: null,
          });
          if (outcome === 'allow') {
            try {
              const captured = await withSelfHidden(() => capture({}, getPlatformAdapter()));
              const tiled = await tileIfNeeded(captured.bytes, MAX_SCREENSHOT_EDGE, MAX_SCREENSHOT_TILES);
              const savedPath = await save(
                captured.bytes,
                sid,
                deps?.getConfigDir?.() ?? `${process.env.XDG_CONFIG_HOME ?? '/tmp'}/otto`
              );
              const meta = {
                path: savedPath,
                width: captured.width,
                height: captured.height,
                monitors: captured.monitors,
                tiles: tiled.tiles.map((t, index) => ({
                  index,
                  x: captured.origin.x + t.x,
                  y: captured.origin.y + t.y,
                  w: t.w,
                  h: t.h,
                })),
              };
              yield { type: 'tool-call-start', callId: 'c-ss', name: 'screenshot', input: {} };
              yield { type: 'tool-call-result', callId: 'c-ss', result: meta, isError: false };
            } catch (err) {
              yield { type: 'tool-call-start', callId: 'c-ss', name: 'screenshot', input: {} };
              yield {
                type: 'tool-call-result',
                callId: 'c-ss',
                result: { error: err instanceof Error ? err.message : String(err) },
                isError: true,
              };
            }
          }
        } else {
          yield { type: 'tool-call-start', callId: 'c1', name: 'echo', input: { msg: text } };
          yield { type: 'tool-call-result', callId: 'c1', result: text, isError: false };
        }
        yield { type: 'message-end' };
        yield { type: 'done' };
      }

      async function* taggedEvents(): AsyncIterable<TaggedSdkStreamEvent> {
        while (!closed) {
          const next = await pumpNext();
          if (!next) break;
          try { await hooks.onPerMessageContext(next.messageId); } catch (err) {
            logger.warn(`onPerMessageContext threw: ${err instanceof Error ? err.message : err}`);
          }
          for await (const ev of turnEvents(next.text, abortController.signal)) {
            yield { ...ev, messageId: next.messageId } as TaggedSdkStreamEvent;
          }
        }
      }

      return {
        enqueue(args) { enqueue(args); },
        async interrupt() { abortController.abort(); },
        events: taggedEvents,
        close() { abortController.abort(); closeAll(); },
        queueDepth() { return inbox.length; },
      };
    },
  };
}

export function createRealSdkClient(deps: RealSdkClientDeps): SdkClient {
  if (process.env.OTTO_FAKE_SDK === '1') return createFakeSdkClient(deps);
  let sessionCounter = 0;
  // SDK-defined tools registered via MCP appear to the model with the prefix
  // `mcp__<server-name>__<tool-name>`. Whitelist them via `allowedTools` so they
  // don't trigger permission prompts during the skeleton smoke.
  const allToolsForAllow: OttoTool[] = [
    ...stubTools,
    ...buildShellTools(deps.getRegistry),
    buildScreenshotTool(),
    ...buildInputTools(),
    buildKnowledgeTool(),
    buildRecallTool(),
    buildMarkTaskCompleteTool(),
  ];
  const allowedTools = [
    ...allToolsForAllow.map((t) => `mcp__otto-tools__${t.name}`),
    'WebSearch',
    'WebFetch',
  ];

  return {
    async startSession({ resume }) {
      // The real SDK only assigns a session id once the first SDKSystemMessage
      // (`subtype: 'init'`) arrives. We don't have one yet at startSession time,
      // so we return a provisional id; if the caller passes `resume`, we use it
      // verbatim. SessionManager tolerates the id being a placeholder.
      const id = resume ?? `otto-${Date.now().toString(36)}-${(sessionCounter += 1).toString(36)}`;
      logger.info(`sdk session start: ${id}`);
      return { id };
    },

    openStream(sessionId, resumeId, hooks): SessionStreamHandle {
      const abortController = new AbortController();
      const spawnOverrides = getSdkSpawnOverrides();
      const { markdown: knowledge, ids: pinnedIds } = deps.factsForPrompt();
      if (pinnedIds.length > 0) deps.bumpFactUse(pinnedIds, sessionId);
      const memCounts = deps.memoryCounts();
      const memLine = `Memory currently holds ${memCounts.factsPinned} pinned facts (of ${memCounts.factsTotal} learned), ${memCounts.playbook} playbooks, ${memCounts.anti_pattern} anti-patterns, ${memCounts.heuristic} heuristics.`;
      const parts = [SYSTEM_PROMPT, '', '---', memLine];
      if (knowledge.trim().length > 0) {
        parts.push('Known about this machine and user (pinned facts):');
        parts.push(knowledge.trim());
      }
      const systemPrompt = parts.join('\n');

      let sdkModule: AgentSdkModule | null = null;

      const queryFactory: QueryFactory = ({ prompt, options }) => {
        // queryFactory is invoked synchronously by createSessionStream, but we
        // need the dynamic-imported SDK module first. Wrap into an async
        // generator that loads the SDK on first iteration.
        let inner: Query | null = null;
        async function ensureQuery(): Promise<Query> {
          if (inner) return inner;
          sdkModule = await loadAgentSdk();
          const initialMcp = buildOttoMcpServer(sdkModule, {
            broker: deps.broker,
            sessionId,
            getMessageId: deps.currentMessageId,
            getRegistry: deps.getRegistry,
            getConfigDir: deps.getConfigDir,
            recall: deps.recall,
            factsForPrompt: deps.factsForPrompt,
            bumpFactUse: deps.bumpFactUse,
            appendKnowledge: deps.appendKnowledge,
            onMarkTaskComplete: deps.onMarkTaskComplete,
          });
          inner = sdkModule.query({
            prompt: prompt as AsyncIterable<SDKUserMessage>,
            options: {
              ...(options as Options),
              systemPrompt,
              tools: ['WebSearch', 'WebFetch'],
              allowedTools,
              mcpServers: { 'otto-tools': initialMcp },
              abortController,
              ...(resumeId ? { resume: resumeId } : {}),
              ...(spawnOverrides ?? {}),
            },
          }) as Query;
          return inner;
        }

        const wrapped = {
          async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
            const q = await ensureQuery();
            for await (const msg of q) {
              yield msg;
            }
          },
          async interrupt(): Promise<void> {
            const q = await ensureQuery();
            await q.interrupt();
          },
          async setMcpServers(servers: Record<string, unknown>): Promise<unknown> {
            const q = await ensureQuery();
            return q.setMcpServers(servers as Parameters<Query['setMcpServers']>[0]);
          },
        };
        return wrapped as unknown as ReturnType<QueryFactory>;
      };

      const stream = createSessionStream({
        sessionId,
        queryFactory,
        onPerMessageContext: async (messageId: string) => {
          // Update `deps.currentMessageId` (via SessionManager → main/index.ts)
          // so the MCP tool callbacks read the right id at invocation time.
          // We no longer rebuild/swap the MCP server here — the closure reads
          // messageId lazily via deps.currentMessageId, which dodges a race
          // where the SDK fired tools against the pre-swap server.
          try { hooks.onPerMessageContext(messageId); } catch (err) {
            logger.warn(`onPerMessageContext threw: ${err instanceof Error ? err.message : err}`);
          }
        },
      });

      // Adapt the SessionStream into the SessionStreamHandle protocol expected
      // by SessionManager. We re-map raw SDK messages into the fine-grained
      // SdkStreamEvent stream (text-delta, tool-call-start, ...), then tag
      // each event with the active messageId.
      async function* eventsTagged(): AsyncIterable<TaggedSdkStreamEvent> {
        for await (const se of stream.events()) {
          const mapped = mapSdkMessage(se.raw);
          for (const ev of mapped) {
            yield { ...ev, messageId: se.messageId } as TaggedSdkStreamEvent;
          }
          if (se.type === 'result') {
            // End-of-turn marker for this messageId.
            yield { type: 'message-end', messageId: se.messageId };
            yield { type: 'done', messageId: se.messageId };
          }
        }
      }

      return {
        enqueue(args) {
          // Persist attachments via the createSessionStream path (it handles
          // reading bytes off disk and inlining base64).
          stream.enqueueUserMessage(args);
        },
        interrupt: () => stream.interrupt(),
        events: eventsTagged,
        close: () => {
          abortController.abort();
          stream.close();
        },
        queueDepth: () => stream.queueDepth(),
      };
    },
  };
}

/**
 * Map a single {@link SDKMessage} to zero or more {@link SdkStreamEvent}s.
 *
 * The real SDK emits coarse messages (assistant message containing all content
 * blocks for that step, user message containing tool results, etc.) rather
 * than the fine-grained `text-delta` events Otto's session manager expects.
 * For each assistant message we synthesize a single text-delta containing the
 * full text of each text block, then emit tool-call-start events for tool_use
 * blocks. Tool results arrive on subsequent user messages.
 *
 * We accept the rest of the SDK message types (system init, partial stream
 * events, result, status, etc.) but ignore them; they don't map cleanly to the
 * skeleton's event union.
 */
function mapSdkMessage(msg: unknown): SdkStreamEvent[] {
  if (!msg || typeof msg !== 'object') return [];
  const m = msg as { type?: string; subtype?: string; session_id?: unknown };

  if (m.type === 'system' && m.subtype === 'init' && typeof m.session_id === 'string') {
    return [{ type: 'session-id', id: m.session_id }];
  }

  if (m.type === 'assistant') {
    const am = msg as {
      message?: { content?: Array<Record<string, unknown>> };
    };
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
    const um = msg as {
      message?: { content?: Array<Record<string, unknown>> };
    };
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
