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

import { buildScreenshotTool } from './tools';

describe('buildScreenshotTool', () => {
  it('returns a tool named screenshot with static read class', () => {
    const t = buildScreenshotTool();
    expect(t.name).toBe('screenshot');
    expect(t.actionClass).toBe('read');
    expect(t.actionClassFor).toBeUndefined();
    expect(t.denyPatterns).toBeUndefined();
  });

  it('schema accepts no args (region optional)', () => {
    const t = buildScreenshotTool();
    expect(t.schema.parse({})).toEqual({});
  });

  it('schema accepts a well-formed region', () => {
    const t = buildScreenshotTool();
    expect(t.schema.parse({ region: { x: 10, y: 20, w: 30, h: 40 } })).toEqual({
      region: { x: 10, y: 20, w: 30, h: 40 },
    });
  });

  it('schema rejects negative coords', () => {
    const t = buildScreenshotTool();
    expect(() => t.schema.parse({ region: { x: -1, y: 0, w: 10, h: 10 } })).toThrow();
  });

  it('schema rejects zero or negative dimensions', () => {
    const t = buildScreenshotTool();
    expect(() => t.schema.parse({ region: { x: 0, y: 0, w: 0, h: 10 } })).toThrow();
    expect(() => t.schema.parse({ region: { x: 0, y: 0, w: 10, h: -1 } })).toThrow();
  });

  it('direct run throws (handler intercepts)', async () => {
    const t = buildScreenshotTool();
    await expect(t.run({})).rejects.toThrow(/SDK handler/);
  });
});

import { buildInputTools } from './tools';

describe('buildInputTools', () => {
  it('returns 8 tools with expected names', () => {
    const names = buildInputTools().map((t) => t.name).sort();
    expect(names).toEqual([
      'click', 'double_click', 'drag', 'get_cursor_position',
      'key', 'move', 'scroll', 'type',
    ]);
  });

  it('action classes match the matrix', () => {
    const byName = new Map(buildInputTools().map((t) => [t.name, t]));
    expect(byName.get('get_cursor_position')!.actionClass).toBe('read');
    expect(byName.get('move')!.actionClass).toBe('reversible');
    expect(byName.get('scroll')!.actionClass).toBe('reversible');
    expect(byName.get('click')!.actionClass).toBe('destructive');
    expect(byName.get('double_click')!.actionClass).toBe('destructive');
    expect(byName.get('drag')!.actionClass).toBe('destructive');
    expect(byName.get('type')!.actionClass).toBe('destructive');
    expect(byName.get('key')!.actionClass).toBe('destructive');
  });

  it('click schema accepts coords + optional button/delay', () => {
    const t = buildInputTools().find((t) => t.name === 'click')!;
    expect(t.schema.parse({ x: 10, y: 20 })).toEqual({ x: 10, y: 20, button: 'left' });
    expect(t.schema.parse({ x: 10, y: 20, button: 'right', delay_ms: 50 })).toEqual({
      x: 10, y: 20, button: 'right', delay_ms: 50,
    });
  });

  it('click schema rejects negative coords', () => {
    const t = buildInputTools().find((t) => t.name === 'click')!;
    expect(() => t.schema.parse({ x: -1, y: 0 })).toThrow();
  });

  it('type schema requires text', () => {
    const t = buildInputTools().find((t) => t.name === 'type')!;
    expect(t.schema.parse({ text: 'hi' })).toEqual({ text: 'hi' });
    expect(() => t.schema.parse({})).toThrow();
  });

  it('key schema requires combo string', () => {
    const t = buildInputTools().find((t) => t.name === 'key')!;
    expect(t.schema.parse({ combo: 'Control+S' })).toEqual({ combo: 'Control+S' });
    expect(() => t.schema.parse({})).toThrow();
  });

  it('scroll allows negative deltas', () => {
    const t = buildInputTools().find((t) => t.name === 'scroll')!;
    expect(t.schema.parse({ dx: -5, dy: 3 })).toEqual({ dx: -5, dy: 3 });
  });

  it('drag requires all four coords', () => {
    const t = buildInputTools().find((t) => t.name === 'drag')!;
    expect(() => t.schema.parse({ x1: 1, y1: 2 })).toThrow();
    expect(t.schema.parse({ x1: 1, y1: 2, x2: 3, y2: 4 })).toEqual({
      x1: 1, y1: 2, x2: 3, y2: 4, button: 'left',
    });
  });

  it('direct run throws for every tool', async () => {
    for (const t of buildInputTools()) {
      const validInput = (() => {
        switch (t.name) {
          case 'get_cursor_position': return {};
          case 'move': return { x: 0, y: 0 };
          case 'scroll': return { dx: 0, dy: 0 };
          case 'click': return { x: 0, y: 0 };
          case 'double_click': return { x: 0, y: 0 };
          case 'drag': return { x1: 0, y1: 0, x2: 0, y2: 0 };
          case 'type': return { text: '' };
          case 'key': return { combo: 'a' };
          default: throw new Error('unhandled');
        }
      })();
      await expect(t.run(validInput)).rejects.toThrow(/SDK handler/);
    }
  });
});
