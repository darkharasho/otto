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
  memory_save:       { label: 'Memory updated', group: 'Memory', icon: 'brain' },
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
  [/(^|_)(github|pull_request|issues?|branch(es)?|commits?|releases?|tags?|repo)($|_)/i, 'github'],
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

// Tiny LCS-based diff over line arrays. Sufficient for Edit's old/new pair.
function diffLines(a: string[], b: string[]): Hunk {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) {
    dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  }
  const lines: Hunk['lines'] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j])      { lines.push({ kind: 'ctx', text: a[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { lines.push({ kind: 'del', text: a[i]! }); i++; }
    else                                       { lines.push({ kind: 'add', text: b[j]! }); j++; }
  }
  while (i < m) lines.push({ kind: 'del', text: a[i++]! });
  while (j < n) lines.push({ kind: 'add', text: b[j++]! });
  return { oldStart: 1, newStart: 1, lines };
}

function extLang(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return ({ ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', py: 'python', rs: 'rust',
            go: 'go', md: 'markdown', json: 'json', sh: 'bash', html: 'html', css: 'css' }
          )[ext] ?? 'text';
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
  memory_save:  (o) => {
    const parts: string[] = [];
    const p = Number(o['playbooks'] ?? 0);
    const f = Number(o['facts'] ?? 0);
    const a = Number(o['anti_patterns'] ?? 0);
    const h = Number(o['heuristics'] ?? 0);
    if (p > 0) parts.push(`${p} playbook${p === 1 ? '' : 's'}`);
    if (f > 0) parts.push(`${f} fact${f === 1 ? '' : 's'}`);
    if (a > 0) parts.push(`${a} anti-pattern${a === 1 ? '' : 's'}`);
    if (h > 0) parts.push(`${h} heuristic${h === 1 ? '' : 's'}`);
    return parts.length > 0 ? parts.join(', ') : null;
  },
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

export interface Hunk {
  oldStart: number;
  newStart: number;
  lines: Array<{ kind: 'add' | 'del' | 'ctx'; text: string }>;
}

export type ResultView =
  | { kind: 'image';    src: string; alt?: string; meta?: string }
  | { kind: 'terminal'; stdout?: string; stderr?: string; exitCode?: number; durationMs?: number; streaming?: boolean }
  | { kind: 'markdown'; text: string }
  | { kind: 'kv';       entries: Array<[string, string]> }
  | { kind: 'error';    text: string; suggestion?: string }
  | { kind: 'empty' }
  | { kind: 'code';     path?: string; language?: string; text: string; startLine?: number; totalLines?: number; truncated?: boolean }
  | { kind: 'diff';     path: string; isNew?: boolean; hunks: Hunk[]; added: number; removed: number }
  | { kind: 'paths';    pattern?: string; matches: string[]; truncated?: boolean }
  | { kind: 'matches';  pattern: string; files: Array<{ path: string; line: number; snippet: string; matchStart?: number; matchEnd?: number }>; truncated?: boolean }
  | { kind: 'search';   query: string; results: Array<{ title: string; url: string; snippet?: string }> }
  | { kind: 'page';     url: string; title?: string; snippet?: string }
  | { kind: 'github';   repo: string; flavor: 'pr' | 'issue' | 'release' | 'commit'; number?: number | string; title?: string; state?: string; author?: string; stats?: { added: number; removed: number; files: number }; htmlUrl?: string }
  | { kind: 'click';    x: number; y: number; button?: string }
  | { kind: 'keypress'; keys: string[] }
  | { kind: 'typed';    text: string }
  | { kind: 'tasks';    items: Array<{ status: 'pending' | 'in_progress' | 'completed'; title: string }> }
  | { kind: 'notebook'; path: string; cellIndex?: number; cellType?: 'code' | 'markdown'; language?: string; text: string; op?: 'replace' | 'insert' | 'delete' }
  | { kind: 'tree';     value: unknown }
  | { kind: 'json';     value: unknown };

const DATA_URL_RE = /data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]+/;

function extractError(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const o = result as Record<string, unknown>;
    if (typeof o['error'] === 'string') return o['error'];
    if (typeof o['message'] === 'string') return o['message'];
  }
  try { return JSON.stringify(result); } catch { return String(result); }
}

function looksLikeShellResult(o: Record<string, unknown>): boolean {
  return 'stdout' in o || 'stderr' in o || 'exitCode' in o;
}

function looksLikeMarkdown(s: string): boolean {
  return /(^|\n)#+ /.test(s) || /(^|\n)[-*] /.test(s) || /\[[^\]]+\]\(/.test(s);
}

function isScalar(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

export function classifyResult(name: string, result: unknown, isError: boolean, input?: unknown): ResultView {
  if (isError) return { kind: 'error', text: extractError(result) };

  // Input-driven (results are typically empty for these tools)
  const bareNameForInput = parseMcpName(name)?.server === 'otto-tools'
    ? parseMcpName(name)!.tool
    : name;
  if (input && typeof input === 'object') {
    const i = input as Record<string, unknown>;
    switch (bareNameForInput) {
      case 'click':
      case 'double_click':
      case 'move':
        if (typeof i['x'] === 'number' && typeof i['y'] === 'number') {
          return { kind: 'click', x: i['x'], y: i['y'] };
        }
        break;
      case 'key':
        if (typeof i['combo'] === 'string') {
          return { kind: 'keypress', keys: i['combo'].split('+').map(s => s.trim()) };
        }
        break;
      case 'type':
        if (typeof i['text'] === 'string') return { kind: 'typed', text: i['text'] };
        break;
      case 'NotebookEdit': {
        if (typeof i['notebook_path'] === 'string' && typeof i['new_source'] === 'string') {
          const ct = i['cell_type'] === 'markdown' ? 'markdown' as const : 'code' as const;
          const op = i['edit_mode'] === 'insert' ? 'insert' as const
                   : i['edit_mode'] === 'delete' ? 'delete' as const : 'replace' as const;
          return {
            kind: 'notebook', path: String(i['notebook_path']),
            text: String(i['new_source']), cellType: ct, op,
            ...(typeof i['cell_id'] === 'number' || typeof i['cell_id'] === 'string'
              ? { cellIndex: Number(i['cell_id']) } : {}),
            language: ct === 'code' ? 'python' : 'markdown',
          };
        }
        break;
      }
      case 'TodoWrite':
      case 'TaskCreate':
      case 'TaskUpdate': {
        const todos = Array.isArray(i['todos']) ? i['todos'] : null;
        if (todos) {
          const items = todos
            .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
            .map(t => ({
              status: (t['status'] === 'in_progress' || t['status'] === 'completed')
                ? t['status'] as 'in_progress' | 'completed'
                : 'pending' as const,
              title: String(t['content'] ?? t['subject'] ?? t['title'] ?? ''),
            }));
          return { kind: 'tasks', items };
        }
        if (bareNameForInput === 'TaskCreate' && typeof i['subject'] === 'string') {
          return { kind: 'tasks', items: [{ status: 'pending', title: String(i['subject']) }] };
        }
        break;
      }
    }
    // Edit / Write — synthesize diff from inputs (result is a confirmation string)
    if (bareNameForInput === 'Write' && typeof i['file_path'] === 'string' && typeof i['content'] === 'string') {
      const lines = (i['content'] as string).split('\n');
      return {
        kind: 'diff', path: String(i['file_path']), isNew: true,
        added: lines.length, removed: 0,
        hunks: [{ oldStart: 0, newStart: 1, lines: lines.map(text => ({ kind: 'add' as const, text })) }],
      };
    }
    if (bareNameForInput === 'Edit'
        && typeof i['file_path'] === 'string'
        && typeof i['old_string'] === 'string'
        && typeof i['new_string'] === 'string') {
      const oldLines = (i['old_string'] as string).split('\n');
      const newLines = (i['new_string'] as string).split('\n');
      const hunk = diffLines(oldLines, newLines);
      const added = hunk.lines.filter(l => l.kind === 'add').length;
      const removed = hunk.lines.filter(l => l.kind === 'del').length;
      return { kind: 'diff', path: String(i['file_path']), isNew: false, added, removed, hunks: [hunk] };
    }
  }

  if (result == null || result === '') return { kind: 'empty' };

  // File tools — recognize by name (string results only)
  if (typeof result === 'string') {
    if (bareNameForInput === 'Read') {
      const lines = result.split('\n');
      const stripped: string[] = [];
      let startLine: number | undefined;
      for (const ln of lines) {
        const m = /^\s*(\d+)→(.*)$/.exec(ln);
        if (m) {
          if (startLine === undefined) startLine = Number(m[1]);
          stripped.push(m[2] ?? '');
        } else {
          stripped.push(ln);
        }
      }
      const path = typeof (input as Record<string, unknown> | undefined)?.['file_path'] === 'string'
        ? String((input as Record<string, unknown>)['file_path']) : undefined;
      return {
        kind: 'code', text: stripped.join('\n'),
        ...(path !== undefined ? { path, language: extLang(path) } : {}),
        ...(startLine !== undefined ? { startLine } : {}),
        totalLines: stripped.length,
      };
    }
    if (bareNameForInput === 'Glob') {
      const matches = result.split('\n').map(s => s.trim()).filter(Boolean);
      const pattern = typeof (input as Record<string, unknown> | undefined)?.['pattern'] === 'string'
        ? String((input as Record<string, unknown>)['pattern']) : undefined;
      return { kind: 'paths', matches, ...(pattern !== undefined ? { pattern } : {}) };
    }
    if (bareNameForInput === 'Grep') {
      const i = (input as Record<string, unknown> | undefined) ?? {};
      const pattern = String(i['pattern'] ?? '');
      const mode = String(i['output_mode'] ?? 'files_with_matches');
      if (mode === 'files_with_matches') {
        const matches = result.split('\n').map(s => s.trim()).filter(Boolean);
        return { kind: 'paths', pattern, matches };
      }
      if (mode === 'count') {
        const entries = result.split('\n').filter(Boolean)
          .map(l => l.split(':') as [string, string]);
        return { kind: 'kv', entries };
      }
      // content mode
      const files: Array<{ path: string; line: number; snippet: string }> = [];
      for (const line of result.split('\n')) {
        const m = /^([^:]+):(\d+):(.*)$/.exec(line);
        if (m) files.push({ path: m[1]!, line: Number(m[2]), snippet: m[3] ?? '' });
      }
      return { kind: 'matches', pattern, files };
    }
    if (bareNameForInput === 'WebSearch') {
      const query = typeof (input as Record<string, unknown> | undefined)?.['query'] === 'string'
        ? String((input as Record<string, unknown>)['query']) : '';
      const results: Array<{ title: string; url: string; snippet?: string }> = [];
      for (const line of result.split('\n')) {
        const m = /^\s*\d+\.\s+(.+?)\s+\(([^)]+)\)(?:\s+[—\-]\s+(.+))?$/.exec(line);
        if (m) {
          const title = m[1]!, url = m[2]!;
          const snippet = m[3];
          results.push(snippet !== undefined ? { title, url, snippet } : { title, url });
        }
      }
      if (results.length > 0) return { kind: 'search', query, results };
    }
    if (bareNameForInput === 'WebFetch') {
      const url = typeof (input as Record<string, unknown> | undefined)?.['url'] === 'string'
        ? String((input as Record<string, unknown>)['url']) : '';
      const m = /^\s*#\s+(.+)$/m.exec(result);
      const title = m?.[1]?.trim();
      const body = result.replace(/^\s*#.*$/m, '').trim();
      const snippet = body.split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 220);
      return { kind: 'page', url, ...(title !== undefined ? { title } : {}), snippet };
    }
  }

  // Built-in screenshot with file path (handles `screenshot` or `mcp__otto-tools__screenshot`).
  const parsed = parseMcpName(name);
  const bareName = parsed?.server === 'otto-tools' ? parsed.tool : name;
  if (bareName === 'screenshot' && typeof result === 'object' && result !== null && 'path' in (result as object)) {
    const r = result as { path: unknown; width?: unknown; height?: unknown };
    if (typeof r.path === 'string') {
      const meta = typeof r.width === 'number' && typeof r.height === 'number' ? `${r.width}×${r.height}` : undefined;
      return meta !== undefined
        ? { kind: 'image', src: `file://${r.path}`, meta }
        : { kind: 'image', src: `file://${r.path}` };
    }
  }

  // base64 data URL inside a string
  if (typeof result === 'string') {
    const m = DATA_URL_RE.exec(result);
    if (m) return { kind: 'image', src: m[0] };
    if (looksLikeMarkdown(result)) return { kind: 'markdown', text: result };
  }

  // image-ref blocks in content array (takes precedence over legacy inline-base64)
  if (typeof result === 'object' && result !== null && Array.isArray((result as { content?: unknown[] }).content)) {
    for (const block of (result as { content: unknown[] }).content) {
      if (
        typeof block === 'object' && block !== null &&
        (block as { type?: unknown }).type === 'image-ref'
      ) {
        const r = block as { id: string; sessionId: string; width?: number; height?: number };
        const meta = typeof r.width === 'number' && typeof r.height === 'number'
          ? `${r.width}×${r.height}` : undefined;
        return meta !== undefined
          ? { kind: 'image', src: `otto-image://${r.sessionId}/${r.id}.png`, meta }
          : { kind: 'image', src: `otto-image://${r.sessionId}/${r.id}.png` };
      }
    }
  }

  // SDK image content block
  if (Array.isArray(result)) {
    for (const block of result) {
      if (
        block && typeof block === 'object'
        && (block as { type?: unknown }).type === 'image'
      ) {
        const src = (block as { source?: { type?: string; media_type?: string; data?: string } }).source;
        if (src && src.type === 'base64' && src.media_type && src.data) {
          return { kind: 'image', src: `data:${src.media_type};base64,${src.data}` };
        }
      }
    }
  }

  if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
    const o = result as Record<string, unknown>;

    const parsedGh = parseMcpName(name);
    if (parsedGh && /github/i.test(parsedGh.server)) {
      const inObj = input && typeof input === 'object' ? input as Record<string, unknown> : null;
      const owner = inObj?.['owner'];
      const repoName = inObj?.['repo'];
      const repo = typeof owner === 'string' && typeof repoName === 'string'
        ? `${owner}/${repoName}`
        : (typeof o['full_name'] === 'string' ? o['full_name'] : 'repo');
      const flavor: 'pr' | 'issue' | 'release' | 'commit' =
        /pull_request|pull/.test(parsedGh.tool) ? 'pr' :
        /release/.test(parsedGh.tool) ? 'release' :
        /commit/.test(parsedGh.tool) ? 'commit' : 'issue';
      const userLogin = (o['user'] && typeof o['user'] === 'object')
        ? (o['user'] as Record<string, unknown>)['login']
        : undefined;
      const view: ResultView = {
        kind: 'github', flavor, repo,
        ...(o['number'] !== undefined ? { number: o['number'] as number } : {}),
        ...(typeof o['title'] === 'string' ? { title: o['title'] } : {}),
        ...(typeof o['state'] === 'string' ? { state: o['state'] } : {}),
        ...(typeof o['html_url'] === 'string' ? { htmlUrl: o['html_url'] } : {}),
        ...(typeof userLogin === 'string' ? { author: userLogin } : {}),
        ...(typeof o['additions'] === 'number' && typeof o['deletions'] === 'number'
          ? { stats: { added: o['additions'] as number, removed: o['deletions'] as number,
                       files: typeof o['changed_files'] === 'number' ? o['changed_files'] as number : 0 } } : {}),
      };
      return view;
    }

    if (looksLikeShellResult(o)) {
      const view: ResultView = { kind: 'terminal' };
      if (typeof o['stdout'] === 'string') view.stdout = o['stdout'];
      if (typeof o['stderr'] === 'string') view.stderr = o['stderr'];
      if (typeof o['exitCode'] === 'number') view.exitCode = o['exitCode'];
      if (typeof o['durationMs'] === 'number') view.durationMs = o['durationMs'];
      return view;
    }

    const entries = Object.entries(o);
    if (entries.length > 0 && entries.length <= 6 && entries.every(([, v]) => isScalar(v))) {
      return { kind: 'kv', entries: entries.map(([k, v]) => [k, v === null ? 'null' : String(v)]) };
    }
  }

  if (typeof result === 'object' && result !== null) {
    return { kind: 'tree', value: result };
  }
  return { kind: 'json', value: result };
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
