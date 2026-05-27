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
