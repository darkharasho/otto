export type IconName =
  | 'camera' | 'terminal' | 'edit' | 'file' | 'search' | 'globe'
  | 'mouse' | 'keyboard' | 'github' | 'database' | 'image'
  | 'brain' | 'plug' | 'tool';

export interface ToolDescriptor {
  label: string;
  group?: string;
  icon: IconName;
}

const BUILTIN: Record<string, ToolDescriptor> = {
  screenshot:        { label: 'Screenshot', icon: 'camera' },
  shell_exec:        { label: 'Run command', group: 'Shell', icon: 'terminal' },
  shell_spawn:       { label: 'Spawn process', group: 'Shell', icon: 'terminal' },
  click:             { label: 'Click', group: 'Input', icon: 'mouse' },
  double_click:      { label: 'Double-click', group: 'Input', icon: 'mouse' },
  move:              { label: 'Move cursor', group: 'Input', icon: 'mouse' },
  type:              { label: 'Type text', group: 'Input', icon: 'keyboard' },
  key:               { label: 'Press key', group: 'Input', icon: 'keyboard' },
  knowledge_append:  { label: 'Append knowledge', group: 'Memory', icon: 'brain' },
  knowledge_search:  { label: 'Search knowledge', group: 'Memory', icon: 'brain' },
  web_search:        { label: 'Search', group: 'Web', icon: 'search' },
  web_fetch:         { label: 'Fetch page', group: 'Web', icon: 'globe' },
};

export function describeTool(name: string): ToolDescriptor {
  const hit = BUILTIN[name];
  if (hit) return hit;
  return { label: name, icon: 'tool' };
}
