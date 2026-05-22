import type { Message, SessionMeta } from './messages';

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
  | { channel: 'window.collapseToBar'; args: void; result: void };

export type IpcChannel = IpcRequest['channel'];

export type SessionEvent =
  | { type: 'message-start'; sessionId: string; messageId: string }
  | { type: 'text-delta'; sessionId: string; messageId: string; text: string }
  | { type: 'tool-call-start'; sessionId: string; messageId: string; callId: string; name: string; input: unknown }
  | { type: 'tool-call-result'; sessionId: string; messageId: string; callId: string; result: unknown; isError: boolean }
  | { type: 'message-end'; sessionId: string; messageId: string }
  | { type: 'error'; sessionId: string; error: StructuredError }
  | { type: 'done'; sessionId: string };

export const SESSION_EVENT_CHANNEL = 'session.event';

export interface OttoBridge {
  invoke<C extends IpcChannel>(
    channel: C,
    args: Extract<IpcRequest, { channel: C }>['args']
  ): Promise<Extract<IpcRequest, { channel: C }>['result']>;
  onSessionEvent(handler: (event: SessionEvent) => void): () => void;
}

declare global {
  interface Window {
    otto: OttoBridge;
  }
}
