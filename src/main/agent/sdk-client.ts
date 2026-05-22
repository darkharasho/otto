import type { SdkClient, SdkStreamEvent, SdkTurn } from './session';
import { buildShellTools, stubTools, type OttoTool } from './tools';
import type { DecisionBroker } from '../autonomy/decision-broker';
import type { ProcessRegistry } from '../shell/process-registry';
import { logger } from '../logger';

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

const SYSTEM_PROMPT =
  'You are Otto, a desktop coworking agent. In this skeleton build no real tools exist yet; the only available tool is `echo` for pipeline testing. Be concise.';

export interface RealSdkClientDeps {
  broker: DecisionBroker;
  /** Returns the messageId of the assistant message being authored for the current turn. */
  currentMessageId: () => string;
  getRegistry: () => ProcessRegistry;
}

interface ToolCtx {
  broker: DecisionBroker;
  sessionId: string;
  messageId: string;
  getRegistry: () => ProcessRegistry;
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
function buildOttoMcpServer(sdk: AgentSdkModule, ctx: ToolCtx) {
  const { createSdkMcpServer, tool } = sdk;
  const allTools: OttoTool[] = [...stubTools, ...buildShellTools(ctx.getRegistry)];
  const sdkTools = allTools.map((t) => {
    const shape = (t.schema as unknown as { shape?: Record<string, unknown> }).shape;
    if (!shape) {
      throw new Error(`OttoTool ${t.name} schema must be a z.object(...) so we can pull .shape`);
    }
    return tool(
      t.name,
      t.description,
      shape as any,
      async (args: unknown, _extra: unknown) => {
        const callId =
          (typeof _extra === 'object' && _extra && 'toolUseId' in _extra
            ? String((_extra as { toolUseId?: unknown }).toolUseId ?? '')
            : '') || `${t.name}-${Date.now().toString(36)}`;

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

        if (outcome === 'deny') {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `Denied by Otto autonomy policy` }],
          };
        }

        if (t.name === 'shell.spawn') {
          const spawnArgs = args as { command: string; cwd?: string };
          const cwd = spawnArgs.cwd ?? process.env.HOME ?? '/';
          const p = ctx.getRegistry().spawn({
            sessionId: ctx.sessionId,
            messageId: ctx.messageId,
            command: spawnArgs.command,
            cwd,
          });
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify({ handle: p.handle, pid: p.pid }) },
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
    );
  });
  return createSdkMcpServer({ name: 'otto-tools', version: '0.1.0', tools: sdkTools });
}

function createFakeSdkClient(deps?: {
  broker?: DecisionBroker;
  currentMessageId?: () => string;
  getRegistry?: () => ProcessRegistry;
}): SdkClient {
  let counter = 0;
  return {
    async startSession() {
      counter += 1;
      return { id: `fake-${counter}` };
    },
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

export function createRealSdkClient(deps: RealSdkClientDeps): SdkClient {
  if (process.env.OTTO_FAKE_SDK === '1') return createFakeSdkClient(deps);
  let sessionCounter = 0;
  // SDK-defined tools registered via MCP appear to the model with the prefix
  // `mcp__<server-name>__<tool-name>`. Whitelist them via `allowedTools` so they
  // don't trigger permission prompts during the skeleton smoke.
  const allToolsForAllow: OttoTool[] = [...stubTools, ...buildShellTools(deps.getRegistry)];
  const allowedTools = allToolsForAllow.map((t) => `mcp__otto-tools__${t.name}`);

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

    sendTurn(sessionId, text, signal, resumeId): SdkTurn {
      // The SDK takes an AbortController, not a raw AbortSignal. Bridge by
      // creating a controller and aborting it when the upstream signal fires.
      const abortController = new AbortController();
      if (signal.aborted) {
        abortController.abort();
      } else {
        signal.addEventListener('abort', () => abortController.abort(), { once: true });
      }

      async function* events(): AsyncIterable<SdkStreamEvent> {
        yield { type: 'message-start' };
        const sdk = await loadAgentSdk();
        // Rebuild MCP server per turn so the closure captures a fresh
        // { sessionId, messageId, broker } context.
        const ottoMcp = buildOttoMcpServer(sdk, {
          broker: deps.broker,
          sessionId,
          messageId: deps.currentMessageId(),
          getRegistry: deps.getRegistry,
        });
        const iter = sdk.query({
          prompt: text,
          options: {
            systemPrompt: SYSTEM_PROMPT,
            // Disable all built-in Claude Code tools; we only want our MCP tool.
            tools: [],
            allowedTools,
            mcpServers: { 'otto-tools': ottoMcp },
            abortController,
            // Session continuity: pass a captured SDK session id to resume the
            // prior conversation. On the first turn this is undefined; we'll
            // capture the id from the init system message below.
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
