import { describe, expect, it } from 'vitest';
import { detectDesktopEnvironment, detectDisplayServer, supportsAutoRegister } from './detect';

describe('detectDesktopEnvironment', () => {
  it('reads KDE from XDG_CURRENT_DESKTOP', () => {
    expect(detectDesktopEnvironment({ XDG_CURRENT_DESKTOP: 'KDE' })).toBe('kde');
  });
  it('reads KDE from a plasma DESKTOP_SESSION fallback', () => {
    expect(
      detectDesktopEnvironment({ DESKTOP_SESSION: '/usr/share/wayland-sessions/plasma.desktop' })
    ).toBe('kde');
  });
  it('reads GNOME', () => {
    expect(detectDesktopEnvironment({ XDG_CURRENT_DESKTOP: 'GNOME' })).toBe('gnome');
  });
  it('matches the first recognized token in a colon list', () => {
    expect(detectDesktopEnvironment({ XDG_CURRENT_DESKTOP: 'X-Generic:KDE' })).toBe('kde');
  });
  it('returns unknown when nothing is set', () => {
    expect(detectDesktopEnvironment({})).toBe('unknown');
  });
  it('returns other for unrecognized tokens', () => {
    expect(detectDesktopEnvironment({ XDG_CURRENT_DESKTOP: 'BudgieDesktop' })).toBe('other');
  });
});

describe('detectDisplayServer', () => {
  it('reads wayland', () => {
    expect(detectDisplayServer({ XDG_SESSION_TYPE: 'wayland' })).toBe('wayland');
  });
  it('reads x11', () => {
    expect(detectDisplayServer({ XDG_SESSION_TYPE: 'x11' })).toBe('x11');
  });
  it('returns unknown otherwise', () => {
    expect(detectDisplayServer({})).toBe('unknown');
  });
});

describe('supportsAutoRegister', () => {
  it('returns true only for KDE', () => {
    expect(supportsAutoRegister('kde')).toBe(true);
    expect(supportsAutoRegister('gnome')).toBe(false);
    expect(supportsAutoRegister('xfce')).toBe(false);
    expect(supportsAutoRegister('unknown')).toBe(false);
  });
});
