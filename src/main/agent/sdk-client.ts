import {
  query as agentQuery,
  createSdkMcpServer,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import type { SdkClient, SdkStreamEvent, SdkTurn } from './session';
import { stubTools } from './tools';
import { logger } from '../logger';

const SYSTEM_PROMPT =
  'You are Otto, a desktop coworking agent. In this skeleton build no real tools exist yet; the only available tool is `echo` for pipeline testing. Be concise.';

/**
 * Build the in-process MCP server that exposes Otto's stub tools to the SDK.
 *
 * The Agent SDK registers SDK-defined tools via `createSdkMcpServer` + `tool()`,
 * not via a direct `tools` option on `query()`. We wrap each {@link OttoTool}
 * in the SDK's `tool()` helper. The `tool()` factory expects a Zod raw shape
 * (object of zod schemas), so we extract `.shape` from the `z.object(...)`
 * schemas defined in `tools.ts`.
 *
 * NOTE: This uses `as any` in a couple of places to bridge between Otto's
 * generic `OttoTool` interface (`schema: ZodTypeAny`) and the SDK's stricter
 * `AnyZodRawShape`-based generics. The values are correct at runtime; this is
 * purely a TypeScript variance gap.
 */
function buildOttoMcpServer() {
  const sdkTools = stubTools.map((t) => {
    // We require all OttoTools to be defined as z.object({...}) so we can pull
    // .shape off for the SDK's tool() helper.
    const shape = (t.schema as unknown as { shape?: Record<string, unknown> }).shape;
    if (!shape) {
      throw new Error(`OttoTool ${t.name} schema must be a z.object(...) so we can pull .shape`);
    }
    return tool(
      t.name,
      t.description,
      shape as any,
      async (args: unknown) => {
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

export function createRealSdkClient(): SdkClient {
  let sessionCounter = 0;
  const ottoMcp = buildOttoMcpServer();
  // SDK-defined tools registered via MCP appear to the model with the prefix
  // `mcp__<server-name>__<tool-name>`. Whitelist them via `allowedTools` so they
  // don't trigger permission prompts during the skeleton smoke.
  const allowedTools = stubTools.map((t) => `mcp__otto-tools__${t.name}`);

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

    sendTurn(sessionId, text, signal): SdkTurn {
      // The SDK takes an AbortController, not a raw AbortSignal. Bridge by
      // creating a controller and aborting it when the upstream signal fires.
      const abortController = new AbortController();
      if (signal.aborted) {
        abortController.abort();
      } else {
        signal.addEventListener('abort', () => abortController.abort(), { once: true });
      }

      const iter = agentQuery({
        prompt: text,
        options: {
          systemPrompt: SYSTEM_PROMPT,
          // Disable all built-in Claude Code tools; we only want our MCP tool.
          tools: [],
          allowedTools,
          mcpServers: { 'otto-tools': ottoMcp },
          abortController,
          resume: sessionId,
        },
      });

      async function* events(): AsyncIterable<SdkStreamEvent> {
        yield { type: 'message-start' };
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
  const m = msg as { type?: string };

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
