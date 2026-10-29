import { describe, it, expect } from 'vitest';
import { createMessageQueue, createSessionStream, type QueryFactory, type SessionStreamEvent } from './session-stream';

describe('createMessageQueue', () => {
  it('yields pushed items in order across awaits', async () => {
    const q = createMessageQueue<number>();
    q.push(1);
    q.push(2);
    const iter = q.iterable[Symbol.asyncIterator]();
    expect((await iter.next()).value).toBe(1);
    expect((await iter.next()).value).toBe(2);
  });

  it('waits when empty and resolves when an item arrives', async () => {
    const q = createMessageQueue<number>();
    const iter = q.iterable[Symbol.asyncIterator]();
    const pending = iter.next();
    setTimeout(() => q.push(42), 10);
    expect((await pending).value).toBe(42);
  });

  it('close() ends the iteration', async () => {
    const q = createMessageQueue<number>();
    q.close();
    const iter = q.iterable[Symbol.asyncIterator]();
    expect((await iter.next()).done).toBe(true);
  });
});

describe('createSessionStream', () => {
  it('forwards enqueued user messages to the query factory and tags events with messageId', async () => {
    const yielded: string[] = [];
    const factory: QueryFactory = ({ prompt }) => {
      return {
        async *[Symbol.asyncIterator]() {
          for await (const m of prompt) {
            yielded.push(m.message.content as string);
            yield { type: 'assistant', message: { content: [{ type: 'text', text: `echo:${m.message.content}` }] }, session_id: 's', uuid: 'u' };
            yield { type: 'result', subtype: 'success' };
          }
        },
        interrupt: async () => {},
      } as unknown as ReturnType<QueryFactory>;
    };

    const stream = createSessionStream({ sessionId: 's', queryFactory: factory });
    stream.enqueueUserMessage({ messageId: 'm1', text: 'hello', attachments: [] });
    stream.enqueueUserMessage({ messageId: 'm2', text: 'world', attachments: [] });

    const events: Array<{ messageId: string; type: string }> = [];
    const iter = stream.events()[Symbol.asyncIterator]();
    for (let i = 0; i < 5; i++) {
      const { value } = await iter.next();
      events.push({ messageId: value.messageId, type: value.type });
    }
    stream.close();
    expect(yielded).toEqual(['hello', 'world']);
    // m2 was sent while m1's turn was in flight; never read into it, it gets its own.
    expect(events).toEqual([
      { messageId: 'm1', type: 'assistant-message' },
      { messageId: 'm1', type: 'result' },
      { messageId: 'm2', type: 'turn-promoted' },
      { messageId: 'm2', type: 'assistant-message' },
      { messageId: 'm2', type: 'result' },
    ]);
  });
});

/**
 * A query fake that behaves like the bundled CLI in SDK mode: it reads the
 * prompt iterable eagerly (Query.streamInput writes each message as soon as it
 * is yielded), echoes each prompt back as a replay ack when it reads it, and
 * runs a turn per idle-time batch of queued prompts, closing each with a
 * `result`. A turn script calls `drain()` between "tool rounds" to read any
 * prompts queued meanwhile into the running turn.
 */
type CliTurn = (args: { text: string; signal: AbortSignal; drain: () => unknown[] }) => AsyncGenerator<unknown>;

function cliFactory(turn: CliTurn) {
  const pulled: string[] = [];
  const folded: string[] = [];
  const factory: QueryFactory = ({ prompt }) => {
    const cliQueue: Array<{ text: string; uuid: string }> = [];
    let wake = null as (() => void) | null;
    let inputDone = false;
    void (async () => {
      for await (const m of prompt) {
        pulled.push(m.message.content as string);
        cliQueue.push({ text: m.message.content as string, uuid: m.uuid! });
        wake?.();
      }
      inputDone = true;
      wake?.();
    })();
    const ack = (p: { text: string; uuid: string }) => ({ type: 'user', isReplay: true, uuid: p.uuid, message: { role: 'user', content: p.text } });
    let turnAbort = new AbortController();
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (cliQueue.length === 0) {
            if (inputDone) return;
            await new Promise<void>((r) => { wake = r; });
            wake = null;
            continue;
          }
          // Batch everything queued while idle into one turn.
          const batch = cliQueue.splice(0);
          for (const p of batch) yield ack(p);
          turnAbort = new AbortController();
          const drain = () => cliQueue.splice(0).map((p) => { folded.push(p.text); return ack(p); });
          yield* turn({ text: batch.map((p) => p.text).join('+'), signal: turnAbort.signal, drain });
          yield { type: 'result', subtype: turnAbort.signal.aborted ? 'error_during_execution' : 'success' };
        }
      },
      interrupt: async () => { turnAbort.abort(); },
    } as unknown as ReturnType<QueryFactory>;
  };
  return { factory, pulled, folded };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

async function take(iter: AsyncIterator<SessionStreamEvent>, n: number): Promise<Array<[string, string, string?]>> {
  const out: Array<[string, string, string?]> = [];
  for (let i = 0; i < n; i++) {
    const { value } = await iter.next();
    out.push(value.type === 'steer-folded' ? [value.messageId, value.type, value.steerId] : [value.messageId, value.type]);
  }
  return out;
}

describe('createSessionStream steering', () => {
  it('reports turn for an idle send and steer for a send into a running turn', async () => {
    const { factory } = cliFactory(async function* () { await tick(50); });
    const stream = createSessionStream({ sessionId: 's', queryFactory: factory });
    expect(stream.enqueueUserMessage({ messageId: 'm1', text: 'first', attachments: [] })).toBe('turn');
    expect(stream.enqueueUserMessage({ messageId: 'm2', text: 'second', attachments: [] })).toBe('steer');
    stream.close();
  });

  it('hands a mid-turn message to the SDK at once and folds it into the running turn when read', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { factory, pulled, folded } = cliFactory(async function* ({ text, drain }) {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: `start:${text}` }] } };
      await gate;
      yield* drain();
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'end' }] } };
    });
    const contexts: string[] = [];
    const stream = createSessionStream({ sessionId: 's', queryFactory: factory, onPerMessageContext: (id) => { contexts.push(id); } });
    const iter = stream.events()[Symbol.asyncIterator]();
    stream.enqueueUserMessage({ messageId: 'm1', text: 'first', attachments: [] });
    const head = await take(iter, 1);
    stream.enqueueUserMessage({ messageId: 'm2', text: 'new info', attachments: [] });
    await tick();
    expect(pulled).toEqual(['first', 'new info']);
    release();
    const rest = await take(iter, 3);
    stream.close();
    expect([...head, ...rest]).toEqual([
      ['m1', 'assistant-message'],
      ['m1', 'steer-folded', 'm2'],
      ['m1', 'assistant-message'],
      ['m1', 'result'],
    ]);
    expect(folded).toEqual(['new info']);
    // The steer never became the current message: approvals stay with m1.
    expect(contexts).toEqual(['m1']);
  });

  it('promotes a steer the turn ended without reading to a turn of its own', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { factory } = cliFactory(async function* ({ text }) {
      yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
      if (text === 'first') await gate;
    });
    const contexts: string[] = [];
    const stream = createSessionStream({ sessionId: 's', queryFactory: factory, onPerMessageContext: (id) => { contexts.push(id); } });
    const iter = stream.events()[Symbol.asyncIterator]();
    stream.enqueueUserMessage({ messageId: 'm1', text: 'first', attachments: [] });
    const head = await take(iter, 1);
    stream.enqueueUserMessage({ messageId: 'm2', text: 'second', attachments: [] });
    await tick();
    release();
    const seen = [...head, ...await take(iter, 4)];
    stream.close();
    expect(seen).toEqual([
      ['m1', 'assistant-message'],
      ['m1', 'result'],
      ['m2', 'turn-promoted'],
      ['m2', 'assistant-message'],
      ['m2', 'result'],
    ]);
    expect(contexts).toEqual(['m1', 'm2']);
  });

  it('several unread steers run as one turn owned by the oldest; the rest fold into it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { factory } = cliFactory(async function* ({ text }) {
      yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
      if (text === 'first') await gate;
    });
    const stream = createSessionStream({ sessionId: 's', queryFactory: factory });
    const iter = stream.events()[Symbol.asyncIterator]();
    stream.enqueueUserMessage({ messageId: 'm1', text: 'first', attachments: [] });
    const head = await take(iter, 1);
    stream.enqueueUserMessage({ messageId: 'm2', text: 'a', attachments: [] });
    stream.enqueueUserMessage({ messageId: 'm3', text: 'b', attachments: [] });
    await tick();
    release();
    const seen = [...head, ...await take(iter, 5)];
    stream.close();
    expect(seen).toEqual([
      ['m1', 'assistant-message'],
      ['m1', 'result'],
      ['m2', 'turn-promoted'],
      ['m2', 'steer-folded', 'm3'],
      ['m2', 'assistant-message'],
      ['m2', 'result'],
    ]);
  });

  it('an interrupted turn ends on its result and an unread steer runs as its own turn', async () => {
    const { factory } = cliFactory(async function* ({ text, signal }) {
      yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
      if (text === 'first' && !signal.aborted) await new Promise<void>((r) => signal.addEventListener('abort', () => r()));
    });
    const stream = createSessionStream({ sessionId: 's', queryFactory: factory });
    const iter = stream.events()[Symbol.asyncIterator]();
    stream.enqueueUserMessage({ messageId: 'm1', text: 'first', attachments: [] });
    const first = await take(iter, 1);
    stream.enqueueUserMessage({ messageId: 'm2', text: 'second', attachments: [] });
    await tick();
    await stream.interrupt();
    const rest = await take(iter, 4);
    stream.close();
    expect([...first, ...rest]).toEqual([
      ['m1', 'assistant-message'],
      ['m1', 'result'],
      ['m2', 'turn-promoted'],
      ['m2', 'assistant-message'],
      ['m2', 'result'],
    ]);
  });
});
