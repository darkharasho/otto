# Tool Card Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tool call cards across Otto's three UI surfaces (desktop main window, mobile remote, unfocused overlay feed) feel like a first-class part of the product — humanized titles, inline param summaries, and rich result renderers (images, terminals, markdown, KV tables) — driven by a single shared semantics module.

**Architecture:** A new pure (no-JSX) module `src/shared/tool-presenters.ts` exposes `describeTool(name)`, `summarizeInput(name, input)`, and `classifyResult(name, result, isError)`. The three surfaces import these to drive their own React rendering. A small per-surface `ToolIcon` component maps `IconName` → `lucide-react` glyph. Desktop and mobile share a `ToolResultRenderer` component; the overlay stays a one-line ticker.

**Tech Stack:** TypeScript, React 18, vitest + @testing-library/react, Tailwind CSS, lucide-react (already a dependency).

**Spec:** `docs/superpowers/specs/2026-05-25-tool-card-polish-design.md`

---

## File Structure

**New files:**
- `src/shared/tool-presenters.ts` — pure semantics (describeTool, summarizeInput, classifyResult)
- `src/shared/tool-presenters.test.ts` — unit tests for the semantics module
- `src/renderer/components/ToolIcon.tsx` — `IconName` → lucide component map
- `src/renderer/components/ToolResultRenderer.tsx` — renders a `ResultView` (image/terminal/markdown/kv/error/json/empty)
- `src/renderer/components/ToolResultRenderer.test.tsx` — component tests
- `src/renderer-remote/tool-icon.tsx` — same icon map for the mobile bundle (separate import root)
- `src/renderer-remote/tool-result-renderer.tsx` — mobile-tuned renderer
- `src/renderer-shared/markdown.tsx` — lifted markdown components (if importable from both renderers)

**Modified files:**
- `src/renderer/components/ToolCallCard.tsx` — rewrite using shared module
- `src/renderer/components/ToolCallCard.test.tsx` — extend
- `src/renderer-remote/chat.tsx` — rewrite inner `ToolCard`
- `src/renderer/OverlayApp.tsx` — switch to `describeTool` / `summarizeInput`

> **Note on shared markdown:** `src/renderer-remote` is bundled separately by `vite.config.pwa.ts`. Check before Task 9 whether `src/renderer-shared/*` is importable from both. If not, duplicate the file — it's ~25 lines.

---

## Task 1: Scaffold `tool-presenters.ts` with `describeTool` (built-ins)

**Files:**
- Create: `src/shared/tool-presenters.ts`
- Create: `src/shared/tool-presenters.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/shared/tool-presenters.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { describeTool } from './tool-presenters';

describe('describeTool — built-ins', () => {
  it('humanizes screenshot', () => {
    expect(describeTool('screenshot')).toEqual({ label: 'Screenshot', icon: 'camera' });
  });
  it('humanizes shell_exec', () => {
    expect(describeTool('shell_exec')).toEqual({ label: 'Run command', group: 'Shell', icon: 'terminal' });
  });
  it('humanizes click', () => {
    expect(describeTool('click')).toEqual({ label: 'Click', group: 'Input', icon: 'mouse' });
  });
  it('falls back to the raw name with a generic icon when unknown', () => {
    expect(describeTool('weird_tool_xyz')).toEqual({ label: 'weird_tool_xyz', icon: 'tool' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/shared/tool-presenters.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `describeTool` with the built-in table**

Create `src/shared/tool-presenters.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/shared/tool-presenters.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add src/shared/tool-presenters.ts src/shared/tool-presenters.test.ts
git commit -m "feat(presenters): describeTool for built-in tools"
```

---

## Task 2: Add MCP tool parsing to `describeTool`

**Files:**
- Modify: `src/shared/tool-presenters.ts`
- Modify: `src/shared/tool-presenters.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/tool-presenters.test.ts`:

```ts
describe('describeTool — MCP names', () => {
  it('parses mcp__github__create_pull_request', () => {
    expect(describeTool('mcp__github__create_pull_request')).toEqual({
      label: 'Create Pull Request',
      group: 'GitHub',
      icon: 'github',
    });
  });

  it('parses mcp__plugin_github_github__list_issues (strips plugin_ prefix)', () => {
    expect(describeTool('mcp__plugin_github_github__list_issues')).toEqual({
      label: 'List Issues',
      group: 'GitHub',
      icon: 'github',
    });
  });

  it('parses mcp__chrome-devtools-mcp__take_screenshot (strips -mcp suffix, picks camera)', () => {
    expect(describeTool('mcp__chrome-devtools-mcp__take_screenshot')).toEqual({
      label: 'Take Screenshot',
      group: 'Chrome DevTools',
      icon: 'camera',
    });
  });

  it('falls through to built-ins for mcp__otto-tools__shell_exec', () => {
    expect(describeTool('mcp__otto-tools__shell_exec')).toEqual({
      label: 'Run command',
      group: 'Shell',
      icon: 'terminal',
    });
  });

  it('handles unknown MCP server + tool with a sensible fallback', () => {
    expect(describeTool('mcp__some_server__do_thing')).toEqual({
      label: 'Do Thing',
      group: 'Some Server',
      icon: 'plug',
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/shared/tool-presenters.test.ts`
Expected: 5 new tests FAIL.

- [ ] **Step 3: Implement MCP parsing**

Replace the body of `describeTool` and add helpers in `src/shared/tool-presenters.ts`:

```ts
const GROUP_OVERRIDES: Record<string, string> = {
  github: 'GitHub',
  'chrome-devtools-mcp': 'Chrome DevTools',
  'chrome-devtools': 'Chrome DevTools',
  playwright: 'Playwright',
};

const ICON_BY_SUBSTRING: Array<[RegExp, IconName]> = [
  [/screenshot/i,                      'camera'],
  [/(^|_)(read|get_file|list_file)/i,  'file'],
  [/(^|_)(edit|write|update_file)/i,   'edit'],
  [/(^|_)search/i,                     'search'],
  [/(^|_)(fetch|navigate|http)/i,      'globe'],
  [/(^|_)(click|hover|drag|move)/i,    'mouse'],
  [/(^|_)(type|press_key|fill)/i,      'keyboard'],
  [/github|pull_request|issue|branch/i,'github'],
  [/(^|_)(sql|query|db|database)/i,    'database'],
  [/(image|png|jpg)/i,                 'image'],
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/shared/tool-presenters.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/tool-presenters.ts src/shared/tool-presenters.test.ts
git commit -m "feat(presenters): MCP tool name parsing"
```

---

## Task 3: Add `summarizeInput`

**Files:**
- Modify: `src/shared/tool-presenters.ts`
- Modify: `src/shared/tool-presenters.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/tool-presenters.test.ts`:

```ts
import { summarizeInput } from './tool-presenters';

describe('summarizeInput', () => {
  it('shell_exec → command', () => {
    expect(summarizeInput('shell_exec', { command: 'pnpm test' })).toBe('pnpm test');
  });
  it('click → x, y', () => {
    expect(summarizeInput('click', { x: 100, y: 200 })).toBe('100, 200');
  });
  it('type → quoted truncated text', () => {
    expect(summarizeInput('type', { text: 'hello world' })).toBe('"hello world"');
  });
  it('key → combo', () => {
    expect(summarizeInput('key', { combo: 'cmd+shift+p' })).toBe('cmd+shift+p');
  });
  it('screenshot → window/region/full', () => {
    expect(summarizeInput('screenshot', { window: 'Safari' })).toBe('Safari');
    expect(summarizeInput('screenshot', { region: { x:0,y:0,w:1,h:1 } })).toBe('region');
    expect(summarizeInput('screenshot', {})).toBe('full');
  });
  it('web_search → quoted query', () => {
    expect(summarizeInput('web_search', { query: 'react portals' })).toBe('"react portals"');
  });
  it('web_fetch → hostname', () => {
    expect(summarizeInput('web_fetch', { url: 'https://example.com/path' })).toBe('example.com');
  });
  it('mcp__plugin_github_github__create_pull_request → repo · "title"', () => {
    expect(summarizeInput(
      'mcp__plugin_github_github__create_pull_request',
      { owner: 'darkharasho', repo: 'otto', title: 'polish: tool cards' },
    )).toBe('darkharasho/otto · "polish: tool cards"');
  });
  it('truncates long strings', () => {
    const long = 'x'.repeat(200);
    const out = summarizeInput('shell_exec', { command: long }, 40);
    expect(out!.length).toBeLessThanOrEqual(40);
    expect(out!.endsWith('…')).toBe(true);
  });
  it('returns null for unknown tools with no extractable input', () => {
    expect(summarizeInput('weird_tool', { weird: { nested: 1 } })).toBeNull();
  });
  it('returns first string-ish field for unknown MCP tools', () => {
    expect(summarizeInput('mcp__some__do_thing', { query: 'hello' })).toBe('hello');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/shared/tool-presenters.test.ts`
Expected: 11 new tests FAIL.

- [ ] **Step 3: Implement `summarizeInput`**

Append to `src/shared/tool-presenters.ts`:

```ts
function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

type Summarizer = (input: Record<string, unknown>, max: number) => string | null;

const SUMMARIZERS: Record<string, Summarizer> = {
  shell_exec:   (o, m) => truncate(String(o.command ?? ''), m) || null,
  shell_spawn:  (o, m) => truncate(String(o.command ?? ''), m) || null,
  click:        (o)    => o.x !== undefined && o.y !== undefined ? `${o.x}, ${o.y}` : null,
  double_click: (o)    => o.x !== undefined && o.y !== undefined ? `${o.x}, ${o.y}` : null,
  move:         (o)    => o.x !== undefined && o.y !== undefined ? `${o.x}, ${o.y}` : null,
  type:         (o, m) => o.text != null ? `"${truncate(String(o.text), Math.max(8, m - 2))}"` : null,
  key:          (o)    => asString(o.combo),
  screenshot:   (o)    => o.window ? String(o.window) : o.region ? 'region' : 'full',
  knowledge_append: (o, m) => truncate(String(o.note ?? ''), m) || null,
  web_search:   (o, m) => o.query != null ? `"${truncate(String(o.query), Math.max(8, m - 2))}"` : null,
  web_fetch:    (o)    => {
    const u = asString(o.url);
    if (!u) return null;
    try { return new URL(u).hostname; } catch { return u; }
  },
};

function mcpSummary(tool: string, o: Record<string, unknown>, max: number): string | null {
  // GitHub-flavored heuristics first.
  const isPr = /pull_request|create_pr/i.test(tool);
  if (isPr && o.owner && o.repo && o.title) {
    return truncate(`${o.owner}/${o.repo} · "${o.title}"`, max);
  }
  if (o.owner && o.repo) return `${o.owner}/${o.repo}`;
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
    if (parsed.server === 'otto-tools' && SUMMARIZERS[parsed.tool]) {
      return SUMMARIZERS[parsed.tool](obj, maxLen);
    }
    return mcpSummary(parsed.tool, obj, maxLen);
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/shared/tool-presenters.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/tool-presenters.ts src/shared/tool-presenters.test.ts
git commit -m "feat(presenters): summarizeInput across tool families"
```

---

## Task 4: Add `classifyResult`

**Files:**
- Modify: `src/shared/tool-presenters.ts`
- Modify: `src/shared/tool-presenters.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/tool-presenters.test.ts`:

```ts
import { classifyResult } from './tool-presenters';

describe('classifyResult', () => {
  it('isError → error kind', () => {
    expect(classifyResult('shell_exec', 'boom', true)).toEqual({ kind: 'error', text: 'boom' });
  });
  it('null result → empty', () => {
    expect(classifyResult('whatever', null, false)).toEqual({ kind: 'empty' });
  });
  it('screenshot with path → image (file://)', () => {
    expect(classifyResult('screenshot', { path: '/tmp/a.png', width: 100, height: 50 }, false)).toEqual({
      kind: 'image',
      src: 'file:///tmp/a.png',
      meta: '100×50',
    });
  });
  it('base64 data URL in string → image', () => {
    const data = 'data:image/png;base64,iVBORw0KGgoAAA';
    expect(classifyResult('mcp__cdt__take_screenshot', data, false)).toEqual({
      kind: 'image',
      src: data,
    });
  });
  it('SDK image content block → image', () => {
    const block = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }];
    expect(classifyResult('mcp__cdt__take_screenshot', block, false)).toEqual({
      kind: 'image',
      src: 'data:image/png;base64,AAAA',
    });
  });
  it('shell-shaped result → terminal', () => {
    expect(classifyResult('shell_exec', { stdout: 'ok\n', stderr: '', exitCode: 0 }, false)).toEqual({
      kind: 'terminal',
      stdout: 'ok\n',
      stderr: '',
      exitCode: 0,
    });
  });
  it('markdown-ish string → markdown', () => {
    expect(classifyResult('web_fetch', '# Hi\n\n- one\n- two', false)).toEqual({
      kind: 'markdown',
      text: '# Hi\n\n- one\n- two',
    });
  });
  it('small flat object → kv', () => {
    expect(classifyResult('mcp__github__create_pr', { number: 287, url: 'x', state: 'open' }, false)).toEqual({
      kind: 'kv',
      entries: [['number', '287'], ['url', 'x'], ['state', 'open']],
    });
  });
  it('nested object → json fallback', () => {
    const big = { a: { b: { c: 1 } } };
    expect(classifyResult('whatever', big, false)).toEqual({ kind: 'json', value: big });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/shared/tool-presenters.test.ts`
Expected: 9 new tests FAIL.

- [ ] **Step 3: Implement `classifyResult`**

Append to `src/shared/tool-presenters.ts`:

```ts
export type ResultView =
  | { kind: 'image';    src: string; alt?: string; meta?: string }
  | { kind: 'terminal'; stdout?: string; stderr?: string; exitCode?: number; durationMs?: number }
  | { kind: 'markdown'; text: string }
  | { kind: 'kv';       entries: Array<[string, string]> }
  | { kind: 'error';    text: string }
  | { kind: 'empty' }
  | { kind: 'json';     value: unknown };

const DATA_URL_RE = /data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]+/;

function extractError(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const o = result as Record<string, unknown>;
    if (typeof o.error === 'string') return o.error;
    if (typeof o.message === 'string') return o.message;
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

export function classifyResult(name: string, result: unknown, isError: boolean): ResultView {
  if (isError) return { kind: 'error', text: extractError(result) };
  if (result == null || result === '') return { kind: 'empty' };

  // Built-in screenshot with file path
  const parsed = parseMcpName(name);
  const bareName = parsed?.server === 'otto-tools' ? parsed.tool : name;
  if (bareName === 'screenshot' && typeof result === 'object' && result && 'path' in (result as object)) {
    const r = result as { path: unknown; width?: unknown; height?: unknown };
    if (typeof r.path === 'string') {
      const meta = typeof r.width === 'number' && typeof r.height === 'number' ? `${r.width}×${r.height}` : undefined;
      return { kind: 'image', src: `file://${r.path}`, meta };
    }
  }

  // base64 data URL inside a string
  if (typeof result === 'string') {
    const m = DATA_URL_RE.exec(result);
    if (m) return { kind: 'image', src: m[0] };
    if (looksLikeMarkdown(result)) return { kind: 'markdown', text: result };
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

  if (typeof result === 'object' && !Array.isArray(result)) {
    const o = result as Record<string, unknown>;

    if (looksLikeShellResult(o)) {
      return {
        kind: 'terminal',
        stdout: typeof o.stdout === 'string' ? o.stdout : undefined,
        stderr: typeof o.stderr === 'string' ? o.stderr : undefined,
        exitCode: typeof o.exitCode === 'number' ? o.exitCode : undefined,
        durationMs: typeof o.durationMs === 'number' ? o.durationMs : undefined,
      };
    }

    const entries = Object.entries(o);
    if (entries.length > 0 && entries.length <= 6 && entries.every(([, v]) => isScalar(v))) {
      return { kind: 'kv', entries: entries.map(([k, v]) => [k, v === null ? 'null' : String(v)]) };
    }
  }

  return { kind: 'json', value: result };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/shared/tool-presenters.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/tool-presenters.ts src/shared/tool-presenters.test.ts
git commit -m "feat(presenters): classifyResult with image/terminal/markdown/kv kinds"
```

---

## Task 5: `ToolIcon` component for desktop renderer

**Files:**
- Create: `src/renderer/components/ToolIcon.tsx`

- [ ] **Step 1: Write the component**

`src/renderer/components/ToolIcon.tsx`:

```tsx
import type { IconName } from '@shared/tool-presenters';
import {
  Camera, Terminal, FileEdit, FileText, Search, Globe,
  MousePointer, Keyboard, Github, Database, Image, Brain, Plug, Wrench,
} from 'lucide-react';

const MAP: Record<IconName, React.ComponentType<{ className?: string }>> = {
  camera: Camera,
  terminal: Terminal,
  edit: FileEdit,
  file: FileText,
  search: Search,
  globe: Globe,
  mouse: MousePointer,
  keyboard: Keyboard,
  github: Github,
  database: Database,
  image: Image,
  brain: Brain,
  plug: Plug,
  tool: Wrench,
};

export function ToolIcon({ name, className }: { name: IconName; className?: string }) {
  const Cmp = MAP[name] ?? Wrench;
  return <Cmp className={className ?? 'w-3.5 h-3.5'} />;
}
```

> **Note:** Verify the `@shared` path alias resolves in `tsconfig.json`/`electron.vite.config.ts`. If not, use the relative path `../../shared/tool-presenters`.

- [ ] **Step 2: Commit (no tests — pure presentation glue)**

```bash
git add src/renderer/components/ToolIcon.tsx
git commit -m "feat(toolcard): ToolIcon mapping for desktop"
```

---

## Task 6: `ToolResultRenderer` component (desktop)

**Files:**
- Create: `src/renderer/components/ToolResultRenderer.tsx`
- Create: `src/renderer/components/ToolResultRenderer.test.tsx`

- [ ] **Step 1: Write the failing tests**

`src/renderer/components/ToolResultRenderer.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolResultRenderer } from './ToolResultRenderer';

describe('ToolResultRenderer', () => {
  it('renders an <img> for image kind', () => {
    render(<ToolResultRenderer view={{ kind: 'image', src: 'data:image/png;base64,AAAA' }} />);
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', 'data:image/png;base64,AAAA');
  });

  it('renders stdout and exit code for terminal kind', () => {
    render(<ToolResultRenderer view={{ kind: 'terminal', stdout: 'hello', exitCode: 0 }} />);
    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(screen.getByText(/exited 0/i)).toBeInTheDocument();
  });

  it('renders kv entries as a definition list', () => {
    render(<ToolResultRenderer view={{ kind: 'kv', entries: [['number', '287'], ['state', 'open']] }} />);
    expect(screen.getByText('number')).toBeInTheDocument();
    expect(screen.getByText('287')).toBeInTheDocument();
  });

  it('renders error text for error kind', () => {
    render(<ToolResultRenderer view={{ kind: 'error', text: 'nope' }} />);
    expect(screen.getByText('nope')).toBeInTheDocument();
  });

  it('renders nothing for empty kind', () => {
    const { container } = render(<ToolResultRenderer view={{ kind: 'empty' }} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a <pre> JSON dump for json kind', () => {
    render(<ToolResultRenderer view={{ kind: 'json', value: { a: 1 } }} />);
    expect(screen.getByText(/"a": 1/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/renderer/components/ToolResultRenderer.test.tsx`
Expected: module not found, FAIL.

- [ ] **Step 3: Implement the component**

`src/renderer/components/ToolResultRenderer.tsx`:

```tsx
import type { ResultView } from '@shared/tool-presenters';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props { view: ResultView }

export function ToolResultRenderer({ view }: Props) {
  switch (view.kind) {
    case 'empty':
      return null;
    case 'image':
      return (
        <div>
          <img src={view.src} alt={view.alt ?? 'tool result'} loading="lazy"
               className="max-w-full rounded border border-border" />
          {view.meta && <div className="text-[10.5px] text-muted mt-1">{view.meta}</div>}
        </div>
      );
    case 'terminal': {
      const exit = view.exitCode;
      const exitClass = exit === undefined ? 'text-muted' : exit === 0 ? 'text-accent' : 'text-danger';
      return (
        <div className="rounded bg-bg/80 p-2.5 font-mono text-[11px] leading-relaxed">
          {view.stdout && <pre className="whitespace-pre-wrap break-words m-0">{view.stdout}</pre>}
          {view.stderr && <pre className="whitespace-pre-wrap break-words m-0 text-danger">{view.stderr}</pre>}
          {exit !== undefined && (
            <div className={`text-[10px] mt-1.5 ${exitClass}`}>
              ↳ exited {exit}{view.durationMs ? ` · ${view.durationMs}ms` : ''}
            </div>
          )}
        </div>
      );
    }
    case 'markdown':
      return (
        <div className="prose-sm">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{view.text}</ReactMarkdown>
        </div>
      );
    case 'kv':
      return (
        <dl className="grid grid-cols-[max-content,1fr] gap-x-3 gap-y-1 font-mono text-[11.5px]">
          {view.entries.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="break-all">{v}</dd>
            </div>
          ))}
        </dl>
      );
    case 'error':
      return (
        <div className="rounded border border-danger/40 bg-danger/10 text-danger px-2.5 py-2 text-xs">
          {view.text}
        </div>
      );
    case 'json':
      return (
        <pre className="bg-bg/60 rounded p-2 overflow-x-auto text-[11px]">
          {JSON.stringify(view.value, null, 2)}
        </pre>
      );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/renderer/components/ToolResultRenderer.test.tsx`
Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/ToolResultRenderer.tsx src/renderer/components/ToolResultRenderer.test.tsx
git commit -m "feat(toolcard): ToolResultRenderer for desktop"
```

---

## Task 7: Rewrite desktop `ToolCallCard` to use the new pieces

**Files:**
- Modify: `src/renderer/components/ToolCallCard.tsx`
- Modify: `src/renderer/components/ToolCallCard.test.tsx`

- [ ] **Step 1: Update existing tests + add new ones**

Replace `src/renderer/components/ToolCallCard.test.tsx` with:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToolCallCard } from './ToolCallCard';

describe('ToolCallCard — humanization', () => {
  it('shows humanized label and group for an MCP tool', () => {
    render(<ToolCallCard name="mcp__github__create_pull_request" input={{}} result={undefined} isError={false} />);
    expect(screen.getByText('Create Pull Request')).toBeInTheDocument();
    expect(screen.getByText('GitHub')).toBeInTheDocument();
  });

  it('shows an inline summary line for shell_exec', () => {
    render(<ToolCallCard name="shell_exec" input={{ command: 'pnpm test' }} result={undefined} isError={false} />);
    expect(screen.getByText('pnpm test')).toBeInTheDocument();
  });
});

describe('ToolCallCard — status', () => {
  it('shows running when no result', () => {
    render(<ToolCallCard name="echo" input={{}} result={undefined} isError={false} />);
    expect(screen.getByText(/running/i)).toBeInTheDocument();
  });
  it('shows done with result', () => {
    render(<ToolCallCard name="echo" input={{}} result="hi" isError={false} />);
    expect(screen.getByText(/done/i)).toBeInTheDocument();
  });
  it('shows error status when isError', () => {
    render(<ToolCallCard name="echo" input={{}} result="oops" isError={true} />);
    expect(screen.getByText(/error/i)).toBeInTheDocument();
  });
});

describe('ToolCallCard — result rendering', () => {
  it('renders an <img> for the built-in screenshot tool', async () => {
    render(
      <ToolCallCard
        name="screenshot"
        input={{}}
        result={{ path: '/tmp/a.png', width: 1920, height: 1080 }}
        isError={false}
      />,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('img')).toHaveAttribute('src', 'file:///tmp/a.png');
  });

  it('renders an <img> for an MCP tool returning a base64 data URL', async () => {
    render(
      <ToolCallCard
        name="mcp__chrome-devtools-mcp__take_screenshot"
        input={{}}
        result="data:image/png;base64,AAAA"
        isError={false}
      />,
    );
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('img')).toHaveAttribute('src', 'data:image/png;base64,AAAA');
  });

  it('renders shell stdout as a terminal block', async () => {
    render(<ToolCallCard name="shell_exec" input={{ command: 'echo hi' }} result={{ stdout: 'hi\n', exitCode: 0 }} isError={false} />);
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByText('hi')).toBeInTheDocument();
    expect(screen.getByText(/exited 0/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm test src/renderer/components/ToolCallCard.test.tsx`
Expected: some new tests FAIL (raw name shown, no summary line, no MCP image).

- [ ] **Step 3: Rewrite `ToolCallCard.tsx`**

Replace `src/renderer/components/ToolCallCard.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { describeTool, summarizeInput, classifyResult } from '@shared/tool-presenters';
import { ToolIcon } from './ToolIcon';
import { ToolResultRenderer } from './ToolResultRenderer';

interface Props {
  name: string;
  input: unknown;
  result: unknown;
  isError: boolean;
}

export function ToolCallCard({ name, input, result, isError }: Props) {
  const [open, setOpen] = useState(false);
  const status: 'running' | 'done' | 'error' =
    result === undefined ? 'running' : isError ? 'error' : 'done';

  const desc = describeTool(name);
  const summary = summarizeInput(name, input);
  const view = result === undefined ? null : classifyResult(name, result, isError);

  const statusColor = {
    running: 'text-muted',
    done: 'text-accent',
    error: 'text-danger',
  }[status];

  const wasRunning = useRef(status === 'running');
  const [justFinished, setJustFinished] = useState(false);
  useEffect(() => {
    if (wasRunning.current && status === 'done') {
      setJustFinished(true);
      const t = setTimeout(() => setJustFinished(false), 700);
      return () => clearTimeout(t);
    }
    wasRunning.current = status === 'running';
  }, [status]);

  const detailsRef = useRef<HTMLDivElement>(null);
  const [detailsHeight, setDetailsHeight] = useState(0);
  useEffect(() => {
    if (!detailsRef.current) return;
    const el = detailsRef.current;
    const ro = new ResizeObserver(() => setDetailsHeight(el.scrollHeight));
    ro.observe(el);
    setDetailsHeight(el.scrollHeight);
    return () => ro.disconnect();
  }, [open, view]);

  return (
    <div className="my-2 rounded-lg border border-border bg-bg/40 overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-surface/40 transition-colors"
      >
        <span className="flex items-center gap-2.5 min-w-0 flex-1">
          <span className="w-6 h-6 rounded-md bg-accent/10 text-accent flex items-center justify-center flex-shrink-0">
            <ToolIcon name={desc.icon} className="w-3.5 h-3.5" />
          </span>
          <span className="flex flex-col min-w-0">
            <span className="flex items-baseline gap-1.5">
              {desc.group && (
                <span className="text-[10px] uppercase tracking-wide text-muted font-semibold">{desc.group}</span>
              )}
              <span className="font-medium truncate">{desc.label}</span>
            </span>
            {summary && (
              <span className="font-mono text-[11px] text-muted truncate">{summary}</span>
            )}
          </span>
        </span>
        <span className="flex items-center gap-2 flex-shrink-0">
          <StatusGlyph status={status} justFinished={justFinished} />
          <span className={`uppercase tracking-wide text-[10px] ${statusColor}`}>{status}</span>
          <svg
            viewBox="0 0 24 24"
            className={`w-3 h-3 text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
            fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>
      <div
        style={{ maxHeight: open ? detailsHeight : 0 }}
        className="transition-[max-height] duration-200 ease-out overflow-hidden"
      >
        <div
          ref={detailsRef}
          data-testid="toolcall-details"
          className="px-3 pb-3 text-xs space-y-3 border-t border-border/40 pt-3"
        >
          {input !== undefined && input !== null && (
            <div>
              <div className="text-muted mb-1 text-[10px] uppercase tracking-wide">Input</div>
              <pre className="bg-bg/60 rounded p-2 overflow-x-auto font-mono text-[11px]">
                {JSON.stringify(input, null, 2)}
              </pre>
            </div>
          )}
          {view && view.kind !== 'empty' && (
            <div>
              <div className="text-muted mb-1 text-[10px] uppercase tracking-wide">Result</div>
              <ToolResultRenderer view={view} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusGlyph({ status, justFinished }: { status: 'running' | 'done' | 'error'; justFinished: boolean }) {
  if (status === 'running') {
    return (
      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-muted otto-spin"
           fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    );
  }
  if (status === 'error') {
    return (
      <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-danger"
           fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={`w-3.5 h-3.5 text-accent ${justFinished ? 'otto-pop' : ''}`}
         fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/renderer/components/ToolCallCard.test.tsx`
Expected: PASS, all tests.

- [ ] **Step 5: Run typecheck and full test suite**

```bash
pnpm typecheck
pnpm test
```

Expected: no type errors; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/ToolCallCard.tsx src/renderer/components/ToolCallCard.test.tsx
git commit -m "feat(toolcard): polish desktop tool card with shared semantics"
```

---

## Task 8: Mobile `ToolCard` rewrite

**Files:**
- Create: `src/renderer-remote/tool-icon.tsx`
- Create: `src/renderer-remote/tool-result-renderer.tsx`
- Modify: `src/renderer-remote/chat.tsx` (inner `ToolCard` only)

> **Note:** `src/shared/tool-presenters.ts` has no JSX and no Electron-only deps, so it should import cleanly into the PWA bundle. Confirm by checking `vite.config.pwa.ts` resolves `src/shared` (it should — same monorepo root).

- [ ] **Step 1: Add the mobile icon map**

Create `src/renderer-remote/tool-icon.tsx`:

```tsx
import type { IconName } from '../shared/tool-presenters';
import {
  Camera, Terminal, FileEdit, FileText, Search, Globe,
  MousePointer, Keyboard, Github, Database, Image, Brain, Plug, Wrench,
} from 'lucide-react';

const MAP: Record<IconName, React.ComponentType<{ className?: string }>> = {
  camera: Camera, terminal: Terminal, edit: FileEdit, file: FileText,
  search: Search, globe: Globe, mouse: MousePointer, keyboard: Keyboard,
  github: Github, database: Database, image: Image, brain: Brain, plug: Plug, tool: Wrench,
};

export function ToolIcon({ name, className }: { name: IconName; className?: string }) {
  const Cmp = MAP[name] ?? Wrench;
  return <Cmp className={className ?? 'w-3 h-3'} />;
}
```

- [ ] **Step 2: Add the mobile result renderer**

Create `src/renderer-remote/tool-result-renderer.tsx`:

```tsx
import type { ResultView } from '../shared/tool-presenters';

export function ToolResultRenderer({ view }: { view: ResultView }) {
  switch (view.kind) {
    case 'empty':
      return null;
    case 'image':
      return (
        <div>
          <img src={view.src} alt="tool result" loading="lazy"
               className="block max-w-full rounded border border-border" />
          {view.meta && <div className="text-[10px] text-muted mt-1">{view.meta}</div>}
        </div>
      );
    case 'terminal': {
      const exit = view.exitCode;
      const exitClass = exit === undefined ? 'text-muted' : exit === 0 ? 'text-emerald-500' : 'text-danger';
      return (
        <div className="rounded bg-bg/80 p-2 font-mono text-[10px] leading-relaxed">
          {view.stdout && <pre className="whitespace-pre-wrap break-words m-0">{view.stdout}</pre>}
          {view.stderr && <pre className="whitespace-pre-wrap break-words m-0 text-danger">{view.stderr}</pre>}
          {exit !== undefined && (
            <div className={`text-[10px] mt-1 ${exitClass}`}>↳ exited {exit}</div>
          )}
        </div>
      );
    }
    case 'kv':
      return (
        <dl className="grid grid-cols-[max-content,1fr] gap-x-2 gap-y-0.5 font-mono text-[10.5px]">
          {view.entries.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="break-all">{v}</dd>
            </div>
          ))}
        </dl>
      );
    case 'error':
      return (
        <div className="rounded border border-danger/40 bg-danger/10 text-danger px-2 py-1.5 text-[11px]">
          {view.text}
        </div>
      );
    case 'markdown':
      return <div className="text-[11px] whitespace-pre-wrap break-words">{view.text}</div>;
    case 'json':
      return (
        <pre className="bg-bg/60 rounded p-2 overflow-x-auto text-[10px] whitespace-pre-wrap break-words">
          {JSON.stringify(view.value, null, 2)}
        </pre>
      );
  }
}
```

> Markdown intentionally renders as plain text on mobile to avoid pulling `react-markdown` into the PWA bundle. If we want true markdown later, lift the imports — but that's out of scope.

- [ ] **Step 3: Rewrite the inner `ToolCard` in `chat.tsx`**

In `src/renderer-remote/chat.tsx`, replace the `ToolCard` function (currently lines 68–125) with:

```tsx
import { describeTool, summarizeInput, classifyResult } from '../shared/tool-presenters';
import { ToolIcon } from './tool-icon';
import { ToolResultRenderer } from './tool-result-renderer';

function ToolCard({ item }: { item: ToolItem }): JSX.Element {
  const [open, setOpen] = useState(false);
  const status =
    item.status === 'pending' ? 'running'
    : item.status === 'denied' ? 'denied'
    : item.isError ? 'error'
    : 'done';
  const statusLabel = status === 'running' ? '…' : status;
  const statusClass =
    status === 'running' ? 'text-muted'
    : status === 'done' ? 'text-emerald-500'
    : 'text-danger';

  const desc = describeTool(item.name);
  const summary = summarizeInput(item.name, item.input);
  const view = item.result === undefined ? null : classifyResult(item.name, item.result, Boolean(item.isError));

  return (
    <div className="rounded-md border border-border bg-surface overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-2.5 py-2 text-xs min-h-[44px] hover:bg-bg/40"
      >
        <span className="flex items-center gap-2 min-w-0 flex-1">
          <span className="w-5 h-5 rounded bg-accent/10 text-accent flex items-center justify-center flex-shrink-0">
            <ToolIcon name={desc.icon} className="w-3 h-3" />
          </span>
          <span className="flex flex-col min-w-0 text-left">
            <span className="flex items-baseline gap-1.5">
              {desc.group && (
                <span className="text-[9px] uppercase tracking-wide text-muted font-semibold">{desc.group}</span>
              )}
              <span className="font-semibold truncate">{desc.label}</span>
            </span>
            {summary && (
              <span className="font-mono text-[10px] text-muted truncate">{summary}</span>
            )}
          </span>
        </span>
        <span className="flex items-center gap-1.5 flex-shrink-0">
          <span className={`uppercase tracking-wide text-[10px] ${statusClass}`}>{statusLabel}</span>
          <svg
            viewBox="0 0 24 24"
            className={`w-3 h-3 text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
            fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>
      {open && (
        <div className="px-2.5 pb-2.5 space-y-2 border-t border-border/40 pt-2 text-[11px]">
          {item.input !== undefined && item.input !== null && (
            <div>
              <div className="text-muted mb-1 text-[9px] uppercase tracking-wide">Input</div>
              <pre className="bg-bg/60 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[10px]">
                {JSON.stringify(item.input, null, 2)}
              </pre>
            </div>
          )}
          {view && view.kind !== 'empty' && (
            <div>
              <div className="text-muted mb-1 text-[9px] uppercase tracking-wide">Result</div>
              <ToolResultRenderer view={view} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Verify build + typecheck**

```bash
pnpm typecheck
pnpm build:pwa
```

Expected: no errors.

- [ ] **Step 5: Run full test suite**

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer-remote/tool-icon.tsx src/renderer-remote/tool-result-renderer.tsx src/renderer-remote/chat.tsx
git commit -m "feat(toolcard): polish mobile tool card"
```

---

## Task 9: Update overlay feed (`OverlayApp.tsx`)

**Files:**
- Modify: `src/renderer/OverlayApp.tsx`

- [ ] **Step 1: Switch to shared presenters**

In `src/renderer/OverlayApp.tsx`:

1. Add import at top: `import { describeTool, summarizeInput } from '@shared/tool-presenters';`
2. Add import: `import { ToolIcon } from './components/ToolIcon';`
3. Delete the local `stripToolPrefix` and `toolDetail` functions (lines 17–48).
4. Update the relevant cases in `toStep` (around lines 57–67) to use the shared presenters and carry the icon:

Replace:

```ts
case 'tool-call-start': {
  const name = stripToolPrefix(ev.name);
  return { id: `c${idSeed}`, kind: 'tool', label: name, detail: toolDetail(name, ev.input) };
}
case 'tool-call-pending': {
  const name = stripToolPrefix(ev.name);
  return { id: `p${idSeed}`, kind: 'pending', label: `awaiting approval`, detail: name };
}
case 'tool-call-denied': {
  const name = stripToolPrefix(ev.name);
  return { id: `d${idSeed}`, kind: 'denied', label: `denied`, detail: name };
}
```

With:

```ts
case 'tool-call-start': {
  const desc = describeTool(ev.name);
  return {
    id: `c${idSeed}`, kind: 'tool',
    label: desc.label, group: desc.group, icon: desc.icon,
    detail: summarizeInput(ev.name, ev.input) ?? undefined,
  };
}
case 'tool-call-pending': {
  const desc = describeTool(ev.name);
  return {
    id: `p${idSeed}`, kind: 'pending', label: 'awaiting approval',
    detail: desc.group ? `${desc.group} · ${desc.label}` : desc.label,
  };
}
case 'tool-call-denied': {
  const desc = describeTool(ev.name);
  return {
    id: `d${idSeed}`, kind: 'denied', label: 'denied',
    detail: desc.group ? `${desc.group} · ${desc.label}` : desc.label,
  };
}
```

5. Extend the `Step` interface to carry the optional icon + group:

```ts
import type { IconName } from '@shared/tool-presenters';

interface Step {
  id: string;
  kind: StepKind;
  label: string;
  detail?: string;
  group?: string;
  icon?: IconName;
}
```

6. Update the `StepRow` rendering for the `tool` kind (the default branch at lines 105–110) to show icon + group:

Replace the final `return` in `StepRow` with:

```tsx
return (
  <div className="otto-step-enter flex gap-2 items-center py-1 min-w-0">
    {step.icon && <ToolIcon name={step.icon} className="w-3 h-3 text-muted shrink-0" />}
    {step.group && (
      <span className="text-[10px] uppercase tracking-wide text-muted shrink-0">{step.group}</span>
    )}
    <span className="font-medium text-[11.5px] text-text shrink-0">{step.label}</span>
    {step.detail && <span className="font-mono text-[11px] text-text/60 truncate">{step.detail}</span>}
  </div>
);
```

- [ ] **Step 2: Build and visually verify**

```bash
pnpm typecheck
pnpm dev
```

Trigger a session that fires a few tool calls (e.g. ask Otto to take a screenshot and run a shell command). Confirm the overlay feed shows: icon · group · label · summary instead of raw `mcp__otto-tools__screenshot`.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/OverlayApp.tsx
git commit -m "feat(overlay): use shared tool presenters for friendly labels"
```

---

## Task 10: End-to-end smoke + final cleanup

**Files:**
- Modify: any small follow-ups discovered during smoke

- [ ] **Step 1: Run the full test + typecheck + lint matrix**

```bash
pnpm typecheck
pnpm test
pnpm lint
```

Expected: all pass.

- [ ] **Step 2: Run the integration smoke test**

```bash
pnpm test:integration -- tests/integration/smoke.spec.ts
```

Expected: PASS. If the smoke test asserts on tool-card text it may need an update — adjust selectors to match the new humanized labels, then re-run.

- [ ] **Step 3: Manual smoke (desktop + mobile)**

1. `pnpm dev`, send a prompt that triggers `screenshot`, `shell_exec`, and (if available) a GitHub MCP call. Verify each card shows: icon, group, humanized label, summary, and the right result renderer.
2. Pair a mobile device (or open the PWA URL in another browser), trigger the same tools, verify mobile cards mirror desktop.
3. Move the main window out of focus to surface the overlay feed; verify rows show icon + group + label.

- [ ] **Step 4: Commit any follow-up fixes and finish**

```bash
git add -A
git commit -m "chore(toolcard): smoke-test follow-ups" # only if any changes
```

---

## Self-Review

**Spec coverage:**
- Shared module `src/shared/tool-presenters.ts` → Tasks 1–4 ✓
- `describeTool` built-ins → Task 1 ✓
- `describeTool` MCP parsing (server, plugin_ strip, otto-tools fall-through, group override, icon picker) → Task 2 ✓
- `summarizeInput` per-tool table → Task 3 ✓
- `classifyResult` (error / empty / image / terminal / markdown / kv / json) → Task 4 ✓
- Per-surface icon component → Tasks 5 (desktop), 8 (mobile)
- `ToolResultRenderer` per surface → Tasks 6 (desktop), 8 (mobile)
- Desktop `ToolCallCard` rewrite → Task 7 ✓
- Mobile `ToolCard` rewrite → Task 8 ✓
- Overlay `OverlayApp` switch → Task 9 ✓
- Tests at both unit + component layers → Tasks 1–4 (unit), 6–7 (component) ✓
- Replace `file://` special case → Task 4 (handled inside `classifyResult`) + Task 7 (consumed) ✓
- `MD_COMPONENTS` lift: spec called this "in-scope, focused" but post-review it's only used by mobile today, and desktop's markdown lives inside `ToolResultRenderer.tsx` via `ReactMarkdown` with default components. Lifting would be churn for no consumer. **Dropped from plan** — chat.tsx keeps its local `MD_COMPONENTS` for assistant text bubbles.

**Placeholder scan:** none. Every code block is complete.

**Type consistency:**
- `IconName` defined once in Task 1, imported by Tasks 5, 8, 9. ✓
- `ResultView` defined in Task 4, consumed in Tasks 6, 8. ✓
- `describeTool` / `summarizeInput` / `classifyResult` signatures stable across all consuming tasks. ✓
- `ToolDescriptor.group` is optional throughout. ✓

---
