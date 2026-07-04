export type AutonomyMode = 'strict' | 'balanced' | 'full-allow';
export type ActionClass = 'read' | 'reversible' | 'destructive' | 'irreversible';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
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
  | { type: 'tool_denied'; callId: string; name: string; input: unknown; reason: string }
  | {
      type: 'sudo_prompt';
      callId: string;
      promptId: string;
      command: string;
      error?: string;
      status: 'pending' | 'unlocked' | 'cancelled' | 'failed';
    }
  | {
      type: 'process_output';
      handle: string;
      command: string;
      cwd: string;
      lines: Array<{ stream: 'stdout' | 'stderr'; data: string }>;
      status: 'running' | 'exited' | 'killed';
      exitCode: number | null;
    }
  | {
      type: 'memory-update';
      facts: number;
      playbooks: number;
      antiPatterns: number;
      heuristics: number;
      promoted: number;
      demoted: number;
    }
  | {
      type: 'image-ref';
      id: string;
      sessionId: string;
      path: string;
      width: number;
      height: number;
      mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
      source: 'screenshot' | 'user';
    };

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

export interface SystemMessage extends BaseMessage {
  role: 'system';
}

export type Message = UserMessage | AssistantMessage | ToolMessage | SystemMessage;

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

export function newUserMessage(
  text: string,
  attachments: Array<Extract<ContentBlock, { type: 'image-ref' }>> = [],
): UserMessage {
  const content: ContentBlock[] = [];
  if (text.length > 0) content.push({ type: 'text', text });
  for (const a of attachments) content.push(a);
  return {
    id: newId('msg'),
    sessionId: null,
    seq: 0,
    createdAt: Date.now(),
    role: 'user',
    content,
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

export function newSystemMessage(content: ContentBlock[]): SystemMessage {
  return {
    id: newId('msg'),
    sessionId: null,
    seq: 0,
    createdAt: Date.now(),
    role: 'system',
    content,
  };
}

export const isUserMessage = (m: Message): m is UserMessage => m.role === 'user';
export const isAssistantMessage = (m: Message): m is AssistantMessage => m.role === 'assistant';
export const isToolMessage = (m: Message): m is ToolMessage => m.role === 'tool';
export const isSystemMessage = (m: Message): m is SystemMessage => m.role === 'system';

export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export function extFromMime(m: ImageMimeType): 'png' | 'jpg' | 'webp' | 'gif' {
  switch (m) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
  }
}
