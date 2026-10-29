import type { SDKUserMessage, SDKMessage, Options } from '@anthropic-ai/claude-agent-sdk';
import type { ContentBlock } from '@shared/messages';
import { promises as fsp } from 'node:fs';
import { randomUUID } from 'node:crypto';

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

/**
 * How an enqueued message will be handled: 'turn' starts its own turn (the
 * session was idle); 'steer' was sent while a turn was in flight and is folded
 * into it — unless that turn ends before the CLI reads it, in which case a
 * 'turn-promoted' event hands it its own turn.
 */
export type EnqueueKind = 'turn' | 'steer';

export type SessionStreamEvent =
  | { messageId: string; type: 'assistant-message' | 'result' | 'system' | 'partial'; raw: SDKMessage }
  /** The CLI read steer `steerId` into running turn `messageId`. */
  | { messageId: string; type: 'steer-folded'; steerId: string }
  /** Steer `messageId` missed its turn and now runs as its own. */
  | { messageId: string; type: 'turn-promoted' };

export type QueryFactory = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => AsyncIterable<SDKMessage> & { interrupt: () => Promise<void>; setMcpServers?: (servers: Record<string, unknown>) => Promise<unknown> };

export interface SessionStream {
  enqueueUserMessage(msg: EnqueuedMessage): EnqueueKind;
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
  const inbox = createMessageQueue<EnqueuedMessage & { kind: EnqueueKind }>();
  // Every message goes to the CLI as soon as it's sent. A message sent while a
  // turn runs is a "steer": the CLI drains it into the running turn between
  // tool rounds, or — when that turn has no tool round left — runs it (batched
  // with any other pending ones) as the next turn. The CLI echoes each user
  // message back (replay-user-messages) when it reads it, carrying our uuid;
  // that echo is what tells the two cases apart.
  //
  // The turn in flight: stream events belong to it. One turn == one `result`
  // (interrupted turns included — the CLI ends them with error_during_execution).
  let current: string | null = null;
  // Steers handed over (or about to be) that the CLI hasn't read yet, oldest first.
  const steers: string[] = [];
  const idByUuid = new Map<string, string>();
  // Label for events seen while no turn is in flight (e.g. trailing status
  // messages after a result). Points at the last finished turn so SessionManager
  // drops them as late events rather than inventing a row.
  let lastTurnId = '';
  let closed = false;

  function startTurn(messageId: string): void | Promise<void> {
    current = messageId;
    return args.onPerMessageContext?.(messageId);
  }

  async function* promptIterable(): AsyncIterable<SDKUserMessage> {
    const it = inbox.iterable[Symbol.asyncIterator]();
    while (true) {
      const next = await it.next();
      if (next.done || closed) return;
      const m = next.value;
      if (m.kind === 'turn' && args.onPerMessageContext) {
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
      const uuid = randomUUID();
      idByUuid.set(uuid, m.messageId);
      yield {
        type: 'user',
        message: { role: 'user', content: content as never },
        parent_tool_use_id: null,
        session_id: args.sessionId,
        uuid,
        priority: 'next',
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
        const ack = replayAckId(raw);
        if (ack !== null) {
          const messageId = idByUuid.get(ack);
          if (messageId === undefined) continue;
          idByUuid.delete(ack);
          const i = steers.indexOf(messageId);
          if (i === -1) continue; // a turn's own prompt (or an already-promoted steer)
          steers.splice(i, 1);
          if (current !== null) {
            yield { messageId: current, type: 'steer-folded', steerId: messageId };
          } else {
            await startTurn(messageId);
            yield { messageId, type: 'turn-promoted' };
          }
          continue;
        }
        const type = mapType(raw);
        const messageId = current ?? lastTurnId;
        yield { messageId, type, raw };
        if (type === 'result' && current !== null) {
          lastTurnId = current;
          current = null;
          // Steers the CLI hadn't read by the end of the turn run next, as one
          // turn: the oldest owns it, the rest fold in when their echo arrives.
          const next = steers.shift();
          if (next !== undefined) {
            await startTurn(next);
            yield { messageId: next, type: 'turn-promoted' };
          }
        }
      }
    } finally {
      closed = true;
    }
  }

  return {
    enqueueUserMessage(msg) {
      let kind: EnqueueKind = 'turn';
      if (current === null) current = msg.messageId;
      else {
        kind = 'steer';
        steers.push(msg.messageId);
      }
      inbox.push({ ...msg, kind });
      return kind;
    },
    interrupt: () => q.interrupt(),
    events,
    close() {
      closed = true;
      inbox.close();
    },
    queueDepth: () => inbox.depth(),
  };
}

/** The uuid of a replay-user-messages echo of a prompt we sent, else null. */
function replayAckId(msg: SDKMessage): string | null {
  const m = msg as { type?: string; isReplay?: boolean; uuid?: unknown };
  return m.type === 'user' && m.isReplay === true && typeof m.uuid === 'string' ? m.uuid : null;
}

function mapType(msg: SDKMessage): 'assistant-message' | 'result' | 'system' | 'partial' {
  const t = (msg as { type?: string }).type;
  if (t === 'assistant') return 'assistant-message';
  if (t === 'result') return 'result';
  if (t === 'system') return 'system';
  return 'partial';
}
