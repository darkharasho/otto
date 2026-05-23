import fs from 'node:fs/promises';
import path from 'node:path';
import type { AutonomyMode } from '@shared/messages';

const CURRENT_VERSION = 2;
const DEFAULT_MODE: AutonomyMode = 'balanced';
const VALID_MODES: AutonomyMode[] = ['strict', 'balanced', 'full-allow'];

export type WindowPosition = 'bottom-center' | 'top-center';
export const VALID_POSITIONS: WindowPosition[] = ['bottom-center', 'top-center'];

export interface NotificationPrefs {
  turnComplete: boolean;
  approval: boolean;
  sound: boolean;
}

export interface SettingsSnapshot {
  autonomy: { mode: AutonomyMode };
  notifications: NotificationPrefs;
  startAtLogin: boolean;
  windowPosition: WindowPosition;
  autoDeleteDays: number;
}

interface SettingsFileV1 {
  version: 1;
  autonomy: { mode: AutonomyMode };
}

interface SettingsFileV2 extends SettingsSnapshot {
  version: 2;
}

type SettingsFile = SettingsFileV1 | SettingsFileV2;

const DEFAULTS: SettingsSnapshot = {
  autonomy: { mode: DEFAULT_MODE },
  notifications: { turnComplete: true, approval: true, sound: false },
  startAtLogin: false,
  windowPosition: 'bottom-center',
  autoDeleteDays: 0,
};

type Listener = (snapshot: SettingsSnapshot) => void;

export class Settings {
  private state: SettingsSnapshot = { ...DEFAULTS };
  private listeners = new Set<Listener>();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    let parsed: unknown = null;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      parsed = JSON.parse(raw);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        await this.writeDefaults();
        return;
      }
      console.warn(`[settings] could not read ${this.filePath}, using defaults:`, err);
      await this.writeDefaults();
      return;
    }
    const migrated = this.applyParsed(parsed);
    if (migrated === false) {
      console.warn(`[settings] ${this.filePath} is malformed; using defaults`);
      await this.writeDefaults();
    } else if (migrated === 'migrated') {
      await this.writeFile();
    }
  }

  getMode(): AutonomyMode {
    return this.state.autonomy.mode;
  }
  getNotifications(): NotificationPrefs {
    return { ...this.state.notifications };
  }
  getStartAtLogin(): boolean {
    return this.state.startAtLogin;
  }
  getWindowPosition(): WindowPosition {
    return this.state.windowPosition;
  }
  getAutoDeleteDays(): number {
    return this.state.autoDeleteDays;
  }
  snapshot(): SettingsSnapshot {
    return {
      autonomy: { ...this.state.autonomy },
      notifications: { ...this.state.notifications },
      startAtLogin: this.state.startAtLogin,
      windowPosition: this.state.windowPosition,
      autoDeleteDays: this.state.autoDeleteDays,
    };
  }

  async setMode(mode: AutonomyMode): Promise<void> {
    if (!VALID_MODES.includes(mode)) throw new Error(`invalid mode: ${mode}`);
    this.state.autonomy.mode = mode;
    await this.persist();
  }

  async setNotifications(prefs: Partial<NotificationPrefs>): Promise<void> {
    this.state.notifications = { ...this.state.notifications, ...prefs };
    await this.persist();
  }

  async setStartAtLogin(enabled: boolean): Promise<void> {
    this.state.startAtLogin = !!enabled;
    await this.persist();
  }

  async setWindowPosition(position: WindowPosition): Promise<void> {
    if (!VALID_POSITIONS.includes(position)) throw new Error(`invalid position: ${position}`);
    this.state.windowPosition = position;
    await this.persist();
  }

  async setAutoDeleteDays(days: number): Promise<void> {
    if (!Number.isFinite(days) || days < 0) throw new Error(`invalid autoDeleteDays: ${days}`);
    this.state.autoDeleteDays = Math.floor(days);
    await this.persist();
  }

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private async persist(): Promise<void> {
    await this.writeFile();
    for (const fn of this.listeners) fn(this.snapshot());
  }

  private applyParsed(parsed: unknown): false | 'ok' | 'migrated' {
    if (!parsed || typeof parsed !== 'object') return false;
    const obj = parsed as Partial<SettingsFile>;
    const version = obj.version;

    if (version === 1) {
      const m = (obj as SettingsFileV1).autonomy?.mode;
      if (!m || !VALID_MODES.includes(m)) return false;
      this.state = { ...DEFAULTS, autonomy: { mode: m } };
      return 'migrated';
    }
    if (version === CURRENT_VERSION) {
      const o = obj as SettingsFileV2;
      const m = o.autonomy?.mode;
      if (!m || !VALID_MODES.includes(m)) return false;
      this.state = {
        autonomy: { mode: m },
        notifications: {
          turnComplete: o.notifications?.turnComplete !== false,
          approval: o.notifications?.approval !== false,
          sound: !!o.notifications?.sound,
        },
        startAtLogin: !!o.startAtLogin,
        windowPosition: VALID_POSITIONS.includes(o.windowPosition as WindowPosition)
          ? o.windowPosition
          : DEFAULTS.windowPosition,
        autoDeleteDays:
          Number.isFinite(o.autoDeleteDays) && o.autoDeleteDays >= 0
            ? Math.floor(o.autoDeleteDays)
            : DEFAULTS.autoDeleteDays,
      };
      return 'ok';
    }
    return false;
  }

  private async writeDefaults(): Promise<void> {
    this.state = { ...DEFAULTS };
    await this.writeFile();
  }

  private async writeFile(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const payload: SettingsFileV2 = { version: CURRENT_VERSION, ...this.snapshot() };
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2));
    await fs.rename(tmp, this.filePath);
  }
}
