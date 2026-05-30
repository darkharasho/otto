import { describe, it, expect } from 'vitest';
import {
  groupSessions,
  sessionStatusDot,
  recentToolGlyphs,
  type SidebarSession,
} from './conversation-grouping';

const now = new Date('2026-05-28T12:00:00Z').getTime();
const ms = (mins: number) => now - mins * 60 * 1000;

const s = (id: string, updatedAt: number, extra: Partial<SidebarSession> = {}): SidebarSession => ({
  id, title: id, updatedAt, state: 'idle', recentToolNames: [], ...extra,
});

describe('groupSessions', () => {
  it('places pinned first, then time buckets', () => {
    const sessions = [
      s('a', ms(10)),
      s('b', ms(60 * 26)),
      s('c', ms(60 * 24 * 8)),
      s('d', ms(5)),
    ];
    const groups = groupSessions(sessions, ['d'], now);
    expect(groups.map((g) => g.label)).toEqual(['Pinned', 'Today', 'Yesterday', 'Earlier']);
    expect(groups[0]!.items.map((x) => x.id)).toEqual(['d']);
    expect(groups[1]!.items.map((x) => x.id)).toEqual(['a']);
    expect(groups[2]!.items.map((x) => x.id)).toEqual(['b']);
    expect(groups[3]!.items.map((x) => x.id)).toEqual(['c']);
  });

  it('omits empty groups', () => {
    const groups = groupSessions([s('a', ms(10))], [], now);
    expect(groups.map((g) => g.label)).toEqual(['Today']);
  });
});

describe('sessionStatusDot', () => {
  it('returns running for active state', () => {
    expect(sessionStatusDot('running')).toBe('running');
  });
  it('returns errored for errored / denied', () => {
    expect(sessionStatusDot('errored')).toBe('errored');
    expect(sessionStatusDot('denied')).toBe('errored');
  });
  it('returns done for done', () => {
    expect(sessionStatusDot('done')).toBe('done');
  });
  it('returns idle for idle', () => {
    expect(sessionStatusDot('idle')).toBe('idle');
  });
});

describe('recentToolGlyphs', () => {
  it('returns the last three unique tool names', () => {
    const out = recentToolGlyphs(['screenshot', 'observe', 'shell', 'screenshot', 'files']);
    expect(out).toEqual(['shell', 'screenshot', 'files']);
  });
});
