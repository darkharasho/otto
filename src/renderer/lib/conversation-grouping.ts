export type SessionState = 'idle' | 'running' | 'done' | 'errored' | 'denied';
export type StatusDot = 'idle' | 'running' | 'done' | 'errored';

export interface SidebarSession {
  id: string;
  title: string;
  updatedAt: number;
  state: SessionState;
  recentToolNames: string[];
}

export interface SidebarGroup {
  label: 'Pinned' | 'Today' | 'Yesterday' | 'Earlier';
  items: SidebarSession[];
}

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function groupSessions(
  sessions: SidebarSession[],
  pinnedIds: string[],
  now: number = Date.now()
): SidebarGroup[] {
  const pinnedSet = new Set(pinnedIds);
  const today = startOfDay(now);
  const yesterday = today - 24 * 60 * 60 * 1000;

  const pinned: SidebarSession[] = [];
  const todayItems: SidebarSession[] = [];
  const yesterdayItems: SidebarSession[] = [];
  const earlier: SidebarSession[] = [];

  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const s of sorted) {
    if (pinnedSet.has(s.id)) { pinned.push(s); continue; }
    if (s.updatedAt >= today) todayItems.push(s);
    else if (s.updatedAt >= yesterday) yesterdayItems.push(s);
    else earlier.push(s);
  }

  const groups: SidebarGroup[] = [];
  if (pinned.length) groups.push({ label: 'Pinned', items: pinned });
  if (todayItems.length) groups.push({ label: 'Today', items: todayItems });
  if (yesterdayItems.length) groups.push({ label: 'Yesterday', items: yesterdayItems });
  if (earlier.length) groups.push({ label: 'Earlier', items: earlier });
  return groups;
}

export function sessionStatusDot(state: SessionState): StatusDot {
  if (state === 'running') return 'running';
  if (state === 'errored' || state === 'denied') return 'errored';
  if (state === 'done') return 'done';
  return 'idle';
}

export function recentToolGlyphs(toolNames: string[], max = 3): string[] {
  const reversed = [...toolNames].reverse();
  const seen = new Set<string>();
  const picks: string[] = [];
  for (const n of reversed) {
    if (seen.has(n)) continue;
    seen.add(n);
    picks.push(n);
    if (picks.length === max) break;
  }
  return picks.reverse();
}
