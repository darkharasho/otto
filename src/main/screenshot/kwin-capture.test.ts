import { describe, it, expect, vi } from 'vitest';

vi.mock('../logger', () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

import { desktopEntryContents, kwinCaptureSupported, packRows } from './kwin-capture';

describe('kwinCaptureSupported', () => {
  const linux = process.platform === 'linux';
  it.runIf(linux)('needs a KDE Wayland session', () => {
    expect(kwinCaptureSupported({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE' })).toBe(true);
    expect(kwinCaptureSupported({ XDG_SESSION_TYPE: 'x11', XDG_CURRENT_DESKTOP: 'KDE' })).toBe(false);
    expect(kwinCaptureSupported({ XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'GNOME' })).toBe(false);
  });

  it.runIf(linux)('can be switched off by env', () => {
    expect(kwinCaptureSupported({
      XDG_SESSION_TYPE: 'wayland', XDG_CURRENT_DESKTOP: 'KDE', OTTO_DISABLE_KWIN_CAPTURE: '1',
    })).toBe(false);
  });
});

describe('desktopEntryContents', () => {
  it('authorizes ScreenShot2 for the given executable without showing in menus', () => {
    const text = desktopEntryContents('/opt/Otto/otto');
    expect(text).toContain('Exec=/opt/Otto/otto\n');
    expect(text).toContain('X-KDE-DBUS-Restricted-Interfaces=org.kde.KWin.ScreenShot2');
    expect(text).toContain('NoDisplay=true');
  });
});

describe('packRows', () => {
  it('returns the buffer unchanged when the stride is tight', () => {
    const src = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(packRows(src, 1, 2, 4)).toEqual(src);
  });

  it('drops row padding', () => {
    // width 1 (4 bytes/row), stride 8: each row has 4 bytes of padding.
    const src = Buffer.from([1, 2, 3, 4, 0, 0, 0, 0, 5, 6, 7, 8, 0, 0, 0, 0]);
    expect([...packRows(src, 1, 2, 8)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
