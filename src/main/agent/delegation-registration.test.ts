import { describe, it, expect } from 'vitest';
import { buildOttoMcpServer } from './sdk-client';

function toolNames(machineNames: string[] | null): string[] {
  const names: string[] = [];
  const sdk = {
    tool: (name: string) => { names.push(name); return { name }; },
    createSdkMcpServer: (o: unknown) => o,
  };
  buildOttoMcpServer(sdk as never, {
    broker: {} as never,
    sudo: {} as never,
    sessionId: 's1',
    getMessageId: () => 'm1',
    getOrigin: () => 'desktop',
    getRegistry: () => ({}) as never,
    getConfigDir: () => '/tmp',
    ...(machineNames ? { peers: { machineNames: () => machineNames } } : {}),
  } as never);
  return names;
}

describe('delegation tool registration', () => {
  it('registers delegate/wait only while machines are paired', () => {
    expect(toolNames(null)).not.toContain('delegate_to_machine');
    expect(toolNames([])).not.toContain('delegate_to_machine');
    const paired = toolNames(['Desk']);
    expect(paired).toContain('delegate_to_machine');
    expect(paired).toContain('wait_for_machine');
  });
});
