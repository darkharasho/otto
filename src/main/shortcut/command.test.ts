import { describe, expect, it } from 'vitest';
import { buildToggleCommands } from './command';

describe('buildToggleCommands', () => {
  it('prefers APPIMAGE over execPath for prod', () => {
    const cmd = buildToggleCommands({
      appImage: '/home/user/AppImages/otto.appimage',
      execPath: '/tmp/.mount_xxx/otto',
      isDevInstance: false,
    });
    expect(cmd.prod).toBe('/home/user/AppImages/otto.appimage toggle');
    expect(cmd.dev).toBeUndefined();
  });

  it('falls back to execPath when APPIMAGE is absent', () => {
    const cmd = buildToggleCommands({
      execPath: '/opt/Otto/otto',
      isDevInstance: false,
    });
    expect(cmd.prod).toBe('/opt/Otto/otto toggle');
  });

  it('emits a dev command pointing at the repo for dev installs', () => {
    const cmd = buildToggleCommands({
      execPath: '/usr/bin/electron',
      isDevInstance: true,
      repoRoot: '/home/user/code/otto',
    });
    expect(cmd.dev).toBe('node /home/user/code/otto/out/main/index.js toggle --dev');
  });

  it('single-quotes paths with spaces', () => {
    const cmd = buildToggleCommands({
      appImage: '/home/Some User/AppImages/otto.appimage',
      execPath: '/ignored',
      isDevInstance: false,
    });
    expect(cmd.prod).toBe("'/home/Some User/AppImages/otto.appimage' toggle");
  });

  it('escapes single quotes inside paths', () => {
    const cmd = buildToggleCommands({
      appImage: "/home/o'malley/otto.appimage",
      execPath: '/ignored',
      isDevInstance: false,
    });
    expect(cmd.prod).toBe(`'/home/o'\\''malley/otto.appimage' toggle`);
  });
});
