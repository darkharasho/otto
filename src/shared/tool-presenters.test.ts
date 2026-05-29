import { describe, it, expect } from 'vitest';
import { describeTool, summarizeInput } from './tool-presenters';

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
    expect(classifyResult('mcp__some_server__do_thing', { number: 287, url: 'x', state: 'open' }, false)).toEqual({
      kind: 'kv',
      entries: [['number', '287'], ['url', 'x'], ['state', 'open']],
    });
  });
  it('nested object → tree fallback', () => {
    const big = { a: { b: { c: 1 } } };
    expect(classifyResult('whatever', big, false)).toEqual({ kind: 'tree', value: big });
  });
  it('classifies a result containing an image-ref block as an image view', () => {
    const result = {
      content: [
        { type: 'image-ref', id: 'abc', sessionId: 's1', path: '/tmp/x.png', width: 100, height: 50, mimeType: 'image/png', source: 'screenshot' as const },
        { type: 'text', text: '{"width":100}' },
      ],
    };
    const view = classifyResult('screenshot', result, false);
    expect(view).toEqual({ kind: 'image', src: 'otto-image://s1/abc.png', meta: '100×50' });
  });
});

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
    const view = classifyResult('Grep', res, false, { pattern: 'foo', output_mode: 'content' });
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

describe('classifyResult — NotebookEdit', () => {
  it('NotebookEdit → notebook view', () => {
    const view = classifyResult('NotebookEdit', { success: true }, false,
      { notebook_path: '/p/a.ipynb', cell_id: 4, cell_type: 'code', new_source: 'import x' });
    expect(view).toMatchObject({ kind: 'notebook', path: '/p/a.ipynb', cellType: 'code',
      text: 'import x', language: 'python' });
  });
});

describe('classifyResult — SDK content-block unwrapping', () => {
  it('unwraps {content:[{type:text,text:JSON}]} of a shell result', () => {
    const wrapped = {
      content: [{ type: 'text', text: JSON.stringify({ stdout: 'hi\n', exitCode: 0, durationMs: 5 }) }],
    };
    const view = classifyResult('shell_exec', wrapped, false, { command: 'echo hi' });
    expect(view).toEqual({ kind: 'terminal', command: 'echo hi', stdout: 'hi\n', exitCode: 0, durationMs: 5 });
  });
  it('unwraps a bare [{type:text,text:JSON}] array', () => {
    const wrapped = [{ type: 'text', text: JSON.stringify({ stdout: 'ok', exitCode: 0 }) }];
    const view = classifyResult('shell_exec', wrapped, false, { command: 'true' });
    expect(view).toMatchObject({ kind: 'terminal', stdout: 'ok', exitCode: 0 });
  });
  it('falls back to text when the wrapped payload is not JSON', () => {
    const wrapped = { content: [{ type: 'text', text: 'noted' }] };
    const view = classifyResult('knowledge_append', wrapped, false, { note: 'x' });
    expect(view).toEqual({ kind: 'json', value: 'noted' });
  });
  it('does NOT unwrap arrays that contain image-ref blocks (screenshot path)', () => {
    const wrapped = {
      content: [
        { type: 'image-ref', id: 'i', sessionId: 's', width: 100, height: 50 },
      ],
    };
    const view = classifyResult('mcp__otto-tools__screenshot', wrapped, false, {});
    expect(view.kind).toBe('image');
  });
});

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
