import { describe, it, expect, vi } from 'vitest';
import { buildOttoMcpServer } from './sdk-client';

describe('buildOttoMcpServer origin', () => {
  it('passes the turn origin to broker.decide for tool calls', async () => {
    const handlers = new Map<string, (args: unknown, extra: unknown) => Promise<unknown>>();
    const sdk = {
      tool: (name: string, _d: string, _s: unknown, handler: (args: unknown, extra: unknown) => Promise<unknown>) => {
        handlers.set(name, handler);
        return { name };
      },
      createSdkMcpServer: (o: unknown) => o,
    };
    const decide = vi.fn(async () => 'deny');
    const getOrigin = vi.fn((_id: string): 'desktop' | 'remote' => 'remote');
    buildOttoMcpServer(sdk as never, {
      broker: { decide } as never,
      sudo: {} as never,
      sessionId: 's1',
      getMessageId: () => 'm1',
      getOrigin,
      getRegistry: () => ({}) as never,
      getConfigDir: () => '/tmp',
    } as never);
    await handlers.get('shell_exec')!({ command: 'ls' }, {});
    expect(getOrigin).toHaveBeenCalledWith('m1');
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ origin: 'remote' }));
  });
});
