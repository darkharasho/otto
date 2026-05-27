import { describe, it, expect } from 'vitest';
import { createMessageQueue } from './session-stream';

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
