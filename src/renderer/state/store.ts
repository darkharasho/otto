import { create } from 'zustand';
import type { SessionEvent, StructuredError } from '@shared/ipc-contract';
import type { AssistantMessage, AutonomyMode, ContentBlock, Message, SessionMeta, UserMessage } from '@shared/messages';

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
  mode: AutonomyMode;
  model: string;

  setWindowMode(mode: WindowMode): void;
  beginSession(id: string): void;
  loadSession(id: string, messages: Message[]): void;
  appendUserMessage(id: string, text: string, attachments?: Array<Extract<ContentBlock, { type: 'image-ref' }>>): void;
  applyEvent(event: SessionEvent): void;
  attachSession(sessionId: string): Promise<void>;
  setSessions(list: SessionMeta[]): void;
  setMode(mode: AutonomyMode): void;
  setModel(model: string): void;
  reset(): void;
}

// Sessions currently being attached (e.g. started from the iPhone remote).
// Events that arrive for these IDs are buffered and replayed once the
// session record has been loaded and set active.
const attachInFlight = new Map<string, SessionEvent[]>();

const MODEL_STORAGE_KEY = 'otto.model';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

function loadStoredModel(): string {
  if (typeof window === 'undefined') return DEFAULT_MODEL;
  try {
    return window.localStorage.getItem(MODEL_STORAGE_KEY) ?? DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

const initial = {
  windowMode: 'bar' as WindowMode,
  activeSession: null as ActiveSessionState | null,
  sessions: [] as SessionMeta[],
  mode: 'balanced' as AutonomyMode,
  model: loadStoredModel(),
};

// Cross-window sync: localStorage is shared across BrowserWindows of the
// same origin, and Chromium fires the `storage` event in other windows when
// one window writes. So changing the model in the Settings window updates
// the main window's store without any IPC plumbing.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== MODEL_STORAGE_KEY) return;
    const next = e.newValue;
    if (!next) return;
    // Skip no-op writes so we don't churn renders for the same value.
    if (useOttoStore.getState().model === next) return;
    useOttoStore.setState({ model: next });
  });
}

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

  appendUserMessage(id, text, attachments = []) {
    const session = get().activeSession;
    if (!session) return;
    const content: ContentBlock[] = [];
    if (text.length > 0) content.push({ type: 'text', text });
    for (const a of attachments) content.push(a);
    const msg: UserMessage = {
      id,
      sessionId: session.id,
      seq: session.messages.length,
      createdAt: Date.now(),
      role: 'user',
      content,
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
    if (!session || event.sessionId !== session.id) {
      // Auto-attach to a session we don't currently track (e.g. one started
      // from the iPhone remote). Kick off the load and buffer this event so
      // it can be replayed once attach completes.
      if (event.sessionId) {
        const pending = attachInFlight.get(event.sessionId);
        if (pending) {
          pending.push(event);
        } else {
          attachInFlight.set(event.sessionId, [event]);
          void get().attachSession(event.sessionId);
        }
      }
      return;
    }

    switch (event.type) {
      case 'user-message': {
        // The desktop optimistically appends a user bubble when YOU submit
        // (handleSubmit -> appendUserMessage with a random UUID). For
        // remote-originated prompts (from the phone), no optimistic add
        // happens, so we must append from the event. Dedupe by:
        //   (1) exact messageId match, or
        //   (2) the immediately-prior message is a user msg with the same
        //       text — covers the desktop's optimistic add (different id).
        const messages = session.messages;
        if (messages.some((m) => m.id === event.messageId)) return;
        const last = messages[messages.length - 1];
        if (
          last &&
          last.role === 'user' &&
          last.content.length === 1 &&
          last.content[0]!.type === 'text' &&
          (last.content[0] as { type: 'text'; text: string }).text === event.text
        ) {
          return;
        }
        const msg: UserMessage = {
          id: event.messageId,
          sessionId: session.id,
          seq: session.messages.length,
          createdAt: Date.now(),
          role: 'user',
          content: [{ type: 'text', text: event.text }],
        };
        set({
          activeSession: {
            ...session,
            messages: [...session.messages, msg],
            error: null,
          },
        });
        return;
      }
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
      case 'system-message': {
        set({
          activeSession: {
            ...session,
            messages: [...session.messages, event.message],
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
      case 'tool-call-pending': {
        const next = updateAssistant(session, event.messageId, (m) => ({
          ...m,
          content: [
            ...m.content,
            {
              type: 'pending_tool_use' as const,
              callId: event.callId,
              decisionId: event.decisionId,
              name: event.name,
              input: event.input,
              actionClass: event.actionClass,
              reason: event.reason,
              decision: 'pending' as const,
            },
          ],
        }));
        set({ activeSession: next });
        return;
      }
      case 'tool-call-decided': {
        const next = updateAssistant(session, event.messageId, (m) => ({
          ...m,
          content: m.content.map((b) =>
            b.type === 'pending_tool_use' && b.decisionId === event.decisionId
              ? {
                  ...b,
                  decision:
                    event.decision === 'approve'
                      ? ('approved' as const)
                      : event.decision === 'approve-session'
                        ? ('approved-session' as const)
                        : ('denied' as const),
                }
              : b
          ),
        }));
        set({ activeSession: next });
        return;
      }
      case 'tool-call-denied': {
        const next = updateAssistant(session, event.messageId, (m) => ({
          ...m,
          content: [
            ...m.content,
            {
              type: 'tool_denied' as const,
              callId: event.callId,
              name: event.name,
              input: event.input,
              reason: event.reason,
            },
          ],
        }));
        set({ activeSession: next });
        return;
      }
      case 'process-spawned': {
        const next = updateAssistant(session, event.messageId, (m) => ({
          ...m,
          content: [
            ...m.content,
            {
              type: 'process_output' as const,
              handle: event.handle,
              command: event.command,
              cwd: event.cwd,
              lines: [],
              status: 'running' as const,
              exitCode: null,
            },
          ],
        }));
        set({ activeSession: next });
        return;
      }
      case 'process-stdout': {
        const next = updateAssistant(session, event.messageId, (m) => ({
          ...m,
          content: m.content.map((b) =>
            b.type === 'process_output' && b.handle === event.handle
              ? { ...b, lines: [...b.lines, { stream: 'stdout' as const, data: event.data }] }
              : b
          ),
        }));
        set({ activeSession: next });
        return;
      }
      case 'process-stderr': {
        const next = updateAssistant(session, event.messageId, (m) => ({
          ...m,
          content: m.content.map((b) =>
            b.type === 'process_output' && b.handle === event.handle
              ? { ...b, lines: [...b.lines, { stream: 'stderr' as const, data: event.data }] }
              : b
          ),
        }));
        set({ activeSession: next });
        return;
      }
      case 'process-exited': {
        const next = updateAssistant(session, event.messageId, (m) => ({
          ...m,
          content: m.content.map((b) =>
            b.type === 'process_output' && b.handle === event.handle
              ? {
                  ...b,
                  status: (b.status === 'killed' ? 'killed' : 'exited') as 'exited' | 'killed',
                  exitCode: event.exitCode,
                }
              : b
          ),
        }));
        set({ activeSession: next });
        return;
      }
      case 'process-killed': {
        const next = updateAssistant(session, event.messageId, (m) => ({
          ...m,
          content: m.content.map((b) =>
            b.type === 'process_output' && b.handle === event.handle
              ? { ...b, status: 'killed' as const }
              : b
          ),
        }));
        set({ activeSession: next });
        return;
      }
      case 'message-end':
        return;
      case 'message-cancelled': {
        const next = updateAssistant(session, event.messageId, (m) => ({ ...m, cancelled: true }));
        set({ activeSession: { ...next, streaming: false } });
        return;
      }
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

  async attachSession(sessionId) {
    // Already the active session — nothing to do.
    if (get().activeSession?.id === sessionId) {
      const buffered = attachInFlight.get(sessionId);
      attachInFlight.delete(sessionId);
      if (buffered) for (const e of buffered) get().applyEvent(e);
      return;
    }
    // Guard against SSR / tests where the preload bridge isn't installed.
    if (typeof window === 'undefined' || !window.otto) {
      attachInFlight.delete(sessionId);
      return;
    }
    try {
      const messages = await window.otto.invoke('session.load', { sessionId });
      set({ activeSession: { id: sessionId, messages, streaming: false, error: null }, windowMode: 'panel' });
      // Phone-started turns need the desktop to expand from bar → panel so
      // the user can actually see the conversation that's unfolding.
      void window.otto.invoke('window.setMode', { mode: 'panel' }).catch(() => {});
      // Refresh the sessions list so the new session shows up in history.
      void window.otto
        .invoke('session.list', undefined)
        .then((list) => set({ sessions: list }))
        .catch(() => {});
    } catch {
      // Swallow — next event on the same session will retry attach.
    } finally {
      const buffered = attachInFlight.get(sessionId);
      attachInFlight.delete(sessionId);
      if (buffered && get().activeSession?.id === sessionId) {
        for (const e of buffered) get().applyEvent(e);
      }
    }
  },

  setSessions(list) {
    set({ sessions: list });
  },

  setMode(mode) {
    set({ mode });
  },

  setModel(model) {
    set({ model });
    try {
      window.localStorage.setItem(MODEL_STORAGE_KEY, model);
    } catch {
      // localStorage may be unavailable (e.g. sandboxed test env) — choice
      // just won't persist across launches, which is fine.
    }
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
