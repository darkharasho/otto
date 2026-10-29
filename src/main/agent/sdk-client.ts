import type { SdkClient, SdkStreamEvent, SessionStreamHandle, TaggedSdkStreamEvent } from './session';
import { createSessionStream, type EnqueueKind, type QueryFactory, type SessionStream } from './session-stream';
import type { SDKMessage, SDKUserMessage, Options, Query } from '@anthropic-ai/claude-agent-sdk';
import {
  buildInputTools, buildKnowledgeTool, buildScreenshotTool, buildShellTools, stubTools,
  buildRecallTool, buildMarkTaskCompleteTool, buildAnnotateTool, buildObserveTool,
  buildActTool, buildUiTreeTool, buildUiActTool,
  type OttoTool,
} from './tools';
import {
  performUiOp, runAct, screenshotContent, verifyCropContent, verifyTargetFor,
  type ActArgs, type GuiCtx,
} from './gui-tools';
import { uiTree } from '../a11y';
import type { SessionEvent } from '@shared/ipc-contract';
import { BACKGROUND_MODEL } from '@shared/models';
import { exec as execInput, type InputAction } from '../input/executor';
import type { DecisionBroker } from '../autonomy/decision-broker';
import type { SudoBroker } from '../autonomy/sudo-broker';
import type { ProcessRegistry } from '../shell/process-registry';
import { logger } from '../logger';
import { buildDelegationTools, DELEGATION_TOOL_NAMES, type DelegationManager } from '../peers/delegations';
import { classify, denyMatch } from '../shell/command-class';
import { commandRequiresSudo } from '../shell/sudo-session';
import { exec } from '../shell/executor';
import { getPlatformAdapter } from '../platform';
import { capture } from '../screenshot/executor';
import { withSelfHidden } from '../screenshot/self-mask';
import { tileIfNeeded } from '../screenshot/processor';
import { save } from '../screenshot/store';

// Fake-client screenshot path only; the real tools live in gui-tools.ts.
const MAX_SCREENSHOT_EDGE = 1280;
const MAX_SCREENSHOT_TILES = 8;
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import path from 'node:path';

interface CallRefs { refs: import('@shared/messages').ContentBlock[]; t: number; }
const screenshotRefsByCall = new Map<string, CallRefs>();
// Entries are consumed (and deleted) when session.ts normalizes the matching
// tool result, normally within seconds. If that event never arrives (stream
// error, interrupted turn), the entry would leak forever — sweep stale ones.
const REFS_TTL_MS = 5 * 60_000;

function setScreenshotRefs(callId: string, refs: import('@shared/messages').ContentBlock[]): void {
  const now = Date.now();
  for (const [k, v] of screenshotRefsByCall) {
    if (now - v.t > REFS_TTL_MS) screenshotRefsByCall.delete(k);
  }
  screenshotRefsByCall.set(callId, { refs, t: now });
}

export function consumeScreenshotRefs(callId: string): import('@shared/messages').ContentBlock[] | null {
  const entry = screenshotRefsByCall.get(callId);
  if (!entry) return null;
  screenshotRefsByCall.delete(callId);
  return entry.refs;
}

// Test seam: lets session.test.ts seed refs without running the full screenshot path.
export function __setScreenshotRefsForTest(callId: string, refs: import('@shared/messages').ContentBlock[]): void {
  setScreenshotRefs(callId, refs);
}

// Kill switches for in-flight blocking tool calls (shell_exec). The renderer's
// Stop button resolves here via the `shell.killToolCall` IPC channel; entries
// are registered when the child spawns and removed when the call settles.
const killsByCall = new Map<string, () => void>();

export const DELEGATION_FROM_REMOTE_MSG = "Delegation isn't available for tasks that came from another machine.";

/** Kill the child behind a running tool call. Returns false when the call is unknown or already settled. */
export function killToolCall(callId: string): boolean {
  const kill = killsByCall.get(callId);
  if (!kill) return false;
  kill();
  return true;
}

/**
 * Since SDK 0.3.x the CLI is a native `claude` binary shipped in a per-platform
 * optional package (@anthropic-ai/claude-agent-sdk-<platform>-<arch>), not a
 * cli.js run under node. In packaged builds the SDK would resolve that binary
 * to a path inside app.asar, and child_process.spawn can't traverse an asar
 * archive (spawn ENOTDIR) — so the platform package is asarUnpacked (see
 * electron-builder.yml) and we point the SDK at the real-filesystem copy. The
 * SDK spawns a non-.js pathToClaudeCodeExecutable directly, so no `executable`
 * or env override is needed. In dev the SDK auto-resolves through node_modules.
 */
type SdkSpawnOverrides = {
  pathToClaudeCodeExecutable: string;
};

export function getSdkSpawnOverrides(): SdkSpawnOverrides | undefined {
  // Electron sets process.resourcesPath only when packaged; in dev the SDK's
  // own resolution works, so leaving overrides off is correct.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (!resourcesPath) return undefined;
  const platformPkg = `claude-agent-sdk-${process.platform}-${process.arch}`;
  const binary = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const unpacked = path.join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    platformPkg,
    binary
  );
  if (!existsSync(unpacked)) {
    logger.warn(`Claude Agent SDK native binary not found at expected unpacked path: ${unpacked}`);
    return undefined;
  }
  return { pathToClaudeCodeExecutable: unpacked };
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

function platformName(): string {
  switch (process.platform) {
    case 'darwin': return 'macOS';
    case 'win32': return 'Windows';
    default: return 'Linux';
  }
}

function shellDescription(): string {
  if (process.platform === 'darwin') return 'run a shell command via `zsh -c`, blocking.';
  return 'run a shell command via `sh -c`, blocking.';
}

function screenshotToolDescription(): string {
  if (process.platform === 'darwin') {
    return '- screenshot(region?, window?): capture the virtual desktop as a PNG. Default is the full desktop (all monitors stitched); `region` crops by virtual-desktop coords; `window` (name pattern like "Firefox") resolves the matching window via AppleScript System Events and crops to its bounds — strongly preferred for iteration once a target window is identified, since it\'s much smaller and faster than a full capture. Result includes a `monitors` array with each display\'s {x, y, w, h} and a `tiles` array describing how the image was split.';
  }
  return '- screenshot(region?, window?): capture the virtual desktop as a PNG. Default is the full desktop (all monitors stitched); `region` crops by virtual-desktop coords; `window` (name pattern like "Firefox") crops to that window\'s bounds via kdotool — strongly preferred for iteration once a target window is identified, since it\'s much smaller and faster than a full capture. Result includes a `monitors` array with each display\'s {x, y, w, h} and a `tiles` array describing how the image was split.';
}

function skipTheGuiHints(): string[] {
  if (process.platform === 'darwin') {
    return [
      '   - `osascript` drives most apps directly: `tell application "<App>" to …`, and System Events answers window questions (`get name of every process whose visible is true`).',
      '   - `defaults read/write <domain> <key>` changes most preferences without opening System Settings.',
    ];
  }
  if (process.platform === 'win32') {
    return [
      '   - PowerShell cmdlets and the registry (`Get-ItemProperty`/`Set-ItemProperty HKCU:\\…`) change most settings without opening the Settings app.',
      '   - `Start-Process`, `Stop-Process`, `Get-Process` manage apps; `winget` installs them.',
    ];
  }
  return [
    '   - KDE settings live in config files: `kreadconfig6`/`kwriteconfig6 --file <rc> --group <g> --key <k> <v>`, then reload via D-Bus.',
    '   - D-Bus drives the desktop and many apps: `qdbus` / `gdbus call --session …` (e.g. `qdbus org.kde.KWin /KWin reconfigure`, MPRIS media control, notifications).',
    '   - `kdotool search --name "<title>"`, `getwindowgeometry <id>`, `windowactivate <id>` answer window questions without vision.',
  ];
}

function guiWorkflowSection(): string[] {
  const mod = process.platform === 'darwin' ? 'Cmd' : 'Control';
  return [
    'GUI workflow — every tool call is a full model round trip, so the number of calls IS the speed. Work down this ladder and stop at the first rung that does the job:',
    '1. Skip the GUI. A shell command, config file, CLI or IPC call beats clicking every time:',
    '   - `shell_exec` for process/filesystem state (`ps`, `ls`, `cat`), app CLIs, and settings.',
    ...skipTheGuiHints(),
    '   - Reading a web page? WebFetch the URL instead of screenshotting the browser.',
    '2. Read the UI as text with `ui_tree` (window title/app). It returns every control with role, name, value, state and exact bounds in one cheap call — use it instead of a screenshot to find buttons, read field values, menus, tabs and page text. Operate elements by id with `ui_act` (press/focus/set_text) or `act` steps {action:"ui", id}. Semantic ops do not depend on pixel accuracy at all.',
    '3. Batch. When you know the next several actions, send them as ONE `act` call (e.g. focus window → click field → type → key Return) and pick one observation at the end. Do not issue click → look → type → look as separate calls when the sequence is predictable.',
    '4. Pixels last. Use `screenshot` when ui_tree comes back empty or useless (games, canvas/GPU-drawn UIs, some Electron apps) or when you genuinely need to see the layout. Prefer `window`/`region` captures over the full desktop. If a target is small (<20px) or the capture was tiled/downscaled, take a `region` screenshot first — region crops are native resolution, so your pixel estimate becomes exact.',
    '',
    'Verification — check results, but cheaply:',
    '- click/double_click/drag attach a native-res crop centered on the target, captured right after the action with the cursor rendered, plus a `verify` rect giving the crop\'s virtual-desktop origin. The pointer lands exactly where you ask; if the cursor sits on the wrong element your coordinate estimate was off — convert the right spot from crop pixels via the `verify` rect and retry.',
    '- Pass verify:false (or `act` observe "none") when the outcome is predictable or you will confirm it another way. Use `act` observe "tree" to confirm by text (field values, checkbox states, new dialogs) instead of an image.',
    '- Take a full screenshot only when the consequence extends beyond a crop.',
    '',
    'Focus discipline (keyboard input follows focus): an autonomy approval prompt moves focus to Otto\'s window. Any batch that types or sends keys should set `act` `focus` to the target window — it re-raises that window right before the first step. With single `type`/`key` calls, raise the window first (act {steps:[{action:"focus", window}]} or the platform shell command).',
    '- Clicks do NOT need focus handling: they hit whatever window is under the pointer.',
    '- Encourage the user to choose "Approve for session" the first time so later input tools don\'t prompt (and don\'t steal focus).',
    `- Standard shortcuts use ${mod} on this machine (e.g. "${mod}+S").`,
  ];
}

function buildSystemPrompt(): string {
  return [
    `You are Otto, a desktop coworking agent running on the user's ${platformName()} machine.`,
    '',
    'Available tools:',
    `- shell_exec(command, cwd?, timeout_ms?): ${shellDescription()} Returns stdout/stderr/exitCode.`,
    '- shell_spawn(command, cwd?): start a long-running command in the background, returns { handle, pid }. Output streams into the chat automatically.',
    '- shell_read(handle, since?): read buffered output for a spawned process.',
    '- shell_wait(handle, timeout_ms?): block until a spawned process exits.',
    '- shell_kill(handle): send SIGTERM to a spawned process.',
    screenshotToolDescription(),
    '- get_cursor_position(): return the cursor position {x, y} in virtual-desktop pixels.',
    '- move(x, y): move the cursor to the given monitor-relative position.',
    '- scroll(dx, dy, x?, y?): scroll by (dx, dy); optional (x, y) moves cursor first.',
    '- click(x, y, button?, delay_ms?, verify?): left/right/middle click at the position. Result embeds a zoomed verification crop unless verify:false (see GUI workflow).',
    '- double_click(x, y, button?, verify?): double-click at the position. Result embeds a verification crop unless verify:false.',
    '- drag(x1, y1, x2, y2, button?, verify?): drag from start to end. Result embeds a verification crop of the endpoint unless verify:false.',
    '- type(text, delay_ms?): type literal text into the focused window.',
    '- key(combo, delay_ms?): send a key combo (e.g. "Control+S", "F5", "Return").',
    '- act(steps, focus?, observe?, window?, region?, step_delay_ms?): run a batch of click/double_click/move/scroll/drag/type/key/wait/focus/ui steps in ONE call with ONE approval, then return one observation (crop|window|screen|region|tree|none). The default fast path for multi-step GUI work.',
    '- ui_tree(window?, query?, max_nodes?, include_offscreen?): read a window\'s controls from the accessibility tree as text with element ids and exact bounds. Cheaper and more precise than a screenshot.',
    '- ui_act(id, op?, text?): operate an element from ui_tree — press (invoke/toggle via accessibility, no pointer), focus, set_text, or click.',
    '- WebSearch(query): search the web; returns titles, urls, and snippets you can cite.',
    '- WebFetch(url, prompt): fetch a URL and extract readable content based on the prompt.',
    '- knowledge_append(note): save a durable fact or preference to Otto\'s memory. Stable preferences are prioritized for inclusion in future prompts. Use sparingly.',
    '- recall(query, kinds?, limit?): search Otto\'s durable memory from prior sessions on this machine. Returns matching facts and structured artifacts (playbooks, anti-patterns, heuristics) with provenance (learned_at, last_used_at, times_used, sessions_seen) — weigh trust accordingly. Call this at the START of any task that resembles past work before deciding on an approach.',
    '- annotate_result(takeaway?, why?, call_id?): attach a one-line annotation to the most recent finished tool call (or a specific call_id). It renders inline on that tool\'s card in the chat.',
    '- observe(label, command, unit, interval_s?, duration_s?, threshold?, alert_when?): watch a numeric metric — samples `command` every interval_s (default 2s) for duration_s (default 60s), reading the FIRST number in its stdout. threshold + alert_when flag spikes. Blocks until done; the chat shows a live chart and the result concludes with a verdict. Use it for intermittent problems (frame hitches, IO bursts, CPU spikes) instead of repeated shell_exec polling. To verify a fix, run a watch AFTER applying it and compare against the before-watch.',
    '- mark_task_complete(summary, title?, cause?, fix?, verified?, undo_command?): call ONCE when you believe the user\'s request is fully addressed. Triggers a background reflection pass. When the task fixed a concrete problem, include the structured fields — title (one line, what got fixed), cause, fix (exact command/change), verified (how you know it worked), undo_command (only if cleanly reversible) — they render an outcome card in the chat. Do not call between sub-steps.',
    '- echo(msg), fake-mutate(target), fake-wipe(target): test stubs; ignore unless explicitly asked.',
    '',
    'ANNOTATIONS: after a tool result that yields a real finding, call annotate_result with `takeaway` — ONE plain-language sentence (≤90 chars) stating what the output revealed ("indexer reading 212 MB/s during the hitch"), never a restatement of the command or a bare status. After a FAILED command, call it with `why` — why it failed and what you will do next. Skip routine successes (listing files, simple checks) and never annotate the same call twice.',
    '',
    'INLINE IMAGES: you can embed images in your responses with `![alt](url)`. Use this only when a visual materially helps the user — a screenshot from a guide, an in-game map, a diagram, a UI reference. Never decorative. The URL must come from a WebSearch/WebFetch result (or another tool that returned an image URL); do not invent URLs. Otto downloads, validates, and caches every image locally before rendering, so dead or non-image URLs fail silently.',
    '',
    'When a screenshot is too large for a single image, it is split into TILES. The meta\'s `tiles` array lists each tile\'s virtual-desktop rect: `[{ index, x, y, w, h }, ...]`, in the same order the image attachments appear. To convert a pixel you see at `(ix, iy)` inside tile N to virtual-desktop coords for clicking: `(tiles[N].x + ix, tiles[N].y + iy)`. The image pixel pitch is always 1:1 with virtual-desktop pixels (no DPR scaling) so no further math is needed. When `tiles.length === 1`, the offset is `(0, 0)` for full-desktop captures and the region/window origin for crops — translation still works the same way.',
    '',
    ...guiWorkflowSection(),
    '',
    `Delegating GUI work: for a long, mechanical on-screen sequence where you already know what must happen (filling a multi-field form, clicking through a settings wizard, repeating an action across many items), hand it to the "${GUI_AGENT_NAME}" subagent with the Agent tool — it runs on a faster model. Write the prompt self-contained (it has none of this conversation): target window, exact steps or end state, and what to report. Keep single actions, diagnosis and judgement calls yourself; do not run it in the background.`,
    '',
    'Things NOT to do:',
    '- Do NOT press `Escape` as a recovery action — it will close menus, lose work, or hide Otto itself. Only use Escape when the user explicitly asks.',
    '- Do NOT type or click into windows other than what the user asked for. If you can\'t find the target in the tree or screenshot, say so and ask the user — don\'t guess.',
    '- Do NOT use input tools on Otto\'s own chat panel.',
    '',
    'The autonomy framework gates tool calls by action class. Some commands will pause for user approval before running — proceed normally, the user will see the prompt. Be concise.',
  ].join('\n');
}

// Tools the GUI subagent may use: the input/vision/accessibility surface plus
// shell_exec for window lookups. All still run through Otto's MCP server, so
// autonomy approvals apply exactly as for the main agent.
const GUI_AGENT_TOOLS = [
  'ui_tree', 'ui_act', 'act', 'screenshot', 'click', 'double_click', 'drag', 'move', 'scroll',
  'type', 'key', 'get_cursor_position', 'shell_exec',
].map((n) => `mcp__otto-tools__${n}`);

export const GUI_AGENT_NAME = 'gui-operator';

function guiAgentPrompt(): string {
  return [
    `You are Otto's GUI operator on the user's ${platformName()} machine. The main Otto agent hands you one concrete on-screen task; carry it out quickly and report back.`,
    '',
    ...guiWorkflowSection(),
    '',
    'When a screenshot is split into TILES, the meta `tiles` array gives each tile\'s virtual-desktop rect in attachment order: pixel (ix, iy) in tile N is (tiles[N].x + ix, tiles[N].y + iy).',
    '',
    'Rules:',
    '- Do only the task you were given. If something unexpected appears — a confirmation for a destructive action, a login or payment prompt, an error you were not told about — stop and report it instead of improvising.',
    '- Do NOT press Escape as a recovery action, and never use input tools on Otto\'s own window.',
    '- Finish with a short report: what you did, the final on-screen state (quote field values / titles you can read), and anything that did not go as described.',
  ].join('\n');
}

function guiAgentDefinition(): NonNullable<Options['agents']>[string] {
  return {
    description:
      'Fast GUI operator on a quicker model. Give it a concrete, self-contained on-screen task — which window, exactly what to click/type/select, and what "done" looks like — and it drives the UI (accessibility tree, batched input, screenshots) and reports the final state. Use for long mechanical GUI sequences; keep diagnosis and decisions yourself.',
    prompt: guiAgentPrompt(),
    tools: GUI_AGENT_TOOLS,
    model: process.env.OTTO_GUI_AGENT_MODEL || BACKGROUND_MODEL,
    maxTurns: 40,
  };
}

function otherMachinesSection(names: string[]): string[] {
  return [
    '',
    `OTHER MACHINES: the user has paired other computers running Otto: ${names.join(', ')}.`,
    '- delegate_to_machine(machine, task, if_busy?, follow_up?): when the user asks for something on one of those machines, hand it to that machine\'s Otto. Write `task` self-contained in the second person ("Quit the Slack app.") — the other Otto has none of this conversation\'s context. follow_up: true continues the previous task there.',
    '- wait_for_machine(machine): keep watching a delegated task that was still running when delegate_to_machine returned.',
    'Relay the result to the user in one or two lines. Never pick if_busy "interrupt" without the user\'s say-so.',
  ];
}

export interface RealSdkClientDeps {
  broker: DecisionBroker;
  sudo: SudoBroker;
  /** Returns the messageId of the assistant message being authored for the current turn. */
  currentMessageId: () => string;
  /** Origin ('desktop' | 'remote') governing tool calls in the given session right now. */
  originForSession?: (sessionId: string) => 'desktop' | 'remote';
  getRegistry: () => ProcessRegistry;
  getConfigDir: () => string;
  recall(args: {
    query: string;
    kinds?: Array<'fact' | 'playbook' | 'anti_pattern' | 'heuristic'>;
    limit?: number;
  }): Promise<{
    facts: Array<{
      body: string;
      learned_at: string;
      last_used_at: string | null;
      times_used: number;
      sessions_seen: number;
    }>;
    artifacts: Array<{
      id: string;
      kind: 'playbook' | 'anti_pattern' | 'heuristic';
      title: string;
      body: string;
      tags: string[];
      updated_at: number;
      times_used: number;
      last_used_at: string | null;
    }>;
  }>;
  memoryCounts(): { playbook: number; anti_pattern: number; heuristic: number; factsPinned: number; factsTotal: number };
  factsForPrompt(): { markdown: string; ids: string[] };
  bumpFactUse(ids: string[], sessionId: string): void;
  appendKnowledge(note: string, sessionId: string): Promise<void>;
  onMarkTaskComplete(sessionId: string, summary: string): void;
  /** Whether to request summarized reasoning ("Show reasoning" setting). */
  showReasoning?: () => boolean;
  /** Fan-out emitter for events produced mid-tool-run (streamed stdout). Same
   *  channel the SessionManager and ProcessRegistry publish on. */
  emit?: (event: SessionEvent) => void;
  /** Otto-to-Otto delegation; its tools are registered only while machines are paired. */
  peers?: DelegationManager;
}

interface ToolCtx {
  broker: DecisionBroker;
  sudo: SudoBroker;
  sessionId: string;
  // Lazy so the MCP tool callback reads the *current* assistant messageId at
  // invocation time. Capturing it at MCP-server build time was racy: the SDK
  // sometimes fired tools against the initial server (built with a placeholder
  // messageId) before `setMcpServers` swapped in a per-turn closure, so the
  // pending event arrived with a messageId the renderer couldn't match and the
  // ApprovalCard never rendered.
  getMessageId: () => string;
  getOrigin: (sessionId: string) => 'desktop' | 'remote';
  getRegistry: () => ProcessRegistry;
  getConfigDir: () => string;
  recall: RealSdkClientDeps['recall'];
  factsForPrompt: RealSdkClientDeps['factsForPrompt'];
  bumpFactUse: RealSdkClientDeps['bumpFactUse'];
  appendKnowledge: RealSdkClientDeps['appendKnowledge'];
  onMarkTaskComplete: RealSdkClientDeps['onMarkTaskComplete'];
  emit?: (event: SessionEvent) => void;
  peers?: DelegationManager;
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

export function buildOttoMcpServer(sdk: AgentSdkModule, ctx: ToolCtx) {
  const { createSdkMcpServer, tool } = sdk;
  const allTools: OttoTool[] = [
    ...stubTools,
    ...buildShellTools(ctx.getRegistry),
    buildScreenshotTool(),
    ...buildInputTools(),
    buildActTool(),
    buildUiTreeTool(),
    buildUiActTool(),
    buildKnowledgeTool(),
    buildRecallTool(),
    buildMarkTaskCompleteTool(),
    buildAnnotateTool(),
    buildObserveTool(),
    ...(ctx.peers && ctx.peers.machineNames().length > 0 ? buildDelegationTools(ctx.peers, ctx.sessionId) : []),
  ];
  const gui: GuiCtx = {
    sessionId: ctx.sessionId,
    getConfigDir: ctx.getConfigDir,
    setRefs: setScreenshotRefs,
  };
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

        // Read once: the global current message id moves when any session sends.
        const messageId = ctx.getMessageId();
        const origin = ctx.getOrigin(ctx.sessionId);
        if (origin === 'remote' && (DELEGATION_TOOL_NAMES as readonly string[]).includes(t.name)) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: DELEGATION_FROM_REMOTE_MSG }],
          };
        }
        const cls = t.actionClassFor ? t.actionClassFor(args) : t.actionClass;
        const outcome = await ctx.broker.decide({
          sessionId: ctx.sessionId,
          messageId,
          origin,
          callId,
          toolName: t.name,
          actionClass: cls,
          input: args,
          denyMatchFn: t.denyMatch ? (i: unknown) => t.denyMatch!(i) : null,
        });

        if (outcome === 'deny') {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Denied by Otto autonomy policy` }],
          };
        }

        // Elevated shell commands need a password once per session. Capture it
        // here (after autonomy approval) so the spawned `sudo` hits a primed
        // timestamp instead of hanging on a per-command prompt.
        if (t.name === 'shell_exec' || t.name === 'shell_spawn') {
          const command = (args as { command?: string }).command ?? '';
          if (commandRequiresSudo(command) && !ctx.sudo.isUnlocked(ctx.sessionId)) {
            const unlocked = await ctx.sudo.ensureUnlocked({
              sessionId: ctx.sessionId,
              messageId,
              callId,
              command,
            });
            if (!unlocked) {
              return {
                isError: true,
                content: [
                  {
                    type: 'text' as const,
                    text: 'Sudo elevation was not granted (cancelled, timed out, or wrong password). The command was not run.',
                  },
                ],
              };
            }
          }
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
          // Pointer actions that commit something get a native-res crop of
          // where they landed (pointer rendered) attached to the SAME tool
          // result, so the model verifies the hit without a full screenshot
          // round-trip — unless it opted out with verify:false. Best-effort:
          // a failed capture degrades to plain text.
          const verifyTarget = (args as { verify?: boolean }).verify === false ? null : verifyTargetFor(action);
          if (verifyTarget) {
            try {
              return { content: await verifyCropContent(gui, callId, verifyTarget) };
            } catch (err) {
              logger.warn(
                `input verify capture failed (action still executed): ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: result === undefined ? 'ok' : JSON.stringify(result),
              },
            ],
          };
        }

        if (t.name === 'act') {
          let cancelled = false;
          killsByCall.set(callId, () => { cancelled = true; });
          try {
            return await runAct(gui, callId, args as ActArgs, () => cancelled);
          } finally {
            killsByCall.delete(callId);
          }
        }

        if (t.name === 'ui_tree') {
          const a = args as { window?: string; query?: string; max_nodes?: number; include_offscreen?: boolean };
          const tree = await uiTree({
            window: a.window,
            query: a.query,
            maxNodes: a.max_nodes ?? 300,
            includeOffscreen: a.include_offscreen,
          });
          return { content: [{ type: 'text' as const, text: tree.text }] };
        }

        if (t.name === 'ui_act') {
          const a = args as { id: string; op?: 'press' | 'focus' | 'set_text' | 'click'; text?: string };
          const r = await performUiOp(a.id, a.op ?? 'press', a.text);
          if (r.pointer) {
            // A real click happened: show where it landed, like `click` does.
            try {
              await new Promise((res) => setTimeout(res, 120));
              return { content: await verifyCropContent(gui, callId, r.pointer, { method: r.method }) };
            } catch (err) {
              logger.warn(`ui_act verify capture failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...r }) }] };
        }

        if (t.name === 'knowledge_append') {
          const { note } = args as { note: string };
          await ctx.appendKnowledge(note, ctx.sessionId);
          return { content: [{ type: 'text' as const, text: 'noted' }] };
        }

        if (t.name === 'screenshot') {
          const sArgs = args as { region?: { x: number; y: number; w: number; h: number }; window?: string };
          return { content: await screenshotContent(gui, callId, sArgs) };
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

        let result: unknown;
        try {
          result = await t.run(args, {
            // Streamed stdout (P2): running blocking tools (shell_exec) publish
            // incremental output straight to the renderer, keyed by callId —
            // the same fan-out ProcessRegistry uses for spawned processes.
            emitOutput: (stream, data) => {
              ctx.emit?.({
                type: 'tool-call-output',
                sessionId: ctx.sessionId,
                messageId,
                callId,
                stream,
                data,
              });
            },
            // Partial-result snapshots (P3): a running observe publishes its
            // series/events so the chart card fills live. Throttled at source.
            emitSnapshot: (snapshot) => {
              ctx.emit?.({
                type: 'tool-call-snapshot',
                sessionId: ctx.sessionId,
                messageId,
                callId,
                snapshot,
              });
            },
            registerKill: (kill) => killsByCall.set(callId, kill),
          });
        } finally {
          killsByCall.delete(callId);
        }
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
      // Turn in flight, and messages sent into it (folded in before it ends).
      let running: string | null = null;
      const steers: string[] = [];
      function pumpNext(): Promise<Enqueued | null> {
        if (inbox.length > 0) return Promise.resolve(inbox.shift()!);
        if (closed) return Promise.resolve(null);
        return new Promise((resolve) => {
          waiters.push(resolve);
        });
      }
      function enqueue(m: Enqueued): EnqueueKind {
        if (closed) return 'turn';
        if (running !== null) {
          steers.push(m.messageId);
          return 'steer';
        }
        running = m.messageId;
        const w = waiters.shift();
        if (w) w(m);
        else inbox.push(m);
        return 'turn';
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
            denyMatchFn: (i: unknown) => denyMatch((i as { command: string }).command),
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
            denyMatchFn: (i: unknown) => denyMatch((i as { command: string }).command),
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
            denyMatchFn: null,
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
            denyMatchFn: null,
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
            if (ev.type === 'message-end') {
              for (const steerId of steers.splice(0)) {
                yield { type: 'steer-folded', steerId, messageId: next.messageId };
              }
            }
            yield { ...ev, messageId: next.messageId } as TaggedSdkStreamEvent;
          }
          running = null;
        }
      }

      return {
        enqueue(args) { return enqueue(args); },
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
    buildActTool(),
    buildUiTreeTool(),
    buildUiActTool(),
    buildKnowledgeTool(),
    buildRecallTool(),
    buildMarkTaskCompleteTool(),
    buildAnnotateTool(),
    buildObserveTool(),
  ];
  const allowedTools = [
    ...allToolsForAllow.map((t) => `mcp__otto-tools__${t.name}`),
    ...DELEGATION_TOOL_NAMES.map((n) => `mcp__otto-tools__${n}`),
    'WebSearch',
    'WebFetch',
    'Agent',
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
      const machines = deps.peers?.machineNames() ?? [];
      const parts = [buildSystemPrompt(), ...(machines.length > 0 ? otherMachinesSection(machines) : []), '', '---', memLine];
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
            sudo: deps.sudo,
            sessionId,
            getMessageId: deps.currentMessageId,
            getOrigin: (sid) => deps.originForSession?.(sid) ?? 'desktop',
            getRegistry: deps.getRegistry,
            getConfigDir: deps.getConfigDir,
            recall: deps.recall,
            factsForPrompt: deps.factsForPrompt,
            bumpFactUse: deps.bumpFactUse,
            appendKnowledge: deps.appendKnowledge,
            onMarkTaskComplete: deps.onMarkTaskComplete,
            emit: deps.emit,
            peers: deps.peers,
          });
          inner = sdkModule.query({
            prompt: prompt as AsyncIterable<SDKUserMessage>,
            options: {
              ...(options as Options),
              systemPrompt,
              tools: ['WebSearch', 'WebFetch', 'Agent'],
              agents: { [GUI_AGENT_NAME]: guiAgentDefinition() },
              allowedTools,
              mcpServers: { 'otto-tools': initialMcp },
              abortController,
              // Summarized reasoning ("Show reasoning" setting). Adaptive lets
              // the model decide when/how much to reason; display:'summarized'
              // streams the reasoning summary back as thinking blocks. Opus
              // 4.7+/Fable default to display:'omitted' (reasoning still
              // happens, just hidden), so this is what surfaces the text.
              ...(deps.showReasoning?.()
                ? { thinking: { type: 'adaptive', display: 'summarized' } }
                : {}),
              ...(resumeId ? { resume: resumeId } : {}),
              ...(spawnOverrides ?? {}),
              // Echo each prompt back when the CLI reads it: how the session
              // stream tells a message folded into a running turn from one
              // that runs as its own (see createSessionStream).
              extraArgs: { 'replay-user-messages': null },
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

      return toSessionStreamHandle(stream, () => abortController.abort());
    },
  };
}

/**
 * Adapt a {@link SessionStream} into the SessionStreamHandle protocol expected
 * by SessionManager. Raw SDK messages are re-mapped into the fine-grained
 * SdkStreamEvent stream (text-delta, tool-call-start, ...), each tagged with
 * the messageId of the turn that produced it; a `result` closes that turn with
 * message-end + done.
 */
export function toSessionStreamHandle(stream: SessionStream, onClose: () => void = () => {}): SessionStreamHandle {
  async function* eventsTagged(): AsyncIterable<TaggedSdkStreamEvent> {
    for await (const se of stream.events()) {
      if (se.type === 'steer-folded') {
        yield { type: 'steer-folded', messageId: se.messageId, steerId: se.steerId };
        continue;
      }
      if (se.type === 'turn-promoted') {
        yield { type: 'turn-promoted', messageId: se.messageId };
        continue;
      }
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
      return stream.enqueueUserMessage(args);
    },
    interrupt: () => stream.interrupt(),
    events: eventsTagged,
    close: () => {
      onClose();
      stream.close();
    },
    queueDepth: () => stream.queueDepth(),
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
    // Surface MCP server connection status from the SDK init message. If
    // `otto-tools` isn't `connected` here, every mcp__otto-tools__* tool call
    // will fail with "No such tool available" — this log tells us whether the
    // in-process server failed to register vs. was merely late for the first turn.
    const init = msg as { mcp_servers?: Array<{ name?: string; status?: string }> };
    const servers = init.mcp_servers ?? [];
    const otto = servers.find((s) => s.name === 'otto-tools');
    if (!otto || otto.status !== 'connected') {
      logger.warn(
        `SDK init: otto-tools MCP server not connected (status=${otto?.status ?? 'absent'}); ` +
          `all servers=${JSON.stringify(servers)}`
      );
    } else {
      logger.info(`SDK init: otto-tools MCP server connected (${servers.length} server(s))`);
    }
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
      if (bType === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) {
        // Summarized reasoning ("Show reasoning" setting). Thinking blocks lead
        // the assistant message, so emitting here keeps reasoning ordered ahead
        // of the answer text. When display:'omitted' they carry no text and are
        // skipped. redacted_thinking blocks (no .thinking) are likewise skipped.
        out.push({ type: 'reasoning', text: block.thinking as string });
      } else if (bType === 'text' && typeof block.text === 'string' && block.text.length > 0) {
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
