import '@testing-library/jest-dom/vitest';

// jsdom doesn't ship ResizeObserver — components that observe element sizes
// (e.g. animated max-height) need a no-op shim.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver =
  ResizeObserverStub;
