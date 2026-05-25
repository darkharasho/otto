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
