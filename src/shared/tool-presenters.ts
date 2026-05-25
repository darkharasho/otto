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

const GROUP_OVERRIDES: Record<string, string> = {
  github: 'GitHub',
  'chrome-devtools-mcp': 'Chrome DevTools',
  'chrome-devtools': 'Chrome DevTools',
  playwright: 'Playwright',
};

const ICON_BY_SUBSTRING: Array<[RegExp, IconName]> = [
  [/screenshot/i,                       'camera'],
  [/(^|_)(read|get_file|list_file)/i,   'file'],
  [/(^|_)(edit|write|update_file)/i,    'edit'],
  [/(^|_)search/i,                      'search'],
  [/(^|_)(fetch|navigate|http)/i,       'globe'],
  [/(^|_)(click|hover|drag|move)/i,     'mouse'],
  [/(^|_)(type|press_key|fill)/i,       'keyboard'],
  [/github|pull_request|issue|branch/i, 'github'],
  [/(^|_)(sql|query|db|database)/i,     'database'],
  [/(image|png|jpg)/i,                  'image'],
];

function titleCase(s: string): string {
  return s
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => w ? w[0].toUpperCase() + w.slice(1) : '')
    .join(' ');
}

function pickIcon(toolName: string, fallback: IconName): IconName {
  for (const [re, icon] of ICON_BY_SUBSTRING) {
    if (re.test(toolName)) return icon;
  }
  return fallback;
}

function parseMcpName(name: string): { server: string; tool: string } | null {
  // mcp__<server>__<tool>  (server and tool may themselves contain underscores; first '__' is the split)
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return null;
  let server = m[1];
  const tool = m[2];
  // Strip leading 'plugin_' from server name when present.
  if (server.startsWith('plugin_')) {
    const rest = server.slice('plugin_'.length);
    // 'plugin_github_github' → 'github' (collapse duplicate).
    const parts = rest.split('_');
    server = parts.length >= 2 && parts[0] === parts[parts.length - 1] ? parts[0] : rest;
  }
  return { server, tool };
}

export function describeTool(name: string): ToolDescriptor {
  const builtin = BUILTIN[name];
  if (builtin) return builtin;

  const parsed = parseMcpName(name);
  if (parsed) {
    // Otto's bundled tools land here as 'mcp__otto-tools__<name>' — fall through to the built-in table.
    if (parsed.server === 'otto-tools' && BUILTIN[parsed.tool]) {
      return BUILTIN[parsed.tool];
    }
    const groupKey = parsed.server.toLowerCase();
    const group = GROUP_OVERRIDES[groupKey] ?? titleCase(groupKey.replace(/[-_]mcp$/, ''));
    const label = titleCase(parsed.tool);
    const icon = pickIcon(parsed.tool, 'plug');
    return { label, group, icon };
  }

  return { label: name, icon: 'tool' };
}
