import { detectDesktopEnvironment, detectDisplayServer } from './detect';
import { buildToggleCommands } from './command';
import { openKeyboardSettings } from './open-settings';
import { isDevInstance } from '../instance';
import type { DesktopEnv, DisplayServer } from './detect';
import type { HotkeyState } from '../hotkey';

export interface ShortcutInfo {
  desktopEnv: DesktopEnv;
  displayServer: DisplayServer;
  /** Mechanism in use right now: kglobalaccel / global-shortcut / external-toggle / none. */
  mechanism: HotkeyState['mechanism'];
  /** True iff Otto's registration is live and the chord will fire. */
  registered: boolean;
  /** The recommended chord — what we register by default. */
  recommendedChord: string;
  /** Display name used in System Settings. */
  friendlyName: string;
  /** Exact toggle command for prod and (when running dev) dev builds. */
  commands: { prod: string; dev?: string };
}

export interface ShortcutDeps {
  recommendedChord: string;
  friendlyName: string;
  hotkeyState: HotkeyState;
}

export function gatherShortcutInfo(deps: ShortcutDeps): ShortcutInfo {
  const desktopEnv = detectDesktopEnvironment();
  const displayServer = detectDisplayServer();
  const dev = isDevInstance();
  const commands = buildToggleCommands({
    appImage: process.env.APPIMAGE,
    execPath: process.execPath,
    isDevInstance: dev,
  });
  return {
    desktopEnv,
    displayServer,
    mechanism: deps.hotkeyState.mechanism,
    registered: deps.hotkeyState.registered,
    recommendedChord: deps.recommendedChord,
    friendlyName: deps.friendlyName,
    commands,
  };
}

export { openKeyboardSettings };
export type { DesktopEnv, DisplayServer };
