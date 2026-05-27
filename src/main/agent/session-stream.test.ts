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
    for (let i = 0; i < 2; i++) {
      const { value } = await iter.next();
      events.push({ messageId: value.messageId, type: value.type });
    }
    stream.close();
    expect(yielded).toEqual(['hello', 'world']);
    expect(events.map((e) => e.messageId)).toEqual(['m1', 'm2']);
  });
});
