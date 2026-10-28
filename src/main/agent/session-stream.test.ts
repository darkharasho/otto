import { describe, it, expect } from 'vitest';
import { createMessageQueue, createSessionStream, type QueryFactory } from './session-stream';

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
    for (let i = 0; i < 4; i++) {
      const { value } = await iter.next();
      events.push({ messageId: value.messageId, type: value.type });
    }
    stream.close();
    expect(yielded).toEqual(['hello', 'world']);
    expect(events.map((e) => e.messageId)).toEqual(['m1', 'm1', 'm2', 'm2']);
  });
});

/**
 * A query fake that reads the prompt iterable eagerly, like the real
 * Query.streamInput (it writes every message to the CLI as soon as the
 * iterable yields it), and runs one turn per pulled message, closing each with
 * a `result`. `turn` scripts the SDK messages for a pulled prompt.
 */
function eagerFactory(turn: (text: string, signal: AbortSignal) => AsyncGenerator<unknown>) {
  const pulled: string[] = [];
  const factory: QueryFactory = ({ prompt }) => {
    const cliQueue: string[] = [];
    let wake = null as (() => void) | null;
    let inputDone = false;
    void (async () => {
      for await (const m of prompt) {
        pulled.push(m.message.content as string);
        cliQueue.push(m.message.content as string);
        wake?.();
      }
      inputDone = true;
      wake?.();
    })();
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
          const text = cliQueue.shift()!;
          turnAbort = new AbortController();
          yield* turn(text, turnAbort.signal);
          yield { type: 'result', subtype: turnAbort.signal.aborted ? 'error_during_execution' : 'success' };
        }
      },
      interrupt: async () => { turnAbort.abort(); },
    } as unknown as ReturnType<QueryFactory>;
  };
  return { factory, pulled };
}

describe('createSessionStream turn labelling', () => {
  it('labels a running turn by its own id when the next message is queued, then advances on its result', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { factory } = eagerFactory(async function* (text) {
      if (text === 'first') await gate;
      yield { type: 'assistant', message: { content: [{ type: 'text', text: `echo:${text}` }] } };
    });
    const stream = createSessionStream({ sessionId: 's', queryFactory: factory });
    const iter = stream.events()[Symbol.asyncIterator]();
    stream.enqueueUserMessage({ messageId: 'm1', text: 'first', attachments: [] });
    const firstEvent = iter.next();
    await new Promise((r) => setTimeout(r, 5));
    stream.enqueueUserMessage({ messageId: 'm2', text: 'second', attachments: [] });
    await new Promise((r) => setTimeout(r, 5));
    release();
    const seen: Array<[string, string]> = [];
    seen.push([(await firstEvent).value.messageId, (await firstEvent).value.type]);
    for (let i = 0; i < 3; i++) {
      const { value } = await iter.next();
      seen.push([value.messageId, value.type]);
    }
    stream.close();
    expect(seen).toEqual([
      ['m1', 'assistant-message'],
      ['m1', 'result'],
      ['m2', 'assistant-message'],
      ['m2', 'result'],
    ]);
  });

  it("does not hand the SDK a second message until the first turn's result", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { factory, pulled } = eagerFactory(async function* (text) {
      if (text === 'first') await gate;
      yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
    });
    const stream = createSessionStream({ sessionId: 's', queryFactory: factory });
    const iter = stream.events()[Symbol.asyncIterator]();
    stream.enqueueUserMessage({ messageId: 'm1', text: 'first', attachments: [] });
    stream.enqueueUserMessage({ messageId: 'm2', text: 'second', attachments: [] });
    const firstEvent = iter.next();
    await new Promise((r) => setTimeout(r, 10));
    // The CLI would merge an already-written queued prompt into the running
    // turn (or batch it with others), so the second one must stay with us.
    expect(pulled).toEqual(['first']);
    expect(stream.queueDepth()).toBe(1);
    release();
    await firstEvent;
    await iter.next(); // m1 result
    await iter.next(); // m2 assistant
    expect(pulled).toEqual(['first', 'second']);
    stream.close();
  });

  it('an interrupted turn ends on its result and the queued message runs as its own turn', async () => {
    const { factory } = eagerFactory(async function* (text, signal) {
      yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
      if (text === 'first' && !signal.aborted) await new Promise<void>((r) => signal.addEventListener('abort', () => r()));
    });
    const stream = createSessionStream({ sessionId: 's', queryFactory: factory });
    const iter = stream.events()[Symbol.asyncIterator]();
    stream.enqueueUserMessage({ messageId: 'm1', text: 'first', attachments: [] });
    const first = await iter.next();
    stream.enqueueUserMessage({ messageId: 'm2', text: 'second', attachments: [] });
    await stream.interrupt();
    const rest: Array<[string, string, unknown]> = [];
    for (let i = 0; i < 3; i++) {
      const { value } = await iter.next();
      rest.push([value.messageId, value.type, (value.raw as { subtype?: string }).subtype]);
    }
    stream.close();
    expect(first.value.messageId).toBe('m1');
    expect(rest).toEqual([
      ['m1', 'result', 'error_during_execution'],
      ['m2', 'assistant-message', undefined],
      ['m2', 'result', 'success'],
    ]);
  });
});
