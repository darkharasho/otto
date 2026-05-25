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
