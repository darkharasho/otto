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
  [/(^|_)(github|pull_request|issues?|branch)($|_)/i, 'github'],
  [/(^|_)(sql|query|db|database)/i,     'database'],
  [/(image|png|jpg)/i,                  'image'],
];

function titleCase(s: string): string {
  return s
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => {
      if (!w) return '';
      const first = w[0];
      return first ? first.toUpperCase() + w.slice(1) : '';
    })
    .join(' ');
}

function pickIcon(toolName: string, fallback: IconName): IconName {
  for (const [re, icon] of ICON_BY_SUBSTRING) {
    if (re.test(toolName)) return icon;
  }
  return fallback;
}

function parseMcpName(name: string): { server: string; tool: string } | null {
  // mcp__<server>__<tool>. Server and tool may contain underscores;
  // the lazy `+?` ensures we split on the FIRST '__' (server stays minimal).
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return null;
  const rawServer = m[1];
  const tool = m[2];
  if (rawServer === undefined || tool === undefined) return null;
  let server = rawServer;
  // Strip leading 'plugin_' from server name when present.
  if (server.startsWith('plugin_')) {
    const rest = server.slice('plugin_'.length);
    // 'plugin_github_github' → 'github' (collapse duplicate).
    const parts = rest.split('_');
    server = parts.length >= 2 && parts[0] === parts[parts.length - 1] ? parts[0]! : rest;
  }
  return { server, tool };
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

type Summarizer = (input: Record<string, unknown>, max: number) => string | null;

const SUMMARIZERS: Record<string, Summarizer> = {
  shell_exec:   (o, m) => truncate(String(o['command'] ?? ''), m) || null,
  shell_spawn:  (o, m) => truncate(String(o['command'] ?? ''), m) || null,
  click:        (o)    => o['x'] !== undefined && o['y'] !== undefined ? `${o['x']}, ${o['y']}` : null,
  double_click: (o)    => o['x'] !== undefined && o['y'] !== undefined ? `${o['x']}, ${o['y']}` : null,
  move:         (o)    => o['x'] !== undefined && o['y'] !== undefined ? `${o['x']}, ${o['y']}` : null,
  type:         (o, m) => o['text'] != null ? `"${truncate(String(o['text']), Math.max(8, m - 2))}"` : null,
  key:          (o)    => asString(o['combo']),
  screenshot:   (o)    => o['window'] ? String(o['window']) : o['region'] ? 'region' : 'full',
  knowledge_append: (o, m) => truncate(String(o['note'] ?? ''), m) || null,
  web_search:   (o, m) => o['query'] != null ? `"${truncate(String(o['query']), Math.max(8, m - 2))}"` : null,
  web_fetch:    (o)    => {
    const u = asString(o['url']);
    if (!u) return null;
    try { return new URL(u).hostname; } catch { return u; }
  },
};

function mcpSummary(tool: string, o: Record<string, unknown>, max: number): string | null {
  // GitHub-flavored heuristics first.
  const isPr = /pull_request|create_pr/i.test(tool);
  if (isPr && o['owner'] && o['repo'] && o['title']) {
    return truncate(`${o['owner']}/${o['repo']} · "${o['title']}"`, max);
  }
  if (o['owner'] && o['repo']) return `${o['owner']}/${o['repo']}`;
  // Generic: first string field with content.
  for (const k of ['query', 'q', 'url', 'path', 'file_path', 'name', 'text', 'message', 'command']) {
    const v = o[k];
    if (typeof v === 'string' && v.length > 0) return truncate(v, max);
  }
  return null;
}

export function summarizeInput(name: string, input: unknown, maxLen = 80): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;

  const direct = SUMMARIZERS[name];
  if (direct) return direct(obj, maxLen);

  const parsed = parseMcpName(name);
  if (parsed) {
    // Otto bundled tools — fall through to built-in summarizers.
    if (parsed.server === 'otto-tools') {
      const fallback = SUMMARIZERS[parsed.tool];
      if (fallback) return fallback(obj, maxLen);
    }
    return mcpSummary(parsed.tool, obj, maxLen);
  }

  return null;
}

export function describeTool(name: string): ToolDescriptor {
  const builtin = BUILTIN[name];
  if (builtin) return builtin;

  const parsed = parseMcpName(name);
  if (parsed) {
    // Otto's bundled tools land here as 'mcp__otto-tools__<name>' — fall through to the built-in table.
    if (parsed.server === 'otto-tools') {
      const builtinFallback = BUILTIN[parsed.tool];
      if (builtinFallback) return builtinFallback;
    }
    const groupKey = parsed.server.toLowerCase();
    const group = GROUP_OVERRIDES[groupKey] ?? titleCase(groupKey.replace(/[-_]mcp$/, ''));
    const label = titleCase(parsed.tool);
    const icon = pickIcon(parsed.tool, 'plug');
    return { label, group, icon };
  }

  return { label: name, icon: 'tool' };
}
