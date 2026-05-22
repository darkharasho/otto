import { describe, it, expect } from 'vitest';
import { buildShellTools, type OttoTool } from './tools';
import type { ProcessRegistry } from '../shell/process-registry';

function makeTools(): { tools: OttoTool[]; byName: Map<string, OttoTool> } {
  const stubRegistry = {} as unknown as ProcessRegistry;
  const tools = buildShellTools(() => stubRegistry);
  const byName = new Map(tools.map((t) => [t.name, t]));
  return { tools, byName };
}

describe('buildShellTools', () => {
  it('returns five tools', () => {
    const { tools } = makeTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['shell_exec', 'shell_kill', 'shell_read', 'shell_spawn', 'shell_wait']);
  });

  it('shell_exec uses dynamic action class', () => {
    const { byName } = makeTools();
    const exec = byName.get('shell_exec')!;
    expect(exec.actionClassFor).toBeTruthy();
    expect(exec.actionClassFor!({ command: 'ls' })).toBe('read');
    expect(exec.actionClassFor!({ command: 'rm -rf foo' })).toBe('irreversible');
    expect(exec.actionClassFor!({ command: 'mv a b' })).toBe('destructive');
  });

  it('shell_exec exposes denyPatterns', () => {
    const { byName } = makeTools();
    const exec = byName.get('shell_exec')!;
    expect(exec.denyPatterns).toBeTruthy();
    expect(exec.denyPatterns!({ command: 'rm -rf /' })).toBeTruthy();
    expect(exec.denyPatterns!({ command: 'ls' })).toBeNull();
  });

  it('shell_kill has static destructive class and no command-based deny', () => {
    const { byName } = makeTools();
    const kill = byName.get('shell_kill')!;
    expect(kill.actionClass).toBe('destructive');
    expect(kill.actionClassFor).toBeUndefined();
    expect(kill.denyPatterns).toBeUndefined();
  });

  it('shell_read and shell_wait are static read class (they take a handle, not a command)', () => {
    const { byName } = makeTools();
    expect(byName.get('shell_read')!.actionClass).toBe('read');
    expect(byName.get('shell_wait')!.actionClass).toBe('read');
    expect(byName.get('shell_read')!.actionClassFor).toBeUndefined();
    expect(byName.get('shell_wait')!.actionClassFor).toBeUndefined();
  });
});
