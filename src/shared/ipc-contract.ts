import type { ActionClass, AutonomyMode, Message, SessionMeta } from './messages';

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
}

export interface SessionCancelArgs {
  sessionId: string;
}

export interface SessionLoadArgs {
  sessionId: string;
}

export type IpcRequest =
  | { channel: 'session.start'; args: SessionStartArgs; result: SessionStartResult }
  | { channel: 'session.send'; args: SessionSendArgs; result: void }
  | { channel: 'session.cancel'; args: SessionCancelArgs; result: void }
  | { channel: 'session.list'; args: void; result: SessionMeta[] }
  | { channel: 'session.load'; args: SessionLoadArgs; result: Message[] }
  | { channel: 'window.setMode'; args: { mode: 'bar' | 'panel' }; result: void }
  | { channel: 'window.hide'; args: void; result: void }
  | {
      channel: 'autonomy.decide';
      args: { decisionId: string; decision: 'approve' | 'approve-session' | 'deny' };
      result: void;
    }
  | { channel: 'autonomy.getMode'; args: void; result: AutonomyMode }
  | { channel: 'autonomy.setMode'; args: { mode: AutonomyMode }; result: void }
  | { channel: 'shell.kill'; args: { handle: string }; result: { killed: boolean } };

export type IpcChannel = IpcRequest['channel'];

export type SessionEvent =
  | { type: 'message-start'; sessionId: string; messageId: string }
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
  | { type: 'process-killed'; sessionId: string; messageId: string; handle: string };

export const SESSION_EVENT_CHANNEL = 'session.event';

export const AUTONOMY_EVENT_CHANNEL = 'autonomy.event';

export type AutonomyEvent =
  | { type: 'mode-changed'; mode: AutonomyMode };

export interface OttoBridge {
  invoke<C extends IpcChannel>(
    channel: C,
    args: Extract<IpcRequest, { channel: C }>['args']
  ): Promise<Extract<IpcRequest, { channel: C }>['result']>;
  onSessionEvent(handler: (event: SessionEvent) => void): () => void;
  onAutonomyEvent(handler: (event: AutonomyEvent) => void): () => void;
}

declare global {
  interface Window {
    otto: OttoBridge;
  }
}
