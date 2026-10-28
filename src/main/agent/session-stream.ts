import type { SDKUserMessage, SDKMessage, Options } from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlock } from '@shared/messages';
import { promises as fsp } from 'node:fs';

export interface MessageQueue<T> {
  push(item: T): void;
  close(): void;
  readonly iterable: AsyncIterable<T>;
  readonly depth: () => number;
}

export function createMessageQueue<T>(): MessageQueue<T> {
  const buffer: T[] = [];
  const waiters: Array<(v: IteratorResult<T>) => void> = [];
  let closed = false;

  function push(item: T): void {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else buffer.push(item);
  }

  function close(): void {
    closed = true;
    while (waiters.length > 0) waiters.shift()!({ value: undefined as never, done: true });
  }

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          if (buffer.length > 0) return Promise.resolve({ value: buffer.shift()!, done: false });
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };

  return { push, close, iterable, depth: () => buffer.length };
}

export type EnqueuedMessage = {
  messageId: string;
  text: string;
  attachments: Array<Extract<ContentBlock, { type: 'image-ref' }>>;
};

export interface SessionStreamEvent {
  messageId: string;
  type: 'assistant-message' | 'result' | 'system' | 'partial';
  raw: SDKMessage;
}

export type QueryFactory = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<SDKMessage> & { interrupt: () => Promise<void>; setMcpServers?: (servers: Record<string, unknown>) => Promise<unknown> };

export interface SessionStream {
  enqueueUserMessage(msg: EnqueuedMessage): void;
  interrupt(): Promise<void>;
  events(): AsyncIterable<SessionStreamEvent>;
  close(): void;
  queueDepth(): number;
}

export function createSessionStream(args: {
  sessionId: string;
  queryFactory: QueryFactory;
  options?: Partial<Options>;
  /**
   * Called with each new messageId BEFORE the SDK consumes that user message
   * from the prompt iterable. Used by the real client to swap the MCP server
   * so each user turn's tool closures capture a fresh { sessionId, messageId,
   * broker } context. May be async; the pump awaits it before yielding.
   */
  onPerMessageContext?: (messageId: string) => void | Promise<void>;
}): SessionStream {
  const inbox = createMessageQueue<EnqueuedMessage>();
  // Message ids handed to the SDK whose turn hasn't produced its `result` yet,
  // oldest first. Stream events belong to the head: the SDK runs one user turn
  // at a time, in order, and closes each with exactly one `result` (interrupted
  // turns included — the CLI ends them with an error_during_execution result).
  const turns: string[] = [];
  // Label for events seen while no turn is in flight (e.g. trailing status
  // messages after a result). Points at the last finished turn so SessionManager
  // drops them as late events rather than inventing a row.
  let lastTurnId = '';
  let closed = false;
  let turnSettled: (() => void) | null = null;

  function settleTurn(): void {
    const w = turnSettled;
    turnSettled = null;
    w?.();
  }

  // Wait until no turn is in flight. Query.streamInput pulls the prompt
  // iterable eagerly, and the bundled CLI does NOT keep queued prompts as
  // separate turns: in SDK mode it drains 'next'-priority queued prompts into
  // the running turn between tool rounds, and batches consecutive queued
  // prompts into one turn at turn end — either way one `result` for several
  // messages, which would shift every later label. Handing the SDK one message
  // at a time keeps one message == one turn == one result.
  function waitForIdle(): Promise<void> {
    if (turns.length === 0 || closed) return Promise.resolve();
    return new Promise((resolve) => { turnSettled = resolve; });
  }

  async function* promptIterable(): AsyncIterable<SDKUserMessage> {
    const it = inbox.iterable[Symbol.asyncIterator]();
    while (true) {
      await waitForIdle();
      if (closed) return;
      const next = await it.next();
      if (next.done) return;
      const m = next.value;
      turns.push(m.messageId);
      if (args.onPerMessageContext) {
        await args.onPerMessageContext(m.messageId);
      }
      let content: unknown;
      if (m.attachments.length === 0) {
        // No attachments — pass text directly as a string (simpler, matches SDK string-prompt behaviour)
        content = m.text;
      } else {
        const parts: unknown[] = [];
        if (m.text.length > 0) parts.push({ type: 'text', text: m.text });
        for (const a of m.attachments) {
          parts.push({
            type: 'image',
            source: { type: 'base64', media_type: a.mimeType, data: (await fsp.readFile(a.path)).toString('base64') },
          });
        }
        content = parts;
      }
      yield {
        type: 'user',
        message: { role: 'user', content: content as never },
        parent_tool_use_id: null,
        session_id: args.sessionId,
      } as SDKUserMessage;
    }
  }

  const q = args.queryFactory({
    prompt: promptIterable() as AsyncIterable<SDKUserMessage>,
    options: (args.options ?? {}) as Options,
  });

  async function* events(): AsyncIterable<SessionStreamEvent> {
    try {
      for await (const raw of q) {
        const type = mapType(raw);
        const messageId = turns[0] ?? lastTurnId;
        if (type === 'result' && turns.length > 0) {
          // This turn is over: the next event belongs to the next queued message.
          lastTurnId = turns.shift()!;
          if (turns.length === 0) settleTurn();
        }
        yield { messageId, type, raw };
      }
    } finally {
      // Stream ended or failed: no result is coming, so stop holding the prompt pump.
      closed = true;
      settleTurn();
    }
  }

  return {
    enqueueUserMessage(msg) { inbox.push(msg); },
    interrupt: () => q.interrupt(),
    events,
    close() {
      closed = true;
      inbox.close();
      settleTurn();
    },
    queueDepth: () => inbox.depth(),
  };
}

function mapType(msg: SDKMessage): SessionStreamEvent['type'] {
  const t = (msg as { type?: string }).type;
  if (t === 'assistant') return 'assistant-message';
  if (t === 'result') return 'result';
  if (t === 'system') return 'system';
  return 'partial';
}
