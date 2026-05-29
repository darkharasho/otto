import type { ActionClass, AutonomyMode, ContentBlock, Message, SessionMeta } from './messages';

export type WindowMode = 'bar' | 'panel' | 'chat';

export type ErrorKind =
  | 'auth-missing'
  | 'sdk-stream'
  | 'cancelled'
  | 'internal';

export interface StructuredError {
  kind: ErrorKind;
  message: string;
  retryable: boolean;
}

export interface SessionStartArgs {
  resume?: string;
  model?: string;
}
export interface SessionStartResult {
  sessionId: string;
}

export interface SessionSendArgs {
  sessionId: string;
  text: string;
  attachments?: Array<Extract<ContentBlock, { type: 'image-ref' }>>;
}

export interface UploadsStageArgs {
  sessionId: string;
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
}
export type UploadsStageResult = Extract<ContentBlock, { type: 'image-ref' }>;

export interface UploadsDiscardArgs { path: string; sessionId: string; }

export interface SessionCancelArgs {
  sessionId: string;
}

/** @deprecated Use SessionInterruptArgs */
export interface SessionInterruptArgs {
  sessionId: string;
}

export interface SessionLoadArgs {
  sessionId: string;
}

export interface SessionEnsureForSubmitArgs {
  current: string | null;
  model?: string;
}

export interface SessionEnsureForSubmitResult {
  sessionId: string;
  isNew: boolean;
  reason: 'reused' | 'idle-timeout' | 'manual' | 'no-session';
}

export interface TopicShiftEvaluateArgs {
  sessionId: string;
  newPrompt: string;
}

export interface TopicShiftEvaluateResult {
  suggest: boolean;
  similarity: number; // may be NaN if detector was unavailable/errored
}

export type IpcRequest =
  | { channel: 'session.start'; args: SessionStartArgs; result: SessionStartResult }
  | { channel: 'session.send'; args: SessionSendArgs; result: void }
  | { channel: 'session.cancel'; args: SessionCancelArgs; result: void }
  | { channel: 'session.interrupt'; args: SessionInterruptArgs; result: void }
  | { channel: 'session.close'; args: { sessionId: string }; result: void }
  | {
      channel: 'topicShift.evaluate';
      args: TopicShiftEvaluateArgs;
      result: TopicShiftEvaluateResult;
    }
  | { channel: 'session.list'; args: void; result: SessionMeta[] }
  | { channel: 'session.load'; args: SessionLoadArgs; result: Message[] }
  | {
      channel: 'session.ensureForSubmit';
      args: SessionEnsureForSubmitArgs;
      result: SessionEnsureForSubmitResult;
    }
  | { channel: 'window.setMode'; args: { mode: WindowMode }; result: void }
  | { channel: 'window.hide'; args: void; result: void }
  | { channel: 'window.cycleDisplay'; args: { direction: 'next' | 'prev' }; result: void }
  | {
      channel: 'autonomy.decide';
      args: { decisionId: string; decision: 'approve' | 'approve-session' | 'deny' };
      result: void;
    }
  | { channel: 'autonomy.getMode'; args: void; result: AutonomyMode }
  | { channel: 'autonomy.setMode'; args: { mode: AutonomyMode }; result: void }
  | { channel: 'settings.get'; args: void; result: SettingsView }
  | {
      channel: 'settings.setNotifications';
      args: Partial<{ turnComplete: boolean; approval: boolean; sound: boolean }>;
      result: void;
    }
  | { channel: 'settings.setStartAtLogin'; args: { enabled: boolean }; result: void }
  | {
      channel: 'settings.setWindowPosition';
      args: { position: 'bottom-center' | 'top-center' };
      result: void;
    }
  | {
      channel: 'settings.setDisplayTarget';
      args: { target: 'cursor' | 'primary' };
      result: void;
    }
  | { channel: 'settings.setAutoDeleteDays'; args: { days: number }; result: void }
  | { channel: 'settings.setHideOnBlur'; args: { enabled: boolean }; result: void }
  | { channel: 'settings.setNewConversationIdleTimeoutMinutes'; args: { minutes: number }; result: void }
  | { channel: 'settings.openLogsDir'; args: void; result: void }
  | { channel: 'settings.resetAllSessions'; args: void; result: { deleted: number } }
  | { channel: 'shell.kill'; args: { handle: string }; result: { killed: boolean } }
  | { channel: 'shortcut.info'; args: void; result: ShortcutInfoView }
  | { channel: 'shortcut.openKeyboardSettings'; args: void; result: { launched: boolean } }
  | { channel: 'app.info'; args: void; result: AppInfo }
  | {
      channel: 'memory.list';
      args: {
        kind: 'fact' | 'playbook' | 'anti_pattern' | 'heuristic';
        query?: string;
        includeArchived?: boolean;
      };
      result: MemoryListResult;
    }
  | { channel: 'memory.get'; args: { id: string }; result: MemoryArtifactView | null }
  | {
      channel: 'memory.update';
      args: {
        id: string;
        patch: { title?: string; body?: string; tags?: string[]; archived?: boolean };
      };
      result: void;
    }
  | { channel: 'memory.delete'; args: { id: string }; result: void }
  | { channel: 'remoteDesktop.status'; args: void; result: { granted: boolean } }
  | { channel: 'remoteDesktop.revoke'; args: void; result: void }
  | { channel: 'remote:getStatus'; args: undefined; result: RemoteStatus }
  | { channel: 'remote:setEnabled'; args: { enabled: boolean }; result: void }
  | { channel: 'remote:setRemoteCeiling'; args: { ceiling: RemoteCeilingChoice }; result: void }
  | { channel: 'remote:mintPairingCode'; args: undefined; result: PairingCodePayload }
  | { channel: 'remote:listDevices'; args: undefined; result: PairedDeviceSummary[] }
  | { channel: 'remote:revokeDevice'; args: { deviceId: string }; result: void }
  | { channel: 'uploads.stage'; args: UploadsStageArgs; result: UploadsStageResult }
  | { channel: 'uploads.discard'; args: UploadsDiscardArgs; result: void };

export type RemoteCeilingChoice = 'match' | 'strict' | 'balanced' | 'full-allow';

export interface RemoteStatus {
  running: boolean;
  url: string | null;
  reason: string | null;
  enabled: boolean;
  remoteCeiling: RemoteCeilingChoice;
  pairedCount: number;
}

export interface PairedDeviceSummary {
  id: string;
  label: string;
  pairedAt: number;
  lastSeenAt: number | null;
}

export interface PairingCodePayload {
  code: string;
  url: string;
  expiresAt: number;
}

export interface RemoteBridge {
  getStatus(): Promise<RemoteStatus>;
  setEnabled(enabled: boolean): Promise<void>;
  setRemoteCeiling(ceiling: RemoteCeilingChoice): Promise<void>;
  mintPairingCode(): Promise<PairingCodePayload>;
  listDevices(): Promise<PairedDeviceSummary[]>;
  revokeDevice(deviceId: string): Promise<void>;
}

export interface AppInfo {
  isDev: boolean;
  displayName: string;
  version: string;
}

export interface ShortcutInfoView {
  desktopEnv: 'kde' | 'gnome' | 'xfce' | 'cinnamon' | 'mate' | 'hyprland' | 'sway' | 'macos' | 'other' | 'unknown';
  displayServer: 'x11' | 'wayland' | 'unknown';
  mechanism: 'global-shortcut' | 'external-toggle' | 'none';
  registered: boolean;
  recommendedChord: string;
  friendlyName: string;
  commands: { prod: string; dev?: string };
}

export interface SettingsView {
  autonomy: { mode: AutonomyMode };
  notifications: { turnComplete: boolean; approval: boolean; sound: boolean };
  startAtLogin: boolean;
  windowPosition: 'bottom-center' | 'top-center';
  displayTarget: 'cursor' | 'primary';
  autoDeleteDays: number;
  hideOnBlur: boolean;
  newConversation: { idleTimeoutMinutes: number };
  version: string;
}

export type IpcChannel = IpcRequest['channel'];

export type SessionEvent =
  | { type: 'message-start'; sessionId: string; messageId: string }
  | { type: 'user-message'; sessionId: string; messageId: string; text: string; content?: ContentBlock[] }
  | { type: 'system-message'; sessionId: string; message: Message }
  | { type: 'text-delta'; sessionId: string; messageId: string; text: string }
  | { type: 'tool-call-start'; sessionId: string; messageId: string; callId: string; name: string; input: unknown }
  | { type: 'tool-call-result'; sessionId: string; messageId: string; callId: string; result: unknown; isError: boolean }
  | { type: 'message-end'; sessionId: string; messageId: string }
  | { type: 'message-cancelled'; sessionId: string; messageId: string }
  | { type: 'error'; sessionId: string; error: StructuredError }
  | { type: 'done'; sessionId: string }
  | {
      type: 'tool-call-pending';
      sessionId: string;
      messageId: string;
      callId: string;
      decisionId: string;
      name: string;
      input: unknown;
      actionClass: ActionClass;
      reason: string;
    }
  | {
      type: 'tool-call-decided';
      sessionId: string;
      messageId: string;
      callId: string;
      decisionId: string;
      decision: 'approve' | 'approve-session' | 'deny';
    }
  | {
      type: 'tool-call-denied';
      sessionId: string;
      messageId: string;
      callId: string;
      name: string;
      input: unknown;
      reason: string;
    }
  | { type: 'process-spawned'; sessionId: string; messageId: string; handle: string; pid: number; command: string; cwd: string }
  | { type: 'process-stdout'; sessionId: string; messageId: string; handle: string; data: string }
  | { type: 'process-stderr'; sessionId: string; messageId: string; handle: string; data: string }
  | {
      type: 'process-exited';
      sessionId: string;
      messageId: string;
      handle: string;
      exitCode: number | null;
      signal: string | null;
    }
  | { type: 'process-killed'; sessionId: string; messageId: string; handle: string }
  | { type: 'user-message-queued'; sessionId: string; messageId: string; queueDepth: number }
  | { type: 'user-message-consumed'; sessionId: string; messageId: string; queueDepth: number };

export const SESSION_EVENT_CHANNEL = 'session.event';

export const AUTONOMY_EVENT_CHANNEL = 'autonomy.event';

export type AutonomyEvent =
  | { type: 'mode-changed'; mode: AutonomyMode };

export type UpdaterState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

export const UPDATER_EVENT_CHANNEL = 'updater:state';

export interface UpdaterBridge {
  status(): Promise<UpdaterState>;
  check(): Promise<UpdaterState>;
  download(): Promise<UpdaterState>;
  install(): Promise<void>;
  onStateChange(cb: (state: UpdaterState) => void): () => void;
}

export interface OttoBridge {
  invoke<C extends IpcChannel>(
    channel: C,
    args: Extract<IpcRequest, { channel: C }>['args']
  ): Promise<Extract<IpcRequest, { channel: C }>['result']>;
  onSessionEvent(handler: (event: SessionEvent) => void): () => void;
  onAutonomyEvent(handler: (event: AutonomyEvent) => void): () => void;
  updater: UpdaterBridge;
  remote: RemoteBridge;
}

declare global {
  interface Window {
    otto: OttoBridge;
  }
}

export interface MemoryArtifactView {
  id: string;
  kind: 'playbook' | 'anti_pattern' | 'heuristic';
  title: string;
  body: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  useCount: number;
  lastUsedAt: number | null;
  archived: boolean;
}

export interface MemoryFactView {
  id: string;
  body: string;
  pinned: boolean;
  useCount: number;
  lastUsedAt: number | null;
}

export interface MemoryListResult {
  artifacts: MemoryArtifactView[];
  facts: MemoryFactView[];
}
