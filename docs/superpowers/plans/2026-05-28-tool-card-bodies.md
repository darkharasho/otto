# Beautiful Tool Card Bodies — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `ToolResultRenderer`'s flat per-kind switch with a registry of kind-specific React components, and extend `classifyResult` to recognize the common SDK/MCP tools (Read, Edit, Write, Glob, Grep, WebSearch, WebFetch, GitHub MCP, click/key/type, NotebookEdit, tasks). All polish lives inside the card body; `ToolCallCard` header is unchanged.

**Architecture:** New `ResultView` variants in `src/shared/tool-presenters.ts` carry shape data. `ToolResultRenderer` becomes a dispatcher mapping each `kind` to a card component in `src/renderer-shared/tool-cards/`. Desktop and mobile remote both render the same cards (`compact` prop tightens spacing for mobile). Shiki (lazy-loaded) drives syntax for `code`/`diff`/`notebook`. JSON tree is hand-built.

**Tech Stack:** React 18, TypeScript, Tailwind (existing classes), Vitest, Shiki (new dep), react-markdown (existing).

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/shared/tool-presenters.ts` | Extend `ResultView` union; extend `classifyResult` (accepts optional `input`). |
| `src/shared/tool-presenters.test.ts` | Add cases per new variant. |
| `src/renderer-shared/tool-cards/index.tsx` | New — renderer dispatcher map + barrel exports. |
| `src/renderer-shared/tool-cards/useShiki.ts` | New — lazy highlighter singleton. |
| `src/renderer-shared/tool-cards/TerminalCard.tsx` | New — terminal body with streaming. |
| `src/renderer-shared/tool-cards/ImageCard.tsx` | New — image + lightbox. |
| `src/renderer-shared/tool-cards/MarkdownCard.tsx` | New. |
| `src/renderer-shared/tool-cards/KvCard.tsx` | New. |
| `src/renderer-shared/tool-cards/ErrorCard.tsx` | New. |
| `src/renderer-shared/tool-cards/JsonScalarCard.tsx` | New — `<pre>` for scalar/json fallback. |
| `src/renderer-shared/tool-cards/CodeCard.tsx` | New — Shiki-highlighted file preview. |
| `src/renderer-shared/tool-cards/DiffCard.tsx` | New — unified diff with hunks. |
| `src/renderer-shared/tool-cards/NotebookCard.tsx` | New — cell preview. |
| `src/renderer-shared/tool-cards/PathsCard.tsx` | New — Glob results. |
| `src/renderer-shared/tool-cards/MatchesCard.tsx` | New — Grep results. |
| `src/renderer-shared/tool-cards/SearchCard.tsx` | New — WebSearch results. |
| `src/renderer-shared/tool-cards/PageCard.tsx` | New — WebFetch URL card. |
| `src/renderer-shared/tool-cards/GithubCard.tsx` | New — PR/issue/release card. |
| `src/renderer-shared/tool-cards/ClickCard.tsx` | New — crosshair. |
| `src/renderer-shared/tool-cards/KeyCapsCard.tsx` | New — keycaps. |
| `src/renderer-shared/tool-cards/TypedCard.tsx` | New — typed text pill. |
| `src/renderer-shared/tool-cards/TasksCard.tsx` | New — checklist. |
| `src/renderer-shared/tool-cards/JsonTreeCard.tsx` | New — recursive collapsible tree. |
| `src/renderer/components/ToolResultRenderer.tsx` | Replace switch with dispatcher map import. |
| `src/renderer/components/ToolCallCard.tsx` | Pass `input` through to renderer (one-line change). |
| `src/renderer-remote/tool-result-renderer.tsx` | Switch to dispatcher with `compact`. |
| `package.json` | Add `shiki`. |

---

## Phase 1 — Foundations

### Task 1: Extend `ResultView` types

**Files:**
- Modify: `src/shared/tool-presenters.ts`
- Modify: `src/shared/tool-presenters.test.ts`

- [ ] **Step 1: Add the new variants to `ResultView` and a `Hunk` interface**

Edit `src/shared/tool-presenters.ts` and replace the `ResultView` type. Append after the existing `ResultView` block:

```ts
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
```

- [ ] **Step 2: Update `classifyResult` signature to accept optional input**

Find `export function classifyResult(name: string, result: unknown, isError: boolean): ResultView` and change to:

```ts
export function classifyResult(name: string, result: unknown, isError: boolean, input?: unknown): ResultView {
```

Existing callers compile unchanged — `input` is optional.

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS (callers don't yet use the new variants).

- [ ] **Step 4: Commit**

```bash
git add src/shared/tool-presenters.ts
git commit -m "feat(tool-cards): extend ResultView with new variant placeholders"
```

---

### Task 2: Split existing renderer into per-kind card files

**Files:**
- Create: `src/renderer-shared/tool-cards/ImageCard.tsx`
- Create: `src/renderer-shared/tool-cards/TerminalCard.tsx`
- Create: `src/renderer-shared/tool-cards/MarkdownCard.tsx`
- Create: `src/renderer-shared/tool-cards/KvCard.tsx`
- Create: `src/renderer-shared/tool-cards/ErrorCard.tsx`
- Create: `src/renderer-shared/tool-cards/JsonScalarCard.tsx`
- Create: `src/renderer-shared/tool-cards/index.tsx`
- Modify: `src/renderer/components/ToolResultRenderer.tsx`

- [ ] **Step 1: Create `ImageCard.tsx`**

```tsx
// src/renderer-shared/tool-cards/ImageCard.tsx
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'image' }>;

export function ImageCard({ view, compact }: { view: View; compact?: boolean }) {
  return (
    <div>
      <img src={view.src} alt={view.alt ?? 'tool result'} loading="lazy"
           className="max-w-full rounded border border-border" />
      {view.meta && (
        <div className={`text-muted mt-1 ${compact ? 'text-[10px]' : 'text-[10.5px]'}`}>{view.meta}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `TerminalCard.tsx` (no streaming yet — comes in Task 8)**

```tsx
// src/renderer-shared/tool-cards/TerminalCard.tsx
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'terminal' }>;

export function TerminalCard({ view, compact }: { view: View; compact?: boolean }) {
  const exit = view.exitCode;
  const exitClass = exit === undefined ? 'text-muted' : exit === 0 ? 'text-accent' : 'text-danger';
  const size = compact ? 'text-[10px] p-2' : 'text-[11px] p-2.5';
  return (
    <div className={`rounded bg-bg/80 font-mono leading-relaxed ${size}`}>
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
```

- [ ] **Step 3: Create `MarkdownCard.tsx`, `KvCard.tsx`, `ErrorCard.tsx`, `JsonScalarCard.tsx`**

```tsx
// src/renderer-shared/tool-cards/MarkdownCard.tsx
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ResultView } from '@shared/tool-presenters';
type View = Extract<ResultView, { kind: 'markdown' }>;
export function MarkdownCard({ view }: { view: View; compact?: boolean }) {
  return <div className="prose-sm"><ReactMarkdown remarkPlugins={[remarkGfm]}>{view.text}</ReactMarkdown></div>;
}
```

```tsx
// src/renderer-shared/tool-cards/KvCard.tsx
import type { ResultView } from '@shared/tool-presenters';
type View = Extract<ResultView, { kind: 'kv' }>;
export function KvCard({ view, compact }: { view: View; compact?: boolean }) {
  const fs = compact ? 'text-[10.5px]' : 'text-[11.5px]';
  return (
    <dl className={`grid grid-cols-[max-content,1fr] gap-x-3 gap-y-1 font-mono ${fs}`}>
      {view.entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
```

```tsx
// src/renderer-shared/tool-cards/ErrorCard.tsx
import type { ResultView } from '@shared/tool-presenters';
type View = Extract<ResultView, { kind: 'error' }>;
export function ErrorCard({ view }: { view: View; compact?: boolean }) {
  return (
    <div className="rounded border border-danger/40 bg-danger/10 text-danger px-2.5 py-2 text-xs">
      <div>{view.text}</div>
      {view.suggestion && <div className="mt-1.5 text-accent">💡 {view.suggestion}</div>}
    </div>
  );
}
```

```tsx
// src/renderer-shared/tool-cards/JsonScalarCard.tsx
import type { ResultView } from '@shared/tool-presenters';
type View = Extract<ResultView, { kind: 'json' }>;
export function JsonScalarCard({ view, compact }: { view: View; compact?: boolean }) {
  const fs = compact ? 'text-[10px]' : 'text-[11px]';
  return (
    <pre className={`bg-bg/60 rounded p-2 overflow-x-auto ${fs} whitespace-pre-wrap break-words`}>
      {typeof view.value === 'string' ? view.value : JSON.stringify(view.value, null, 2)}
    </pre>
  );
}
```

- [ ] **Step 4: Create the dispatcher `index.tsx`**

```tsx
// src/renderer-shared/tool-cards/index.tsx
import type { ResultView } from '@shared/tool-presenters';
import { ImageCard } from './ImageCard';
import { TerminalCard } from './TerminalCard';
import { MarkdownCard } from './MarkdownCard';
import { KvCard } from './KvCard';
import { ErrorCard } from './ErrorCard';
import { JsonScalarCard } from './JsonScalarCard';

type Props<K extends ResultView['kind']> = { view: Extract<ResultView, { kind: K }>; compact?: boolean };
type AnyCard = (props: { view: any; compact?: boolean }) => JSX.Element | null;

const RENDERERS: Record<ResultView['kind'], AnyCard> = {
  empty:    () => null,
  image:    ImageCard,
  terminal: TerminalCard,
  markdown: MarkdownCard,
  kv:       KvCard,
  error:    ErrorCard,
  json:     JsonScalarCard,
  // populated in later tasks; placeholders fall through to JsonScalarCard
  code:     ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
  diff:     ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
  paths:    ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
  matches:  ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
  search:   ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
  page:     ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
  github:   ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
  click:    ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
  keypress: ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
  typed:    ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
  tasks:    ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
  notebook: ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
  tree:     ({ view }) => <JsonScalarCard view={{ kind: 'json', value: view }} />,
};

export function ToolCardBody({ view, compact }: { view: ResultView; compact?: boolean }) {
  const Card = RENDERERS[view.kind];
  return Card ? <Card view={view} compact={compact} /> : null;
}
```

- [ ] **Step 5: Rewrite `src/renderer/components/ToolResultRenderer.tsx`**

```tsx
import type { ResultView } from '@shared/tool-presenters';
import { ToolCardBody } from '@renderer-shared/tool-cards';

export function ToolResultRenderer({ view, compact }: { view: ResultView; compact?: boolean }) {
  return <ToolCardBody view={view} compact={compact} />;
}
```

- [ ] **Step 6: Verify the `@renderer-shared` alias resolves**

Run: `grep -n '@renderer-shared\\|@shared' tsconfig*.json vite.config*.ts electron.vite.config.ts 2>/dev/null`

Expected: `@shared` alias exists. If `@renderer-shared` is not present, add it to all alias maps that mention `@shared`, pointing at `src/renderer-shared`. (Likely files: `electron.vite.config.ts`, `vite.config.pwa.ts`, `tsconfig.json`, `tsconfig.node.json`.)

- [ ] **Step 7: Run tests + typecheck**

```
pnpm test src/renderer/components/ToolResultRenderer
pnpm typecheck
```

Expected: existing tests still pass.

- [ ] **Step 8: Commit**

```bash
git add src/renderer-shared src/renderer/components/ToolResultRenderer.tsx electron.vite.config.ts vite.config.pwa.ts tsconfig.json tsconfig.node.json
git commit -m "refactor(tool-cards): split renderer into per-kind card components"
```

---

## Phase 2 — Classifier extensions

### Task 3: Recognize built-in Otto tools from input (click / key / type / tasks)

**Files:**
- Modify: `src/shared/tool-presenters.ts`
- Modify: `src/shared/tool-presenters.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/shared/tool-presenters.test.ts`:

```ts
import { classifyResult } from './tool-presenters';

describe('classifyResult — input-driven cards', () => {
  it('click → click view', () => {
    expect(classifyResult('click', null, false, { x: 100, y: 200 }))
      .toEqual({ kind: 'click', x: 100, y: 200 });
  });
  it('key → keypress view', () => {
    expect(classifyResult('key', null, false, { combo: 'cmd+shift+p' }))
      .toEqual({ kind: 'keypress', keys: ['cmd', 'shift', 'p'] });
  });
  it('type → typed view', () => {
    expect(classifyResult('type', null, false, { text: 'hello' }))
      .toEqual({ kind: 'typed', text: 'hello' });
  });
  it('TodoWrite → tasks view', () => {
    const todos = [
      { status: 'completed', content: 'Plan' },
      { status: 'in_progress', content: 'Build' },
    ];
    expect(classifyResult('TodoWrite', null, false, { todos }))
      .toEqual({ kind: 'tasks', items: [
        { status: 'completed', title: 'Plan' },
        { status: 'in_progress', title: 'Build' },
      ]});
  });
});
```

- [ ] **Step 2: Run and verify FAIL**

Run: `pnpm test src/shared/tool-presenters.test.ts`
Expected: 4 failures.

- [ ] **Step 3: Implement** in `src/shared/tool-presenters.ts`, at the **top** of `classifyResult` after the `isError` and empty short-circuits:

```ts
// Input-driven (results are typically empty)
const bareNameForInput = parseMcpName(name)?.server === 'otto-tools'
  ? parseMcpName(name)!.tool : name;
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
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate': {
      const todos = Array.isArray(i['todos']) ? i['todos'] : null;
      if (todos) {
        const items = todos
          .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
          .map(t => ({
            status: (t['status'] === 'in_progress' || t['status'] === 'completed') ? t['status'] : 'pending' as const,
            title: String(t['content'] ?? t['subject'] ?? t['title'] ?? ''),
          }));
        return { kind: 'tasks', items };
      }
      // single-item TaskCreate fallback
      if (bareNameForInput === 'TaskCreate' && typeof i['subject'] === 'string') {
        return { kind: 'tasks', items: [{ status: 'pending', title: String(i['subject']) }] };
      }
      break;
    }
  }
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm test src/shared/tool-presenters.test.ts`
Expected: previously-failing 4 pass; existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add src/shared/tool-presenters.ts src/shared/tool-presenters.test.ts
git commit -m "feat(tool-cards): classify click/key/type/tasks from inputs"
```

---

### Task 4: Recognize Read / Glob / Grep results

**Files:**
- Modify: `src/shared/tool-presenters.ts`
- Modify: `src/shared/tool-presenters.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
describe('classifyResult — file tools', () => {
  it('Read → code view (strips line prefixes)', () => {
    const res = '     1→import x from "y";\n     2→const a = 1;';
    const view = classifyResult('Read', res, false, { file_path: '/p/foo.ts' });
    expect(view).toMatchObject({
      kind: 'code', path: '/p/foo.ts', language: 'ts',
      text: 'import x from "y";\nconst a = 1;', startLine: 1,
    });
  });
  it('Glob → paths view', () => {
    const res = 'src/a.tsx\nsrc/b.tsx\nsrc/c.tsx';
    const view = classifyResult('Glob', res, false, { pattern: '**/*.tsx' });
    expect(view).toEqual({ kind: 'paths', pattern: '**/*.tsx',
      matches: ['src/a.tsx', 'src/b.tsx', 'src/c.tsx'] });
  });
  it('Grep (content) → matches view', () => {
    const res = 'src/a.ts:12:const foo = 1;\nsrc/b.ts:7:foo()';
    const view = classifyResult('Grep', res, false, { pattern: 'foo' });
    expect(view).toMatchObject({
      kind: 'matches', pattern: 'foo',
      files: [
        { path: 'src/a.ts', line: 12, snippet: 'const foo = 1;' },
        { path: 'src/b.ts', line: 7,  snippet: 'foo()' },
      ],
    });
  });
  it('Grep (files_with_matches) → paths view', () => {
    const res = 'src/a.ts\nsrc/b.ts';
    const view = classifyResult('Grep', res, false, { pattern: 'foo', output_mode: 'files_with_matches' });
    expect(view).toEqual({ kind: 'paths', pattern: 'foo', matches: ['src/a.ts', 'src/b.ts'] });
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `pnpm test src/shared/tool-presenters.test.ts`
Expected: 4 new failures.

- [ ] **Step 3: Implement.** In `classifyResult`, before the existing object-shape checks, add:

```ts
// File tools — recognize by name
if (typeof result === 'string') {
  if (bareNameForInput === 'Read') {
    // Strip Read's "    N→" prefix
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
    const files: Array<{ path: string; line: number; snippet: string }> = [];
    for (const line of result.split('\n')) {
      const m = /^([^:]+):(\d+):(.*)$/.exec(line);
      if (m) files.push({ path: m[1]!, line: Number(m[2]), snippet: m[3] ?? '' });
    }
    return { kind: 'matches', pattern, files };
  }
}

// helper at module scope
function extLang(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return ({ ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', py: 'python', rs: 'rust',
            go: 'go', md: 'markdown', json: 'json', sh: 'bash', html: 'html', css: 'css' }
          )[ext] ?? 'text';
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `pnpm test src/shared/tool-presenters.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/shared/tool-presenters.ts src/shared/tool-presenters.test.ts
git commit -m "feat(tool-cards): classify Read/Glob/Grep results"
```

---

### Task 5: Recognize Edit / Write inputs → diff view

**Files:**
- Modify: `src/shared/tool-presenters.ts`
- Modify: `src/shared/tool-presenters.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
describe('classifyResult — Edit/Write → diff', () => {
  it('Write → diff with isNew, all added lines', () => {
    const view = classifyResult('Write', 'File created at /p/a.ts', false,
      { file_path: '/p/a.ts', content: 'line1\nline2' });
    expect(view).toMatchObject({
      kind: 'diff', path: '/p/a.ts', isNew: true,
      added: 2, removed: 0,
      hunks: [{ oldStart: 0, newStart: 1, lines: [
        { kind: 'add', text: 'line1' },
        { kind: 'add', text: 'line2' },
      ]}],
    });
  });
  it('Edit → diff hunk with old/new', () => {
    const view = classifyResult('Edit', 'updated', false, {
      file_path: '/p/a.ts',
      old_string: 'foo\nbar',
      new_string: 'foo\nBAZ\nbar',
    });
    expect(view).toMatchObject({
      kind: 'diff', path: '/p/a.ts', isNew: false,
      added: 1, removed: 0,
    });
    if (view.kind === 'diff') {
      expect(view.hunks[0]!.lines.some(l => l.kind === 'add' && l.text === 'BAZ')).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement.** Add at the top of `classifyResult` (just below the input-driven switch):

```ts
if (input && typeof input === 'object') {
  const i = input as Record<string, unknown>;
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
```

Add a minimal `diffLines` helper at module scope:

```ts
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
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/shared/tool-presenters.ts src/shared/tool-presenters.test.ts
git commit -m "feat(tool-cards): classify Edit/Write inputs as diff view"
```

---

### Task 6: Recognize WebSearch / WebFetch / GitHub MCP / object→tree

**Files:**
- Modify: `src/shared/tool-presenters.ts`
- Modify: `src/shared/tool-presenters.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
describe('classifyResult — web + github + tree', () => {
  it('WebSearch → search view', () => {
    const res = '1. Title One (https://a.com) — snippet one\n2. Title Two (https://b.com) — snippet two';
    const view = classifyResult('WebSearch', res, false, { query: 'electron' });
    expect(view).toMatchObject({
      kind: 'search', query: 'electron',
      results: [
        { title: 'Title One', url: 'https://a.com', snippet: 'snippet one' },
        { title: 'Title Two', url: 'https://b.com', snippet: 'snippet two' },
      ],
    });
  });
  it('WebFetch → page view', () => {
    const view = classifyResult('WebFetch', '# Hello\n\nIntro paragraph.', false,
      { url: 'https://x.com/y' });
    expect(view).toMatchObject({ kind: 'page', url: 'https://x.com/y', title: 'Hello' });
  });
  it('GitHub PR result → github view', () => {
    const res = { number: 142, title: 'Beautiful tool cards', state: 'open',
                  html_url: 'https://github.com/o/r/pull/142',
                  additions: 234, deletions: 98, changed_files: 4,
                  user: { login: 'darkharasho' } };
    const view = classifyResult('mcp__github__create_pull_request', res, false,
      { owner: 'o', repo: 'r', title: 'x' });
    expect(view).toMatchObject({
      kind: 'github', flavor: 'pr', repo: 'o/r', number: 142,
      title: 'Beautiful tool cards', state: 'open', author: 'darkharasho',
      stats: { added: 234, removed: 98, files: 4 },
    });
  });
  it('large object → tree view (replaces json for objects)', () => {
    const view = classifyResult('weird', { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 }, false);
    expect(view.kind).toBe('tree');
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement.**

WebSearch parser (add to `classifyResult` string-result block):

```ts
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
```

WebFetch (add to string-result block):

```ts
if (bareNameForInput === 'WebFetch') {
  const url = typeof (input as Record<string, unknown> | undefined)?.['url'] === 'string'
    ? String((input as Record<string, unknown>)['url']) : '';
  const m = /^\s*#\s+(.+)$/m.exec(result);
  const title = m?.[1]?.trim();
  const body = result.replace(/^\s*#.*$/m, '').trim();
  const snippet = body.split('\n').filter(Boolean).slice(0, 3).join(' ').slice(0, 220);
  return { kind: 'page', url, ...(title !== undefined ? { title } : {}), snippet };
}
```

GitHub MCP recognizer (add in the object-shape block, before the existing KV check):

```ts
if (typeof result === 'object' && result !== null && !Array.isArray(result)) {
  const o = result as Record<string, unknown>;
  const parsed = parseMcpName(name);
  if (parsed && /github/i.test(parsed.server)) {
    const owner = (input as Record<string, unknown> | undefined)?.['owner'];
    const repoName = (input as Record<string, unknown> | undefined)?.['repo'];
    const repo = typeof owner === 'string' && typeof repoName === 'string'
      ? `${owner}/${repoName}`
      : (typeof o['full_name'] === 'string' ? o['full_name'] : 'repo');
    const flavor: 'pr' | 'issue' | 'release' | 'commit' =
      /pull_request|pull/.test(parsed.tool) ? 'pr' :
      /release/.test(parsed.tool) ? 'release' :
      /commit/.test(parsed.tool) ? 'commit' : 'issue';
    const view: ResultView = {
      kind: 'github', flavor, repo,
      ...(o['number'] !== undefined ? { number: o['number'] as number } : {}),
      ...(typeof o['title'] === 'string' ? { title: o['title'] } : {}),
      ...(typeof o['state'] === 'string' ? { state: o['state'] } : {}),
      ...(typeof o['html_url'] === 'string' ? { htmlUrl: o['html_url'] } : {}),
      ...(typeof (o['user'] as Record<string, unknown> | undefined)?.['login'] === 'string'
        ? { author: (o['user'] as Record<string, unknown>)['login'] as string } : {}),
      ...(typeof o['additions'] === 'number' && typeof o['deletions'] === 'number'
        ? { stats: { added: o['additions'] as number, removed: o['deletions'] as number,
                     files: (o['changed_files'] as number) ?? 0 } } : {}),
    };
    return view;
  }
}
```

Tree fallback (replace the final `return { kind: 'json', value: result }` for objects/arrays):

```ts
// Replace existing final return
if (typeof result === 'object' && result !== null) {
  return { kind: 'tree', value: result };
}
return { kind: 'json', value: result };
```

Update the existing `kv` branch's threshold so it still catches small flat objects **before** falling to `tree` (already does — the KV check happens first).

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/shared/tool-presenters.ts src/shared/tool-presenters.test.ts
git commit -m "feat(tool-cards): classify web + github results; tree fallback for objects"
```

---

### Task 7: Recognize NotebookEdit; thread input into ToolCallCard

**Files:**
- Modify: `src/shared/tool-presenters.ts`
- Modify: `src/shared/tool-presenters.test.ts`
- Modify: `src/renderer/components/ToolCallCard.tsx`
- Modify: `src/renderer-remote/chat.tsx`

- [ ] **Step 1: Write failing test**

```ts
it('NotebookEdit → notebook view', () => {
  const view = classifyResult('NotebookEdit', { success: true }, false,
    { notebook_path: '/p/a.ipynb', cell_id: 4, cell_type: 'code', new_source: 'import x' });
  expect(view).toMatchObject({ kind: 'notebook', path: '/p/a.ipynb', cellType: 'code',
    text: 'import x', language: 'python' });
});
```

- [ ] **Step 2: Implement** — add to the input-driven switch:

```ts
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
```

- [ ] **Step 3: Run, expect PASS**

- [ ] **Step 4: Thread `input` through `ToolCallCard`** so the renderer benefits from input-driven classification. Modify `src/renderer/components/ToolCallCard.tsx` line 20:

```tsx
const view = result === undefined ? null : classifyResult(name, result, isError, input);
```

- [ ] **Step 5: Same change in `src/renderer-remote/chat.tsx`** — find its inner `classifyResult(...)` call and add `input` as the 4th arg.

- [ ] **Step 6: Run all tests + typecheck**

```
pnpm test
pnpm typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/shared/tool-presenters.ts src/shared/tool-presenters.test.ts \
  src/renderer/components/ToolCallCard.tsx src/renderer-remote/chat.tsx
git commit -m "feat(tool-cards): classify NotebookEdit; thread input into renderer"
```

---

## Phase 3 — Card components

### Task 8: TerminalCard streaming + lightbox on ImageCard

**Files:**
- Modify: `src/renderer-shared/tool-cards/TerminalCard.tsx`
- Modify: `src/renderer-shared/tool-cards/ImageCard.tsx`

- [ ] **Step 1: Add streaming behavior to `TerminalCard`** — auto-scroll-to-bottom + cursor when `streaming: true`:

```tsx
import { useEffect, useRef } from 'react';
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'terminal' }>;

export function TerminalCard({ view, compact }: { view: View; compact?: boolean }) {
  const exit = view.exitCode;
  const exitClass = exit === undefined ? 'text-muted' : exit === 0 ? 'text-accent' : 'text-danger';
  const size = compact ? 'text-[10px] p-2' : 'text-[11px] p-2.5';
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (view.streaming && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [view.stdout, view.stderr, view.streaming]);
  return (
    <div ref={ref} className={`rounded bg-bg/80 font-mono leading-relaxed max-h-[320px] overflow-auto ${size}`}>
      {view.stdout && <pre className="whitespace-pre-wrap break-words m-0">{view.stdout}</pre>}
      {view.stderr && <pre className="whitespace-pre-wrap break-words m-0 text-danger">{view.stderr}</pre>}
      {view.streaming && <span className="inline-block w-2 h-3 align-baseline bg-accent/70 otto-blink" />}
      {exit !== undefined && (
        <div className={`text-[10px] mt-1.5 ${exitClass}`}>
          ↳ exited {exit}{view.durationMs ? ` · ${view.durationMs}ms` : ''}
        </div>
      )}
      {view.streaming && exit === undefined && (
        <div className="text-[10px] mt-1.5 text-muted">↳ running…</div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add `otto-blink` keyframes**

Run: `grep -n 'otto-spin\\|otto-pop' src/renderer/index.css`
Expected: existing keyframes file located.

Append to `src/renderer/index.css`:

```css
@keyframes otto-blink { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0 } }
.otto-blink { animation: otto-blink 1s steps(1) infinite }
```

- [ ] **Step 3: Add lightbox to `ImageCard`** (click → full-screen modal):

```tsx
import { useState } from 'react';
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'image' }>;

export function ImageCard({ view, compact }: { view: View; compact?: boolean }) {
  const [zoom, setZoom] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setZoom(true)} className="block w-full text-left">
        <img src={view.src} alt={view.alt ?? 'tool result'} loading="lazy"
             className="max-w-full rounded border border-border hover:border-accent transition-colors" />
        {view.meta && (
          <div className={`text-muted mt-1 ${compact ? 'text-[10px]' : 'text-[10.5px]'}`}>{view.meta}</div>
        )}
      </button>
      {zoom && (
        <div role="dialog" onClick={() => setZoom(false)}
             className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6 cursor-zoom-out">
          <img src={view.src} alt={view.alt ?? 'tool result'} className="max-w-full max-h-full" />
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test src/renderer/components/ToolResultRenderer`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer-shared/tool-cards/TerminalCard.tsx src/renderer-shared/tool-cards/ImageCard.tsx src/renderer/index.css
git commit -m "feat(tool-cards): TerminalCard streaming + ImageCard lightbox"
```

---

### Task 9: Shiki integration + CodeCard + DiffCard + NotebookCard

**Files:**
- Create: `src/renderer-shared/tool-cards/useShiki.ts`
- Create: `src/renderer-shared/tool-cards/CodeCard.tsx`
- Create: `src/renderer-shared/tool-cards/DiffCard.tsx`
- Create: `src/renderer-shared/tool-cards/NotebookCard.tsx`
- Modify: `src/renderer-shared/tool-cards/index.tsx`
- Modify: `package.json`

- [ ] **Step 1: Add shiki dependency**

Run: `pnpm add shiki`
Expected: installed; `package.json` updated.

- [ ] **Step 2: Create `useShiki.ts`** — singleton lazy highlighter:

```ts
// src/renderer-shared/tool-cards/useShiki.ts
import { useEffect, useState } from 'react';
import type { Highlighter } from 'shiki';

let promise: Promise<Highlighter> | null = null;

async function load(): Promise<Highlighter> {
  if (promise) return promise;
  const { getHighlighter } = await import('shiki');
  promise = getHighlighter({
    themes: ['github-dark-dimmed'],
    langs: ['ts', 'tsx', 'js', 'jsx', 'python', 'json', 'bash', 'markdown', 'html', 'css', 'go', 'rust'],
  });
  return promise;
}

export function useHighlighted(code: string, lang?: string): string {
  const [html, setHtml] = useState<string>('');
  useEffect(() => {
    let cancelled = false;
    load().then(h => {
      if (cancelled) return;
      const useLang = lang && h.getLoadedLanguages().includes(lang as never) ? lang : 'text';
      setHtml(h.codeToHtml(code, { lang: useLang, theme: 'github-dark-dimmed' }));
    }).catch(() => setHtml(''));
    return () => { cancelled = true; };
  }, [code, lang]);
  return html;
}
```

- [ ] **Step 3: Create `CodeCard.tsx`**

```tsx
// src/renderer-shared/tool-cards/CodeCard.tsx
import type { ResultView } from '@shared/tool-presenters';
import { useHighlighted } from './useShiki';

type View = Extract<ResultView, { kind: 'code' }>;

export function CodeCard({ view, compact }: { view: View; compact?: boolean }) {
  const html = useHighlighted(view.text, view.language);
  const fname = view.path?.split('/').pop();
  const fs = compact ? 'text-[10px]' : 'text-[11px]';
  return (
    <div className="rounded overflow-hidden border border-border/50">
      {view.path && (
        <div className={`flex items-center gap-2 px-2.5 py-1 bg-surface/40 ${fs} text-muted`}>
          <span className="text-[9px] uppercase tracking-wide">read</span>
          <span>{view.path.replace(fname ?? '', '')}<b className="text-fg">{fname}</b></span>
          <span className="ml-auto">{view.totalLines ?? view.text.split('\n').length} lines</span>
        </div>
      )}
      {html
        ? <div className={`shiki-host ${fs}`} dangerouslySetInnerHTML={{ __html: html }} />
        : <pre className={`bg-bg/80 p-2.5 m-0 font-mono ${fs} overflow-x-auto`}>{view.text}</pre>}
      {view.truncated && (
        <div className="text-[10px] text-muted px-2.5 py-1 bg-surface/30">↳ truncated</div>
      )}
    </div>
  );
}
```

Add a small CSS reset for shiki output in `src/renderer/index.css`:

```css
.shiki-host pre { margin: 0; padding: 10px 12px; overflow-x: auto }
.shiki-host code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace }
```

- [ ] **Step 4: Create `DiffCard.tsx`**

```tsx
// src/renderer-shared/tool-cards/DiffCard.tsx
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'diff' }>;

export function DiffCard({ view, compact }: { view: View; compact?: boolean }) {
  const fname = view.path.split('/').pop();
  const fs = compact ? 'text-[10px]' : 'text-[11px]';
  return (
    <div className="rounded overflow-hidden border border-border/50">
      <div className={`flex items-center gap-2 px-2.5 py-1 bg-surface/40 ${fs} text-muted`}>
        <span className={`text-[9px] uppercase tracking-wide ${view.isNew ? 'text-accent' : 'text-amber-400'}`}>
          {view.isNew ? 'new' : 'edit'}
        </span>
        <span>{view.path.replace(fname ?? '', '')}<b className="text-fg">{fname}</b></span>
        <span className="ml-auto">
          <span className="text-accent">+{view.added}</span>{' '}
          <span className="text-danger">−{view.removed}</span>
        </span>
      </div>
      <div className={`bg-bg/80 font-mono ${fs}`}>
        {view.hunks.map((h, hi) => (
          <div key={hi}>
            {hi > 0 && <div className="text-muted px-2 py-0.5 bg-surface/20">…</div>}
            {h.lines.map((l, li) => {
              const bg = l.kind === 'add' ? 'bg-emerald-500/10 text-emerald-300'
                       : l.kind === 'del' ? 'bg-red-500/10 text-red-300' : '';
              const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ';
              return (
                <pre key={li} className={`m-0 whitespace-pre-wrap break-words px-2 ${bg}`}>{sign} {l.text}</pre>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create `NotebookCard.tsx`**

```tsx
// src/renderer-shared/tool-cards/NotebookCard.tsx
import type { ResultView } from '@shared/tool-presenters';
import { useHighlighted } from './useShiki';

type View = Extract<ResultView, { kind: 'notebook' }>;

export function NotebookCard({ view, compact }: { view: View; compact?: boolean }) {
  const html = useHighlighted(view.text, view.language ?? 'python');
  const fname = view.path.split('/').pop();
  const fs = compact ? 'text-[10px]' : 'text-[11px]';
  return (
    <div className="rounded overflow-hidden border border-border/50">
      <div className={`flex items-center gap-2 px-2.5 py-1 bg-surface/40 ${fs} text-muted`}>
        <span className="text-[9px] uppercase tracking-wide">notebook</span>
        <b className="text-fg">{fname}</b>
        {view.cellIndex !== undefined && <span>cell [{view.cellIndex}]</span>}
        <span className="ml-auto text-[9px] uppercase">{view.op ?? 'replace'}</span>
      </div>
      {html
        ? <div className={`shiki-host ${fs}`} dangerouslySetInnerHTML={{ __html: html }} />
        : <pre className={`bg-bg/80 p-2.5 m-0 font-mono ${fs} overflow-x-auto`}>{view.text}</pre>}
    </div>
  );
}
```

- [ ] **Step 6: Wire all three into the dispatcher** — edit `src/renderer-shared/tool-cards/index.tsx`, replace the placeholder entries for `code`, `diff`, `notebook` with real imports.

- [ ] **Step 7: Run tests + typecheck**

```
pnpm test
pnpm typecheck
```

- [ ] **Step 8: Commit**

```bash
git add src/renderer-shared/tool-cards src/renderer/index.css package.json pnpm-lock.yaml
git commit -m "feat(tool-cards): CodeCard, DiffCard, NotebookCard via Shiki"
```

---

### Task 10: List + lookup cards (Paths, Matches, Search, Page, Github)

**Files:**
- Create: `src/renderer-shared/tool-cards/PathsCard.tsx`
- Create: `src/renderer-shared/tool-cards/MatchesCard.tsx`
- Create: `src/renderer-shared/tool-cards/SearchCard.tsx`
- Create: `src/renderer-shared/tool-cards/PageCard.tsx`
- Create: `src/renderer-shared/tool-cards/GithubCard.tsx`
- Modify: `src/renderer-shared/tool-cards/index.tsx`

- [ ] **Step 1: `PathsCard.tsx`**

```tsx
import { useState } from 'react';
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'paths' }>;

export function PathsCard({ view, compact }: { view: View; compact?: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const limit = compact ? 12 : 30;
  const visible = showAll ? view.matches : view.matches.slice(0, limit);
  const fs = compact ? 'text-[10px]' : 'text-[11px]';
  return (
    <div className={`rounded bg-bg/60 p-2 font-mono ${fs}`}>
      {view.pattern && (
        <div className="flex items-center gap-2 mb-1.5 text-muted">
          <span className="text-[9px] uppercase">pattern</span>
          <span className="text-fg">{view.pattern}</span>
          <span className="ml-auto px-1.5 py-0.5 rounded bg-surface/60 text-[10px]">
            {view.matches.length} match{view.matches.length === 1 ? '' : 'es'}
          </span>
        </div>
      )}
      <ul className="space-y-0.5">
        {visible.map(p => <li key={p} className="break-all">{p}</li>)}
      </ul>
      {view.matches.length > limit && (
        <button type="button" onClick={() => setShowAll(s => !s)}
                className="mt-1.5 text-accent text-[10px] hover:underline">
          {showAll ? 'Show fewer' : `Show all ${view.matches.length}`}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: `MatchesCard.tsx`**

```tsx
import { useMemo, useState } from 'react';
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'matches' }>;

export function MatchesCard({ view, compact }: { view: View; compact?: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const limit = compact ? 8 : 20;
  const visible = showAll ? view.files : view.files.slice(0, limit);
  const grouped = useMemo(() => {
    const m = new Map<string, typeof view.files>();
    for (const f of visible) {
      const arr = m.get(f.path) ?? [];
      arr.push(f); m.set(f.path, arr);
    }
    return Array.from(m.entries());
  }, [visible]);
  const fs = compact ? 'text-[10px]' : 'text-[11px]';
  return (
    <div className={`rounded bg-bg/60 p-2 font-mono ${fs}`}>
      <div className="flex items-center gap-2 mb-1.5 text-muted">
        <span className="text-[9px] uppercase">grep</span>
        <span className="text-fg">/{view.pattern}/</span>
        <span className="ml-auto px-1.5 py-0.5 rounded bg-surface/60 text-[10px]">
          {view.files.length} match{view.files.length === 1 ? '' : 'es'} · {grouped.length} file{grouped.length === 1 ? '' : 's'}
        </span>
      </div>
      {grouped.map(([path, rows]) => (
        <div key={path} className="mb-1.5">
          <div className="text-fg break-all"><b>{path}</b></div>
          {rows.map((r, i) => (
            <div key={i} className="pl-3 break-all">
              <span className="text-muted mr-2">L{r.line}</span>
              <span>{r.snippet}</span>
            </div>
          ))}
        </div>
      ))}
      {view.files.length > limit && (
        <button type="button" onClick={() => setShowAll(s => !s)}
                className="text-accent text-[10px] hover:underline">
          {showAll ? 'Show fewer' : `Show all ${view.files.length}`}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: `SearchCard.tsx`**

```tsx
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'search' }>;

function favicon(url: string): string {
  try { return `https://www.google.com/s2/favicons?sz=32&domain=${new URL(url).hostname}`; }
  catch { return ''; }
}
function hostname(url: string): string { try { return new URL(url).hostname; } catch { return url; } }

export function SearchCard({ view, compact }: { view: View; compact?: boolean }) {
  const visible = view.results.slice(0, compact ? 3 : 5);
  return (
    <div className="space-y-2">
      <div className="text-muted text-[10.5px]">"{view.query}"</div>
      {visible.map((r, i) => (
        <a key={i} href={r.url} target="_blank" rel="noreferrer"
           className="block hover:bg-surface/30 rounded p-1.5 -m-1.5 transition-colors">
          <div className="flex items-center gap-1.5">
            {favicon(r.url) && <img src={favicon(r.url)} alt="" className="w-3.5 h-3.5 rounded-sm" />}
            <span className="text-[10px] text-muted">{hostname(r.url)}</span>
          </div>
          <div className="text-fg text-[12px] font-medium leading-tight">{r.title}</div>
          {r.snippet && <div className="text-muted text-[11px] line-clamp-2">{r.snippet}</div>}
        </a>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: `PageCard.tsx`**

```tsx
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'page' }>;

function favicon(url: string): string {
  try { return `https://www.google.com/s2/favicons?sz=32&domain=${new URL(url).hostname}`; }
  catch { return ''; }
}

export function PageCard({ view, compact }: { view: View; compact?: boolean }) {
  return (
    <div className="rounded border border-border/50 overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-1.5 bg-surface/40">
        {favicon(view.url) && <img src={favicon(view.url)} alt="" className="w-3.5 h-3.5 rounded-sm" />}
        <a href={view.url} target="_blank" rel="noreferrer"
           className="text-[11px] truncate hover:underline">{view.url}</a>
      </div>
      <div className="p-2.5">
        {view.title && <div className="font-medium text-[12px]">{view.title}</div>}
        {view.snippet && <div className="text-muted text-[11px] mt-1 line-clamp-3">{view.snippet}</div>}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: `GithubCard.tsx`**

```tsx
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'github' }>;

const STATE_PILL: Record<string, string> = {
  open:   'bg-emerald-500/15 text-emerald-300',
  closed: 'bg-red-500/15 text-red-300',
  merged: 'bg-purple-500/15 text-purple-300',
  draft:  'bg-zinc-500/15 text-zinc-300',
};

export function GithubCard({ view, compact }: { view: View; compact?: boolean }) {
  const pill = STATE_PILL[view.state ?? ''] ?? 'bg-surface/60 text-muted';
  return (
    <div className="rounded border border-border/50 p-2.5">
      <div className="flex items-center gap-2 text-[10px] text-muted">
        <span className="uppercase tracking-wide">github · {view.flavor}</span>
        <span>{view.repo}</span>
        {view.state && (
          <span className={`ml-auto px-2 py-0.5 rounded-full uppercase tracking-wide ${pill}`}>{view.state}</span>
        )}
      </div>
      <div className="mt-1 text-[12px]">
        {view.number !== undefined && <span className="font-mono text-muted">#{view.number} · </span>}
        <span className="font-medium">{view.title ?? '(untitled)'}</span>
      </div>
      <div className="text-muted text-[10.5px] mt-0.5">
        {view.author && <>by {view.author}</>}
        {view.stats && <> · <span className="text-accent">+{view.stats.added}</span> <span className="text-danger">−{view.stats.removed}</span> · {view.stats.files} file{view.stats.files === 1 ? '' : 's'}</>}
      </div>
      {view.htmlUrl && (
        <a href={view.htmlUrl} target="_blank" rel="noreferrer"
           className="text-accent text-[10.5px] hover:underline">Open ↗</a>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Wire into dispatcher** — replace the placeholder entries for `paths`, `matches`, `search`, `page`, `github` in `src/renderer-shared/tool-cards/index.tsx`.

- [ ] **Step 7: Run tests + typecheck**

```
pnpm test
pnpm typecheck
```

- [ ] **Step 8: Commit**

```bash
git add src/renderer-shared/tool-cards
git commit -m "feat(tool-cards): Paths, Matches, Search, Page, Github cards"
```

---

### Task 11: Input cards (Click, KeyCaps, Typed, Tasks)

**Files:**
- Create: `src/renderer-shared/tool-cards/ClickCard.tsx`
- Create: `src/renderer-shared/tool-cards/KeyCapsCard.tsx`
- Create: `src/renderer-shared/tool-cards/TypedCard.tsx`
- Create: `src/renderer-shared/tool-cards/TasksCard.tsx`
- Modify: `src/renderer-shared/tool-cards/index.tsx`

- [ ] **Step 1: `ClickCard.tsx`** — crosshair sized 200×120, scales the click position into the panel:

```tsx
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'click' }>;

export function ClickCard({ view, compact }: { view: View; compact?: boolean }) {
  // Assume a default screen ratio; just visually represent quadrant
  const W = compact ? 180 : 240, H = compact ? 100 : 130;
  const px = Math.min(Math.max(view.x / 2560, 0), 1) * W;
  const py = Math.min(Math.max(view.y / 1440, 0), 1) * H;
  return (
    <div>
      <div className="text-muted text-[10.5px] mb-1.5">
        clicked at ({view.x}, {view.y}){view.button ? ` · ${view.button}` : ''}
      </div>
      <div className="relative rounded bg-gradient-to-br from-surface/60 to-bg/80 overflow-hidden border border-border/40"
           style={{ width: W, height: H }}>
        <div className="absolute inset-x-0" style={{ top: py, height: 1, background: 'rgba(120,180,255,.4)' }} />
        <div className="absolute inset-y-0" style={{ left: px, width: 1, background: 'rgba(120,180,255,.4)' }} />
        <div className="absolute rounded-full bg-accent shadow-[0_0_10px_var(--tw-shadow-color)] shadow-accent"
             style={{ left: px - 5, top: py - 5, width: 10, height: 10 }} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `KeyCapsCard.tsx`**

```tsx
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'keypress' }>;

const GLYPH: Record<string, string> = {
  cmd: '⌘', command: '⌘', meta: '⌘',
  ctrl: '⌃', control: '⌃',
  alt: '⌥', option: '⌥',
  shift: '⇧',
  enter: '↵', return: '↵',
  esc: 'Esc', escape: 'Esc',
  tab: '⇥', space: '␣',
  backspace: '⌫', delete: '⌦',
  up: '↑', down: '↓', left: '←', right: '→',
};

function render(k: string): string {
  const lc = k.toLowerCase();
  return GLYPH[lc] ?? (k.length === 1 ? k.toUpperCase() : k);
}

export function KeyCapsCard({ view }: { view: View; compact?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {view.keys.map((k, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-muted text-[10px]">+</span>}
          <kbd className="px-1.5 py-0.5 rounded border border-border border-b-2 bg-surface/60 font-mono text-[11px]">
            {render(k)}
          </kbd>
        </span>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: `TypedCard.tsx`**

```tsx
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'typed' }>;

export function TypedCard({ view }: { view: View; compact?: boolean }) {
  return (
    <div className="inline-flex items-baseline gap-2 max-w-full">
      <span className="px-2 py-1 rounded bg-surface/60 font-mono text-[11px] break-words">
        "{view.text}"
      </span>
      <span className="text-muted text-[10px]">{view.text.length} char{view.text.length === 1 ? '' : 's'}</span>
    </div>
  );
}
```

- [ ] **Step 4: `TasksCard.tsx`**

```tsx
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'tasks' }>;

function glyph(s: 'pending' | 'in_progress' | 'completed'): JSX.Element {
  if (s === 'completed') return <span className="text-accent">✓</span>;
  if (s === 'in_progress') return <span className="text-amber-400 otto-pulse">●</span>;
  return <span className="text-muted">○</span>;
}

export function TasksCard({ view }: { view: View; compact?: boolean }) {
  const done = view.items.filter(i => i.status === 'completed').length;
  return (
    <div className="space-y-0.5">
      <div className="text-muted text-[10.5px] mb-1">{done}/{view.items.length} complete</div>
      {view.items.map((it, i) => (
        <div key={i} className="flex items-baseline gap-2 text-[11.5px]">
          {glyph(it.status)}
          <span className={it.status === 'completed' ? 'text-muted line-through' : ''}>{it.title}</span>
        </div>
      ))}
    </div>
  );
}
```

Add to `src/renderer/index.css`:

```css
@keyframes otto-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .4 } }
.otto-pulse { animation: otto-pulse 1.4s ease-in-out infinite }
```

- [ ] **Step 5: Wire into dispatcher** — replace placeholders for `click`, `keypress`, `typed`, `tasks`.

- [ ] **Step 6: Run tests + typecheck**

```
pnpm test
pnpm typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/renderer-shared/tool-cards src/renderer/index.css
git commit -m "feat(tool-cards): Click, KeyCaps, Typed, Tasks cards"
```

---

### Task 12: JsonTreeCard (recursive collapsible)

**Files:**
- Create: `src/renderer-shared/tool-cards/JsonTreeCard.tsx`
- Modify: `src/renderer-shared/tool-cards/index.tsx`

- [ ] **Step 1: Write failing component test**

Create `src/renderer-shared/tool-cards/JsonTreeCard.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { JsonTreeCard } from './JsonTreeCard';

describe('JsonTreeCard', () => {
  it('renders top-level keys', () => {
    render(<JsonTreeCard view={{ kind: 'tree', value: { a: 1, b: 'x' } }} />);
    expect(screen.getByText('"a"')).toBeInTheDocument();
    expect(screen.getByText('"b"')).toBeInTheDocument();
  });
  it('expands nested objects on click', () => {
    render(<JsonTreeCard view={{ kind: 'tree', value: { outer: { inner: 7 } } }} />);
    expect(screen.queryByText('"inner"')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('"outer"'));
    expect(screen.getByText('"inner"')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `pnpm test JsonTreeCard`
Expected: file not found.

- [ ] **Step 3: Implement**

```tsx
// src/renderer-shared/tool-cards/JsonTreeCard.tsx
import { useState } from 'react';
import type { ResultView } from '@shared/tool-presenters';

type View = Extract<ResultView, { kind: 'tree' }>;

function summary(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).length}}`;
  if (typeof v === 'string') return `"${v.length > 32 ? v.slice(0, 32) + '…' : v}"`;
  return String(v);
}

function valueColor(v: unknown): string {
  if (typeof v === 'string') return 'text-emerald-300';
  if (typeof v === 'number') return 'text-amber-300';
  if (typeof v === 'boolean') return 'text-purple-300';
  if (v === null) return 'text-muted';
  return '';
}

function Node({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const isCollection = (value && typeof value === 'object') as boolean;
  if (!isCollection) {
    return (
      <div className="flex gap-1.5" style={{ paddingLeft: depth * 12 }}>
        {name !== undefined && <span className="text-sky-300">"{name}"</span>}
        {name !== undefined && <span className="text-muted">:</span>}
        <span className={valueColor(value)}>{typeof value === 'string' ? `"${value}"` : String(value)}</span>
      </div>
    );
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const)
                                       : Object.entries(value as Record<string, unknown>);
  return (
    <div style={{ paddingLeft: depth * 12 }}>
      <button type="button" onClick={() => setOpen(o => !o)} className="text-left">
        <span className="text-muted mr-1">{open ? '▾' : '▸'}</span>
        {name !== undefined && <span className="text-sky-300">"{name}"</span>}
        {name !== undefined && <span className="text-muted mx-1">:</span>}
        <span className="text-muted">{summary(value)}</span>
      </button>
      {open && entries.map(([k, v]) => (
        <Node key={k} name={k} value={v} depth={depth + 1} />
      ))}
    </div>
  );
}

export function JsonTreeCard({ view, compact }: { view: View; compact?: boolean }) {
  const fs = compact ? 'text-[10.5px]' : 'text-[11.5px]';
  return (
    <div className={`font-mono ${fs} bg-bg/60 rounded p-2 overflow-x-auto`}>
      <Node value={view.value} depth={0} />
    </div>
  );
}
```

- [ ] **Step 4: Wire into dispatcher** — replace the `tree` placeholder in `src/renderer-shared/tool-cards/index.tsx`.

- [ ] **Step 5: Run, expect PASS**

Run: `pnpm test JsonTreeCard`

- [ ] **Step 6: Commit**

```bash
git add src/renderer-shared/tool-cards
git commit -m "feat(tool-cards): recursive JSON tree card"
```

---

## Phase 4 — Surface integration

### Task 13: Wire the mobile remote to the dispatcher with compact mode

**Files:**
- Modify: `src/renderer-remote/tool-result-renderer.tsx`

- [ ] **Step 1: Replace contents**

```tsx
// src/renderer-remote/tool-result-renderer.tsx
import type { ResultView } from '../shared/tool-presenters';
import { ToolCardBody } from '../renderer-shared/tool-cards';

export function ToolResultRenderer({ view }: { view: ResultView }) {
  return <ToolCardBody view={view} compact />;
}
```

- [ ] **Step 2: Verify the alias works for the PWA build**

Run: `pnpm build:pwa`
Expected: PASS. If aliases differ, add `@shared` and `@renderer-shared` to `vite.config.pwa.ts`.

- [ ] **Step 3: Run integration smoke**

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer-remote/tool-result-renderer.tsx vite.config.pwa.ts
git commit -m "feat(tool-cards): mobile remote uses the same dispatcher (compact)"
```

---

### Task 14: Manual verification + final commit

**Files:** none

- [ ] **Step 1: Run full test suite**

```
pnpm test
pnpm typecheck
pnpm lint
```

Expected: all pass.

- [ ] **Step 2: Run the desktop dev app**

```
pnpm dev
```

Expected: launches. Use Otto as normal and trigger each tool kind:
- run a shell command (terminal card)
- ask it to read a file (code card)
- ask it to edit a file (diff card)
- ask it to glob (paths card)
- ask it to grep (matches card)
- ask it to search the web (search card)
- ask it to fetch a page (page card)
- click somewhere (click crosshair card)
- type something (typed card)
- press a key combo (keycaps card)

Verify each card body renders. Header chrome should look identical to before.

- [ ] **Step 3: Build the PWA and load on phone**

```
pnpm build:pwa
```

Open the remote on a phone and confirm cards render compactly.

- [ ] **Step 4: Update graphify**

Run: `graphify update .`
Expected: graph updated without API cost.

- [ ] **Step 5: Final commit if anything tweaked**

```bash
git status
# only commit if something changed during manual QA
```

---

## Self-Review

**Spec coverage:**
- ✅ Each new `ResultView` variant from spec is added in Task 1.
- ✅ Every recognizer in the spec's classification list is implemented across Tasks 3–7 (input-driven 3, file tools 4, Edit/Write→diff 5, web+github+tree 6, NotebookEdit 7).
- ✅ Every card listed in the per-card table has a creation task in Phase 3 (8: Terminal+Image, 9: Code/Diff/Notebook, 10: Paths/Matches/Search/Page/Github, 11: Click/KeyCaps/Typed/Tasks, 12: JsonTree).
- ✅ Shiki integration (lazy singleton) covered in Task 9.
- ✅ Streaming Bash live-tail covered in Task 8.
- ✅ Click crosshair (no overlay) covered in Task 11.
- ✅ JSON tree built in-house in Task 12.
- ✅ Mobile compact mode wired in Task 13.
- ✅ Overlay untouched (matches spec non-goal).
- ✅ `ToolCallCard` only gains a single-arg threading change (Task 7 step 4) — header preserved as the user required.

**Placeholders:** scanned — no `TBD`/`TODO`/"similar to Task N"/vague-validation phrases.

**Type consistency:** `ResultView`/`Hunk` names match across tasks; `ToolCardBody` name consistent; `useHighlighted` consistent across cards using Shiki; renderer prop signature `{ view; compact? }` consistent.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-28-tool-card-bodies.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
