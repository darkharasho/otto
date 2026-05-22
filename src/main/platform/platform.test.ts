import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getPlatformAdapter } from './index';
import { LinuxAdapter } from './linux';

describe('getPlatformAdapter', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the Linux adapter on linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const adapter = getPlatformAdapter();
    expect(adapter).toBeInstanceOf(LinuxAdapter);
  });
});

describe('LinuxAdapter.detectDisplayServer', () => {
  it('reports wayland when XDG_SESSION_TYPE=wayland', () => {
    vi.stubEnv('XDG_SESSION_TYPE', 'wayland');
    const a = new LinuxAdapter();
    expect(a.detectDisplayServer()).toBe('wayland');
  });

  it('reports x11 when XDG_SESSION_TYPE=x11', () => {
    vi.stubEnv('XDG_SESSION_TYPE', 'x11');
    const a = new LinuxAdapter();
    expect(a.detectDisplayServer()).toBe('x11');
  });

  it('reports unknown when not set', () => {
    vi.stubEnv('XDG_SESSION_TYPE', '');
    const a = new LinuxAdapter();
    expect(a.detectDisplayServer()).toBe('unknown');
  });
});
