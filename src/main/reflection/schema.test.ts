import { describe, it, expect } from 'vitest';
import { ReflectionResultSchema } from './schema';

describe('ReflectionResultSchema', () => {
  it('accepts a fully populated result', () => {
    const parsed = ReflectionResultSchema.parse({
      facts: ['Browser of choice is Zen'],
      playbooks: [
        { title: 'Restart audio', body: '## Steps\n1. systemctl --user restart pipewire', tags: ['audio'] },
      ],
      antiPatterns: [
        { title: 'Do not Escape recovery', body: 'closes menus', tags: ['input'] },
      ],
      heuristics: [
        { title: 'Prefer kdotool for window focus', body: 'faster than vision', tags: ['kdotool'] },
      ],
    });
    expect(parsed.facts).toHaveLength(1);
    expect(parsed.playbooks[0]!.tags).toEqual(['audio']);
  });

  it('accepts all-empty arrays (reflector decided nothing was worth saving)', () => {
    const parsed = ReflectionResultSchema.parse({
      facts: [],
      playbooks: [],
      antiPatterns: [],
      heuristics: [],
      skip_reason: 'task was trivial',
    });
    expect(parsed.skip_reason).toBe('task was trivial');
  });

  it('rejects an artifact missing required fields', () => {
    expect(() =>
      ReflectionResultSchema.parse({
        facts: [],
        playbooks: [{ title: 'oops' }],
        antiPatterns: [],
        heuristics: [],
      })
    ).toThrow();
  });

  it('rejects facts longer than 280 chars', () => {
    expect(() =>
      ReflectionResultSchema.parse({
        facts: ['x'.repeat(281)],
        playbooks: [],
        antiPatterns: [],
        heuristics: [],
      })
    ).toThrow();
  });

  it('lowercases tags during parse', () => {
    const parsed = ReflectionResultSchema.parse({
      facts: [],
      playbooks: [{ title: 't', body: 'b', tags: ['AUDIO', 'PipeWire'] }],
      antiPatterns: [],
      heuristics: [],
    });
    expect(parsed.playbooks[0]!.tags).toEqual(['audio', 'pipewire']);
  });
});
