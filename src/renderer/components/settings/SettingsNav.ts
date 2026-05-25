export type TabId = 'general' | 'behavior' | 'memory' | 'about';
export type SubId = string;

export interface SubEntry {
  id: SubId;
  label: string;
}

export interface TabEntry {
  id: TabId;
  label: string;
  subs: SubEntry[];
}

export const TABS: TabEntry[] = [
  {
    id: 'general',
    label: 'General',
    subs: [
      { id: 'model', label: 'Model' },
      { id: 'window', label: 'Window' },
      { id: 'shortcut', label: 'Shortcut' },
      { id: 'remoteDesktop', label: 'Remote desktop' },
      { id: 'mobileRemote', label: 'Mobile remote' },
      { id: 'startup', label: 'Startup' },
    ],
  },
  {
    id: 'behavior',
    label: 'Behavior',
    subs: [
      { id: 'autonomy', label: 'Autonomy' },
      { id: 'notifications', label: 'Notifications' },
      { id: 'sessionHistory', label: 'Session history' },
    ],
  },
  {
    id: 'memory',
    label: 'Memory',
    subs: [
      { id: 'fact', label: 'Facts' },
      { id: 'playbook', label: 'Playbooks' },
      { id: 'anti_pattern', label: 'Anti-patterns' },
      { id: 'heuristic', label: 'Heuristics' },
    ],
  },
  {
    id: 'about',
    label: 'About',
    subs: [
      { id: 'versionLogs', label: 'Version & logs' },
      { id: 'updates', label: 'Updates' },
    ],
  },
];

export function defaultSubFor(tab: TabId): SubId {
  const found = TABS.find((t) => t.id === tab);
  if (!found) throw new Error(`unknown tab ${tab}`);
  return found.subs[0]!.id;
}

export function subsFor(tab: TabId): SubEntry[] {
  return TABS.find((t) => t.id === tab)?.subs ?? [];
}
