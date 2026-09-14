import { describe, it, expect, vi } from 'vitest';
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

  it('shell_exec exposes denyMatch with tiers', () => {
    const { byName } = makeTools();
    const exec = byName.get('shell_exec')!;
    expect(exec.denyMatch).toBeTruthy();
    expect(exec.denyMatch!({ command: 'rm -rf /' })).toEqual({ tier: 'hard', name: 'rm-rf-root' });
    expect(exec.denyMatch!({ command: 'mkfs.exfat /dev/sda1' })).toEqual({ tier: 'confirm', name: 'mkfs' });
    expect(exec.denyMatch!({ command: 'ls' })).toBeNull();
  });

  it('shell_kill has static destructive class and no command-based deny', () => {
    const { byName } = makeTools();
    const kill = byName.get('shell_kill')!;
    expect(kill.actionClass).toBe('destructive');
    expect(kill.actionClassFor).toBeUndefined();
    expect(kill.denyMatch).toBeUndefined();
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
    expect(t.denyMatch).toBeUndefined();
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

import { consumeScreenshotRefs } from './sdk-client';

it('consumeScreenshotRefs returns null for unknown call ids', () => {
  expect(consumeScreenshotRefs('does-not-exist')).toBeNull();
});

import { buildRecallTool, buildMarkTaskCompleteTool } from './tools';

describe('buildRecallTool', () => {
  it('returns a read-class tool with name "recall"', () => {
    const t = buildRecallTool();
    expect(t.name).toBe('recall');
    expect(t.actionClass).toBe('read');
  });

  it('schema accepts query alone and with kinds + limit', () => {
    const t = buildRecallTool();
    expect(() => t.schema.parse({ query: 'audio' })).not.toThrow();
    expect(() =>
      t.schema.parse({ query: 'audio', kinds: ['fact', 'playbook'], limit: 10 })
    ).not.toThrow();
  });

  it('schema rejects bad kind', () => {
    const t = buildRecallTool();
    expect(() => t.schema.parse({ query: 'x', kinds: ['weird'] })).toThrow();
  });

  it('schema rejects limit > 20', () => {
    const t = buildRecallTool();
    expect(() => t.schema.parse({ query: 'x', limit: 50 })).toThrow();
  });
});

describe('buildMarkTaskCompleteTool', () => {
  it('returns a read-class tool with name "mark_task_complete"', () => {
    const t = buildMarkTaskCompleteTool();
    expect(t.name).toBe('mark_task_complete');
    expect(t.actionClass).toBe('read');
  });

  it('schema requires a non-empty summary', () => {
    const t = buildMarkTaskCompleteTool();
    expect(() => t.schema.parse({ summary: 'fixed audio' })).not.toThrow();
    expect(() => t.schema.parse({})).toThrow();
    expect(() => t.schema.parse({ summary: '' })).toThrow();
  });

  it('schema accepts the structured outcome fields', () => {
    const t = buildMarkTaskCompleteTool();
    expect(() =>
      t.schema.parse({
        summary: 'paused the indexer',
        title: 'Stopped the frame hitches',
        cause: 'baloo indexing a fresh 200GB dump',
        fix: 'balooctl suspend',
        verified: '0 spikes over 20ms in a 3m watch',
        undo_command: 'balooctl resume',
      })
    ).not.toThrow();
    expect(() => t.schema.parse({ summary: 'x', title: '' })).toThrow();
  });
});

import { buildObserveTool } from './tools';
import type { exec as execFn } from '../shell/executor';

function makeFakeExec(samples: Array<{ stdout: string; exitCode?: number }>) {
  let i = 0;
  const fake = vi.fn(async () => {
    const s = samples[Math.min(i, samples.length - 1)]!;
    i += 1;
    return { stdout: s.stdout, stderr: '', exitCode: s.exitCode ?? 0, durationMs: 1, timedOut: false };
  });
  return fake as unknown as typeof execFn;
}

describe('buildObserveTool', () => {
  it('classifies by the sampling command and exposes denyMatch', () => {
    const t = buildObserveTool();
    expect(t.name).toBe('observe');
    expect(t.actionClassFor!({ command: 'cat /proc/loadavg' })).toBe('read');
    expect(t.denyMatch!({ command: 'rm -rf /' })).toEqual({ tier: 'hard', name: 'rm-rf-root' });
    expect(t.denyMatch!({ command: 'cat /proc/loadavg' })).toBeNull();
  });

  it('samples the first number, flags one alert event per excursion, and concludes Still occurring', async () => {
    const t = buildObserveTool({ exec: makeFakeExec([{ stdout: 'io 25.5 MB/s\n' }]) });
    const snapshots: Array<Record<string, unknown>> = [];
    const res = (await t.run(
      { label: 'disk reads', command: 'iostat -x 1 1', unit: 'MB/s', interval_s: 0.5, duration_s: 1.2, threshold: 20 },
      { emitSnapshot: (s) => snapshots.push(s as Record<string, unknown>) }
    )) as Record<string, unknown>;

    expect(res.kind).toBe('observe');
    expect(res.label).toBe('disk reads');
    const series = res.series as number[];
    expect(series.length).toBeGreaterThanOrEqual(2);
    expect(series.every((v) => v === 25.5)).toBe(true);
    // Consecutive over-threshold samples are ONE excursion → one alert event.
    const events = res.events as Array<{ level: string; text: string }>;
    expect(events.filter((e) => e.level === 'alert')).toHaveLength(1);
    expect(events[0]!.text).toContain('over 20 MB/s');
    const verdict = res.verdict as { ok: boolean; text: string };
    expect(verdict.ok).toBe(false);
    expect(verdict.text).toContain('Still occurring');
    // Snapshots are throttled to ≤1/s, so a ~1.2s watch emits fewer than its samples.
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    expect(snapshots.length).toBeLessThanOrEqual(2);
    expect(snapshots[0]).toMatchObject({ kind: 'observe', label: 'disk reads', threshold: 20 });
  }, 10_000);

  it('concludes Resolved when no sample crosses the threshold', async () => {
    const t = buildObserveTool({ exec: makeFakeExec([{ stdout: '3\n' }]) });
    const res = (await t.run(
      { label: 'load', command: 'cat /proc/loadavg', unit: '%', interval_s: 0.5, duration_s: 1, threshold: 90 },
      {}
    )) as Record<string, unknown>;
    const verdict = res.verdict as { ok: boolean; text: string };
    expect(verdict.ok).toBe(true);
    expect(verdict.text).toContain('Resolved');
    expect((res.events as unknown[])).toHaveLength(0);
  }, 10_000);

  it('bails after repeated sample failures with a No data verdict', async () => {
    const t = buildObserveTool({ exec: makeFakeExec([{ stdout: 'not a number', exitCode: 0 }]) });
    const start = Date.now();
    const res = (await t.run(
      { label: 'broken', command: 'echo not a number', unit: 'ms', interval_s: 0.5, duration_s: 30 },
      {}
    )) as Record<string, unknown>;
    // Bailed on the fail-streak, not the 30s duration.
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(res.series).toEqual([]);
    const verdict = res.verdict as { ok: boolean; text: string };
    expect(verdict.ok).toBe(false);
    expect(verdict.text).toContain('No data');
    const events = res.events as Array<{ level: string; text: string }>;
    expect(events).toHaveLength(1); // fail noted once, not per tick
    expect(events[0]!.text).toContain('no number');
  }, 15_000);
});
