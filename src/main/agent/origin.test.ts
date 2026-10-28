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
    const getOrigin = vi.fn((_sid: string): 'desktop' | 'remote' => 'remote');
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
    expect(getOrigin).toHaveBeenCalledWith('s1');
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ origin: 'remote' }));
  });
});

function build(opts: { origin: 'desktop' | 'remote'; getMessageId: () => string; peers: unknown; emit?: (e: unknown) => void }) {
  const handlers = new Map<string, (args: unknown, extra: unknown) => Promise<unknown>>();
  const sdk = {
    tool: (name: string, _d: string, _s: unknown, handler: (args: unknown, extra: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
      return { name };
    },
    createSdkMcpServer: (o: unknown) => o,
  };
  const decide = vi.fn(async () => 'allow');
  buildOttoMcpServer(sdk as never, {
    broker: { decide } as never,
    sudo: {} as never,
    sessionId: 's1',
    getMessageId: opts.getMessageId,
    getOrigin: () => opts.origin,
    getRegistry: () => ({}) as never,
    getConfigDir: () => '/tmp',
    peers: opts.peers,
    emit: opts.emit,
  } as never);
  return { handlers, decide };
}

describe('delegation tools and turn origin', () => {
  it('refuses to delegate onward from a remote-origin turn', async () => {
    const run = vi.fn(async () => 'ran');
    const wait = vi.fn(async () => 'waited');
    const { handlers, decide } = build({ origin: 'remote', getMessageId: () => 'm1', peers: { machineNames: () => ['Desk'], run, wait } });
    for (const name of ['delegate_to_machine', 'wait_for_machine']) {
      const out = await handlers.get(name)!({ machine: 'Desk', task: 'do it' }, {}) as { isError?: boolean; content: Array<{ text: string }> };
      expect(out.isError).toBe(true);
      expect(out.content[0]!.text).toBe("Delegation isn't available for tasks that came from another machine.");
    }
    expect(run).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('stamps delegation snapshots with the message id captured when the tool was invoked', async () => {
    let current = 'm-own';
    const emit = vi.fn();
    const run = vi.fn(async (a: { emitSnapshot: (s: unknown) => void }) => {
      current = 'm-other-session';
      a.emitSnapshot({ status: 'running' });
      return 'ok';
    });
    const { handlers } = build({ origin: 'desktop', getMessageId: () => current, peers: { machineNames: () => ['Desk'], run }, emit });
    await handlers.get('delegate_to_machine')!({ machine: 'Desk', task: 'do it' }, { toolUseId: 'c1' });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'tool-call-snapshot', messageId: 'm-own', callId: 'c1' }));
  });
});
