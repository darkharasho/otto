export type AutonomyMode = 'strict' | 'balanced' | 'full-allow';
export type ActionClass = 'read' | 'reversible' | 'destructive' | 'irreversible';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; callId: string; name: string; input: unknown }
  | { type: 'tool_result'; callId: string; result: unknown; isError?: boolean }
  | {
      type: 'pending_tool_use';
      callId: string;
      decisionId: string;
      name: string;
      input: unknown;
      actionClass: ActionClass;
      reason: string;
      decision: 'pending' | 'approved' | 'approved-session' | 'denied';
    }
  | { type: 'tool_denied'; callId: string; name: string; input: unknown; reason: string };

export interface BaseMessage {
  id: string;
  sessionId: string | null;
  seq: number;
  createdAt: number;
  content: ContentBlock[];
}

export interface UserMessage extends BaseMessage {
  role: 'user';
}

export interface AssistantMessage extends BaseMessage {
  role: 'assistant';
  cancelled: boolean;
  errored: boolean;
}

export interface ToolMessage extends BaseMessage {
  role: 'tool';
}

export type Message = UserMessage | AssistantMessage | ToolMessage;

export interface SessionMeta {
  id: string;
  title: string | null;
  createdAt: number;
  lastActive: number;
  model: string;
  status: 'active' | 'idle' | 'ended';
  sdkSessionId: string | null;
}

let counter = 0;
function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function newUserMessage(text: string): UserMessage {
  return {
    id: newId('msg'),
    sessionId: null,
    seq: 0,
    createdAt: Date.now(),
    role: 'user',
    content: [{ type: 'text', text }],
  };
}

export function newAssistantMessage(): AssistantMessage {
  return {
    id: newId('msg'),
    sessionId: null,
    seq: 0,
    createdAt: Date.now(),
    role: 'assistant',
    content: [],
    cancelled: false,
    errored: false,
  };
}

export const isUserMessage = (m: Message): m is UserMessage => m.role === 'user';
export const isAssistantMessage = (m: Message): m is AssistantMessage => m.role === 'assistant';
export const isToolMessage = (m: Message): m is ToolMessage => m.role === 'tool';
