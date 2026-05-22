import { create } from 'zustand';
import type { SessionEvent, StructuredError } from '@shared/ipc-contract';
import type { AssistantMessage, ContentBlock, Message, SessionMeta, UserMessage } from '@shared/messages';

export type WindowMode = 'bar' | 'panel';

export interface ActiveSessionState {
  id: string;
  messages: Message[];
  streaming: boolean;
  error: StructuredError | null;
}

interface OttoState {
  windowMode: WindowMode;
  activeSession: ActiveSessionState | null;
  sessions: SessionMeta[];

  setWindowMode(mode: WindowMode): void;
  beginSession(id: string): void;
  loadSession(id: string, messages: Message[]): void;
  appendUserMessage(id: string, text: string): void;
  applyEvent(event: SessionEvent): void;
  setSessions(list: SessionMeta[]): void;
  reset(): void;
}

const initial = {
  windowMode: 'bar' as WindowMode,
  activeSession: null as ActiveSessionState | null,
  sessions: [] as SessionMeta[],
};

export const useOttoStore = create<OttoState>((set, get) => ({
  ...initial,

  setWindowMode(mode) {
    set({ windowMode: mode });
  },

  beginSession(id) {
    set({ activeSession: { id, messages: [], streaming: false, error: null } });
  },

  loadSession(id, messages) {
    set({ activeSession: { id, messages, streaming: false, error: null } });
  },

  appendUserMessage(id, text) {
    const session = get().activeSession;
    if (!session) return;
    const msg: UserMessage = {
      id,
      sessionId: session.id,
      seq: session.messages.length,
      createdAt: Date.now(),
      role: 'user',
      content: [{ type: 'text', text }],
    };
    set({
      activeSession: {
        ...session,
        messages: [...session.messages, msg],
        error: null,
      },
    });
  },

  applyEvent(event) {
    const session = get().activeSession;
    if (!session || event.sessionId !== session.id) return;

    switch (event.type) {
      case 'message-start': {
        const placeholder: AssistantMessage = {
          id: event.messageId,
          sessionId: session.id,
          seq: session.messages.length,
          createdAt: Date.now(),
          role: 'assistant',
          content: [],
          cancelled: false,
          errored: false,
        };
        set({
          activeSession: {
            ...session,
            messages: [...session.messages, placeholder],
            streaming: true,
          },
        });
        return;
      }
      case 'text-delta': {
        const next = updateAssistant(session, event.messageId, (m) => {
          const content = m.content.slice();
          const last = content[content.length - 1];
          if (last && last.type === 'text') {
            content[content.length - 1] = { type: 'text', text: last.text + event.text };
          } else {
            content.push({ type: 'text', text: event.text });
          }
          return { ...m, content };
        });
        set({ activeSession: next });
        return;
      }
      case 'tool-call-start': {
        const next = updateAssistant(session, event.messageId, (m) => ({
          ...m,
          content: [
            ...m.content,
            { type: 'tool_use' as const, callId: event.callId, name: event.name, input: event.input },
          ],
        }));
        set({ activeSession: next });
        return;
      }
      case 'tool-call-result': {
        const next = updateAssistant(session, event.messageId, (m) => ({
          ...m,
          content: [
            ...m.content,
            {
              type: 'tool_result' as const,
              callId: event.callId,
              result: event.result,
              isError: event.isError,
            },
          ],
        }));
        set({ activeSession: next });
        return;
      }
      case 'message-end':
        return;
      case 'error': {
        set({
          activeSession: { ...session, error: event.error, streaming: false },
        });
        return;
      }
      case 'done': {
        set({ activeSession: { ...session, streaming: false } });
        return;
      }
    }
  },

  setSessions(list) {
    set({ sessions: list });
  },

  reset() {
    set({ ...initial });
  },
}));

function updateAssistant(
  session: ActiveSessionState,
  messageId: string,
  fn: (m: AssistantMessage) => AssistantMessage
): ActiveSessionState {
  const messages = session.messages.map((m) =>
    m.role === 'assistant' && m.id === messageId ? fn(m) : m
  );
  return { ...session, messages };
}

export type { ContentBlock };
