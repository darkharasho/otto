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
