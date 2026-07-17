import fs from 'node:fs/promises';
import path from 'node:path';
import type { AutonomyMode } from '@shared/messages';
import type { ChatBounds, WindowMode } from '@shared/ipc-contract';
import { DEFAULT_TTS_VOICE, DEFAULT_TTS_SPEED } from '@shared/voice-catalog';
import {
  TOPIC_SHIFT_SENSITIVITIES,
  type TopicShiftSensitivity,
} from '@shared/topic-shift-constants';

const CURRENT_VERSION = 7;
const DEFAULT_MODE: AutonomyMode = 'balanced';
const VALID_MODES: AutonomyMode[] = ['strict', 'balanced', 'full-allow'];

export type WindowPosition = 'bottom-center' | 'top-center';
export const VALID_POSITIONS: WindowPosition[] = ['bottom-center', 'top-center'];

export type DisplayTarget = 'cursor' | 'primary';
export const VALID_DISPLAY_TARGETS: DisplayTarget[] = ['cursor', 'primary'];

export interface NotificationPrefs {
  turnComplete: boolean;
  approval: boolean;
  sound: boolean;
}

export interface NewConversationPrefs {
  idleTimeoutMinutes: number; // 0 disables
}

export type WhisperModel = 'base.en' | 'small.en';

export interface VoicePrefs {
  ttsVoice: string;
  speed: number;
  whisperModel: WhisperModel;
  /** How long (ms) Otto waits after speech stops before transcribing. [300, 1500] */
  endpointMs: number;
}

export interface SettingsSnapshot {
  autonomy: { mode: AutonomyMode };
  notifications: NotificationPrefs;
  startAtLogin: boolean;
  windowPosition: WindowPosition;
  displayTarget: DisplayTarget;
  autoDeleteDays: number;
  hideOnBlur: boolean;
  showReasoning: boolean;
  newConversation: NewConversationPrefs;
  chatBounds: ChatBounds | null;
  lastVisibleMode: WindowMode;
  pinnedSessionIds: string[];
  voice: VoicePrefs;
  topicShiftSensitivity: TopicShiftSensitivity;
}

interface SettingsFileV1 {
  version: 1;
  autonomy: { mode: AutonomyMode };
}

interface SettingsFileV2 extends Omit<SettingsSnapshot, 'displayTarget'> {
  version: 2;
}

interface SettingsFileV3 extends SettingsSnapshot {
  version: 3;
}

interface SettingsFileV4 extends Omit<SettingsSnapshot, 'chatBounds' | 'lastVisibleMode' | 'pinnedSessionIds'> {
  version: 4;
}

interface SettingsFileV5 extends Omit<SettingsSnapshot, 'voice'> {
  version: 5;
}

interface SettingsFileV6 extends Omit<SettingsSnapshot, 'topicShiftSensitivity'> {
  version: 6;
}

interface SettingsFileV7 extends SettingsSnapshot {
  version: 7;
}

type SettingsFile =
  | SettingsFileV1
  | SettingsFileV2
  | SettingsFileV3
  | SettingsFileV4
  | SettingsFileV5
  | SettingsFileV6
  | SettingsFileV7;

const DEFAULTS: SettingsSnapshot = {
  autonomy: { mode: DEFAULT_MODE },
  notifications: { turnComplete: true, approval: true, sound: false },
  startAtLogin: false,
  windowPosition: 'bottom-center',
  displayTarget: 'cursor',
  autoDeleteDays: 0,
  hideOnBlur: false,
  showReasoning: true,
  newConversation: { idleTimeoutMinutes: 60 },
  chatBounds: null,
  lastVisibleMode: 'bar',
  pinnedSessionIds: [],
  voice: { ttsVoice: DEFAULT_TTS_VOICE, speed: DEFAULT_TTS_SPEED, whisperModel: 'small.en', endpointMs: 650 },
  topicShiftSensitivity: 'low',
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
  getDisplayTarget(): DisplayTarget {
    return this.state.displayTarget;
  }
  getAutoDeleteDays(): number {
    return this.state.autoDeleteDays;
  }
  getHideOnBlur(): boolean {
    return this.state.hideOnBlur;
  }
  getShowReasoning(): boolean {
    return this.state.showReasoning;
  }
  getNewConversationIdleTimeoutMinutes(): number {
    return this.state.newConversation.idleTimeoutMinutes;
  }
  getTopicShiftSensitivity(): TopicShiftSensitivity {
    return this.state.topicShiftSensitivity;
  }
  snapshot(): SettingsSnapshot {
    return {
      autonomy: { ...this.state.autonomy },
      notifications: { ...this.state.notifications },
      startAtLogin: this.state.startAtLogin,
      windowPosition: this.state.windowPosition,
      displayTarget: this.state.displayTarget,
      autoDeleteDays: this.state.autoDeleteDays,
      hideOnBlur: this.state.hideOnBlur,
      showReasoning: this.state.showReasoning,
      newConversation: { ...this.state.newConversation },
      chatBounds: this.state.chatBounds ? { ...this.state.chatBounds } : null,
      lastVisibleMode: this.state.lastVisibleMode,
      pinnedSessionIds: [...this.state.pinnedSessionIds],
      voice: { ...this.state.voice },
      topicShiftSensitivity: this.state.topicShiftSensitivity,
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

  async setDisplayTarget(target: DisplayTarget): Promise<void> {
    if (!VALID_DISPLAY_TARGETS.includes(target)) throw new Error(`invalid display target: ${target}`);
    this.state.displayTarget = target;
    await this.persist();
  }

  async setAutoDeleteDays(days: number): Promise<void> {
    if (!Number.isFinite(days) || days < 0) throw new Error(`invalid autoDeleteDays: ${days}`);
    this.state.autoDeleteDays = Math.floor(days);
    await this.persist();
  }

  async setHideOnBlur(enabled: boolean): Promise<void> {
    this.state.hideOnBlur = !!enabled;
    await this.persist();
  }

  async setShowReasoning(enabled: boolean): Promise<void> {
    this.state.showReasoning = !!enabled;
    await this.persist();
  }

  async setNewConversationIdleTimeoutMinutes(minutes: number): Promise<void> {
    if (!Number.isFinite(minutes) || minutes < 0) {
      throw new Error(`invalid idleTimeoutMinutes: ${minutes}`);
    }
    this.state.newConversation = { idleTimeoutMinutes: Math.floor(minutes) };
    await this.persist();
  }

  async setTopicShiftSensitivity(sensitivity: TopicShiftSensitivity): Promise<void> {
    if (!TOPIC_SHIFT_SENSITIVITIES.includes(sensitivity)) {
      throw new Error(`invalid topicShiftSensitivity: ${sensitivity}`);
    }
    this.state.topicShiftSensitivity = sensitivity;
    await this.persist();
  }

  getChatBounds(): ChatBounds | null {
    return this.state.chatBounds ? { ...this.state.chatBounds } : null;
  }

  async setChatBounds(bounds: ChatBounds | null): Promise<void> {
    this.state.chatBounds = bounds ? { ...bounds } : null;
    await this.persist();
  }

  getLastVisibleMode(): WindowMode {
    return this.state.lastVisibleMode;
  }

  async setLastVisibleMode(mode: WindowMode): Promise<void> {
    if (mode !== 'bar' && mode !== 'panel' && mode !== 'chat') {
      throw new Error(`invalid lastVisibleMode: ${mode}`);
    }
    this.state.lastVisibleMode = mode;
    await this.persist();
  }

  getPinnedSessionIds(): string[] {
    return [...this.state.pinnedSessionIds];
  }

  async setPinnedSessionIds(ids: string[]): Promise<void> {
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
      throw new Error(`invalid pinnedSessionIds`);
    }
    this.state.pinnedSessionIds = [...ids];
    await this.persist();
  }

  getVoicePrefs(): VoicePrefs {
    return { ...this.state.voice };
  }

  async setVoicePrefs(prefs: Partial<VoicePrefs>): Promise<void> {
    this.state.voice = { ...this.state.voice, ...prefs };
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
    if (
      version === 2 ||
      version === 3 ||
      version === 4 ||
      version === 5 ||
      version === 6 ||
      version === CURRENT_VERSION
    ) {
      const o = obj as Omit<SettingsFileV2, 'version'> &
        Partial<Omit<SettingsFileV7, 'version'>>;
      const m = o.autonomy?.mode;
      if (!m || !VALID_MODES.includes(m)) return false;
      const idle = o.newConversation?.idleTimeoutMinutes;
      const cb = (o as { chatBounds?: unknown }).chatBounds;
      const chatBounds: ChatBounds | null =
        cb && typeof cb === 'object' &&
        typeof (cb as ChatBounds).x === 'number' &&
        typeof (cb as ChatBounds).y === 'number' &&
        typeof (cb as ChatBounds).width === 'number' &&
        typeof (cb as ChatBounds).height === 'number'
          ? (cb as ChatBounds)
          : null;
      const lvm = (o as { lastVisibleMode?: unknown }).lastVisibleMode;
      const lastVisibleMode: WindowMode =
        lvm === 'bar' || lvm === 'panel' || lvm === 'chat' ? lvm : DEFAULTS.lastVisibleMode;
      const psi = (o as { pinnedSessionIds?: unknown }).pinnedSessionIds;
      const pinnedSessionIds: string[] =
        Array.isArray(psi) && psi.every((id) => typeof id === 'string')
          ? psi
          : DEFAULTS.pinnedSessionIds;
      const rawVoice = (o as { voice?: unknown }).voice;
      const rawVoiceObj = rawVoice && typeof rawVoice === 'object' ? (rawVoice as Record<string, unknown>) : null;
      const whisperModel: WhisperModel =
        rawVoiceObj?.whisperModel === 'base.en' || rawVoiceObj?.whisperModel === 'small.en'
          ? (rawVoiceObj.whisperModel as WhisperModel)
          : DEFAULTS.voice.whisperModel;
      const endpointMs: number =
        typeof rawVoiceObj?.endpointMs === 'number' &&
        Number.isFinite(rawVoiceObj.endpointMs) &&
        rawVoiceObj.endpointMs >= 300 &&
        rawVoiceObj.endpointMs <= 1500
          ? rawVoiceObj.endpointMs
          : DEFAULTS.voice.endpointMs;
      const voice: VoicePrefs =
        rawVoiceObj &&
        typeof rawVoiceObj.ttsVoice === 'string' &&
        typeof rawVoiceObj.speed === 'number'
          ? { ttsVoice: rawVoiceObj.ttsVoice as string, speed: rawVoiceObj.speed as number, whisperModel, endpointMs }
          : DEFAULTS.voice;
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
        displayTarget: VALID_DISPLAY_TARGETS.includes(o.displayTarget as DisplayTarget)
          ? (o.displayTarget as DisplayTarget)
          : DEFAULTS.displayTarget,
        autoDeleteDays:
          Number.isFinite(o.autoDeleteDays) && o.autoDeleteDays >= 0
            ? Math.floor(o.autoDeleteDays)
            : DEFAULTS.autoDeleteDays,
        hideOnBlur: typeof o.hideOnBlur === 'boolean' ? o.hideOnBlur : DEFAULTS.hideOnBlur,
        showReasoning:
          typeof o.showReasoning === 'boolean' ? o.showReasoning : DEFAULTS.showReasoning,
        newConversation: {
          idleTimeoutMinutes:
            Number.isFinite(idle) && (idle as number) >= 0
              ? Math.floor(idle as number)
              : DEFAULTS.newConversation.idleTimeoutMinutes,
        },
        chatBounds,
        lastVisibleMode,
        pinnedSessionIds,
        voice,
        topicShiftSensitivity: TOPIC_SHIFT_SENSITIVITIES.includes(
          (o as { topicShiftSensitivity?: unknown }).topicShiftSensitivity as TopicShiftSensitivity,
        )
          ? ((o as { topicShiftSensitivity?: unknown }).topicShiftSensitivity as TopicShiftSensitivity)
          : DEFAULTS.topicShiftSensitivity,
      };
      return version === CURRENT_VERSION ? 'ok' : 'migrated';
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
    const payload: SettingsFileV7 = { version: CURRENT_VERSION, ...this.snapshot() };
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2));
    await fs.rename(tmp, this.filePath);
  }
}
