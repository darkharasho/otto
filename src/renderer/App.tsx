import { useEffect, useCallback, useState, useRef } from 'react';
import { ipc } from './ipc';
import { useOttoStore, isSessionBusy, canProactivelyReset } from './state/store';
import { useVoice } from './voice/useVoice';
import type { ContentBlock } from '@shared/messages';
import { IDLE_GATE_MS, TOPIC_SHIFT_EVALUATE_TIMEOUT_MS } from '@shared/topic-shift-constants';
import { CommandBar } from './components/CommandBar';
import { Panel } from './components/Panel';
import { MessageList } from './components/MessageList';
import { SessionSwitcher } from './components/SessionSwitcher';
import { StatusFooter } from './components/StatusFooter';
import { ErrorCard } from './components/ErrorCard';
import { TopicShiftChip } from './components/TopicShiftChip';
import { ChatWindow } from './components/ChatWindow';

export function App() {
  const windowMode = useOttoStore((s) => s.windowMode);
  const activeSession = useOttoStore((s) => s.activeSession);
  const sessions = useOttoStore((s) => s.sessions);
  const mode = useOttoStore((s) => s.mode);
  const model = useOttoStore((s) => s.model);
  const setWindowMode = useOttoStore((s) => s.setWindowMode);
  const beginSession = useOttoStore((s) => s.beginSession);
  const loadSession = useOttoStore((s) => s.loadSession);
  const abandonActiveSession = useOttoStore((s) => s.abandonActiveSession);
  const appendUserMessage = useOttoStore((s) => s.appendUserMessage);
  const applyEvent = useOttoStore((s) => s.applyEvent);
  const setSessions = useOttoStore((s) => s.setSessions);

  useEffect(() => {
    return ipc.onSessionEvent((e) => applyEvent(e));
  }, [applyEvent]);

  useEffect(() => {
    void ipc.invoke('session.list', undefined).then(setSessions);
  }, [setSessions]);

  useEffect(() => {
    void ipc.invoke('autonomy.getMode', undefined).then((m) => useOttoStore.getState().setMode(m));
  }, []);

  useEffect(() => {
    void ipc.invoke('settings.get', undefined).then((s) => {
      useOttoStore.getState().setPinnedSessionIds(s.pinnedSessionIds);
    });
  }, []);

  useEffect(() => {
    return ipc.onAutonomyEvent((e) => {
      if (e.type === 'mode-changed') {
        useOttoStore.getState().setMode(e.mode);
      }
    });
  }, []);

  // Re-trigger entrance animation each time the window is shown (hotkey,
  // tray, toggle socket). Use visibilitychange — not focus — so clicking
  // away to another app and back doesn't replay the animation.
  const [enterTick, setEnterTick] = useState(0);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') setEnterTick((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Proactive idle rollover: when Otto is summoned after the new-conversation
  // idle timeout, show the fresh-session UI immediately instead of revealing
  // the stale conversation until the next submit. peekFresh is read-only on
  // the main side (records no activity); ensureForSubmit remains the
  // authoritative rollover at submit time. The old conversation stays
  // reachable from history.
  useEffect(() => {
    const maybeReset = () => {
      const s = useOttoStore.getState().activeSession;
      if (!canProactivelyReset(s)) return;
      void ipc.invoke('session.peekFresh', undefined).then(({ fresh }) => {
        if (!fresh) return;
        const cur = useOttoStore.getState().activeSession;
        // Re-check: a turn may have started while we awaited the IPC.
        if (canProactivelyReset(cur) && cur?.id === s?.id) {
          useOttoStore.getState().abandonActiveSession();
        }
      });
    };
    maybeReset(); // app mount (window may come up already visible)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') maybeReset();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);


  type ImageRef = Extract<ContentBlock, { type: 'image-ref' }>;

  // Holds an in-flight session.start promise so concurrent callers (e.g.
  // stageFile paste and handleSubmit racing) always await the same promise
  // and end up with the same sessionId.
  const inFlightSessionStart = useRef<Promise<string> | null>(null);
  const pendingPrivate = useRef(false);
  // Reactive mirror of pendingPrivate for the UI indicator (refs don't re-render).
  const [armedPrivate, setArmedPrivate] = useState(false);
  const lastUserSubmitAt = useRef<number>(Date.now());
  const [pendingTopicShift, setPendingTopicShift] = useState<
    { text: string; attachments: ImageRef[] } | null
  >(null);

  const ensureSession = useCallback(async (): Promise<string> => {
    if (inFlightSessionStart.current) return inFlightSessionStart.current;
    const wantPrivate = pendingPrivate.current;
    const p = ipc
      .invoke('session.ensureForSubmit', {
        current: activeSession?.id ?? null,
        model,
        private: wantPrivate,
      })
      .then(({ sessionId, isNew }) => {
        if (isNew) {
          beginSession(sessionId, { private: wantPrivate });
          if (wantPrivate) {
            pendingPrivate.current = false; // consumed
            setArmedPrivate(false);
          }
        }
        inFlightSessionStart.current = null;
        return sessionId;
      });
    inFlightSessionStart.current = p;
    return p;
  }, [activeSession, beginSession, model]);

  const submitToActiveSession = useCallback(
    async ({ text, attachments }: { text: string; attachments: ImageRef[] }) => {
      try {
        if (useOttoStore.getState().windowMode === 'bar') {
          setWindowMode('panel');
          void ipc.invoke('window.setMode', { mode: 'panel' });
        }
        const sessionId = await ensureSession();
        appendUserMessage(crypto.randomUUID(), text, attachments);
        // eslint-disable-next-line no-console
        console.debug('[otto] session.send', { sessionId, len: text.length, attachments: attachments.length });
        await ipc.invoke('session.send', { sessionId, text, attachments });
        lastUserSubmitAt.current = Date.now();
        void ipc.invoke('session.list', undefined).then(setSessions);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[otto] submitToActiveSession failed', err);
      }
    },
    [ensureSession, appendUserMessage, setWindowMode, setSessions],
  );

  const handleSubmit = useCallback(
    async ({ text, attachments }: { text: string; attachments: ImageRef[] }) => {
      const sessionId = activeSession?.id ?? null;
      const idleMs = Date.now() - lastUserSubmitAt.current;
      // Only consult the detector if we have an active session AND the user has
      // been idle long enough. Fresh-session submits always go straight through.
      if (sessionId && idleMs >= IDLE_GATE_MS) {
        try {
          const result = await Promise.race([
            ipc.invoke('topicShift.evaluate', { sessionId, newPrompt: text }),
            new Promise<{ suggest: false; similarity: number }>((resolve) =>
              setTimeout(() => resolve({ suggest: false, similarity: NaN }), TOPIC_SHIFT_EVALUATE_TIMEOUT_MS),
            ),
          ]);
          if (result.suggest) {
            setPendingTopicShift({ text, attachments });
            return;
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[otto] topicShift.evaluate failed; submitting normally', err);
        }
      }
      void submitToActiveSession({ text, attachments });
    },
    [activeSession?.id, submitToActiveSession],
  );

  const handleSelectSession = useCallback(
    async (id: string) => {
      // Navigating to an existing session cancels any pending private arming.
      pendingPrivate.current = false;
      setArmedPrivate(false);
      const messages = await ipc.invoke('session.load', { sessionId: id });
      loadSession(id, messages);
      if (useOttoStore.getState().windowMode === 'bar') {
        setWindowMode('panel');
        void ipc.invoke('window.setMode', { mode: 'panel' });
      }
      // Re-sync the voice pipeline to follow the newly active session.
      if (useOttoStore.getState().voiceMode) {
        void ipc.invoke('voice.setMode', { enabled: true, sessionId: id });
      }
    },
    [loadSession, setWindowMode]
  );

  const handleNewSession = useCallback(async () => {
    // Explicit new (non-private) session cancels any pending private arming.
    pendingPrivate.current = false;
    setArmedPrivate(false);
    const { sessionId } = await ipc.invoke('session.start', { model });
    beginSession(sessionId);
    if (useOttoStore.getState().windowMode === 'bar') {
      setWindowMode('panel');
      void ipc.invoke('window.setMode', { mode: 'panel' });
    }
    // Re-sync the voice pipeline to follow the newly created session.
    if (useOttoStore.getState().voiceMode) {
      void ipc.invoke('voice.setMode', { enabled: true, sessionId });
    }
  }, [beginSession, setWindowMode, model]);

  const handleNewConversation = useCallback(
    async ({ text, attachments }: { text: string; attachments: ImageRef[] }) => {
      // Choosing a (non-private) new conversation cancels any pending private
      // arming from a prior bare "/p " trigger.
      pendingPrivate.current = false;
      setArmedPrivate(false);
      const prevId = useOttoStore.getState().activeSession?.id ?? null;
      if (prevId) {
        // Use close (not interrupt) so the old SDK subprocess is fully torn
        // down; interrupt only signals cancel and leaves the stream alive,
        // which blocks new sessions from making progress.
        void ipc.invoke('session.close', { sessionId: prevId }).catch(() => {});
      }
      // Empty trigger (the common /n␣ + space case): drop the old session.
      // From bar/panel, collapse to the bar so the next submit lazily starts
      // a fresh session via ensureForSubmit. From chat, stay in chat — the
      // user is using the standalone window and expects to remain there.
      if (text.length === 0 && attachments.length === 0) {
        abandonActiveSession();
        if (useOttoStore.getState().windowMode !== 'chat') {
          setWindowMode('bar');
          void ipc.invoke('window.setMode', { mode: 'bar' });
        }
        return;
      }
      const { sessionId } = await ipc.invoke('session.start', { model });
      beginSession(sessionId);
      if (useOttoStore.getState().windowMode === 'bar') {
        setWindowMode('panel');
        void ipc.invoke('window.setMode', { mode: 'panel' });
      }
      appendUserMessage(crypto.randomUUID(), text, attachments);
      await ipc.invoke('session.send', { sessionId, text, attachments });
      void ipc.invoke('session.list', undefined).then(setSessions);
    },
    [abandonActiveSession, beginSession, setWindowMode, setSessions, appendUserMessage, model],
  );

  const handlePrivateConversation = useCallback(
    async ({ text, attachments }: { text: string; attachments: ImageRef[] }) => {
      const prevId = useOttoStore.getState().activeSession?.id ?? null;
      if (prevId) {
        void ipc.invoke('session.close', { sessionId: prevId }).catch(() => {});
      }
      // Empty trigger ("/p" + space): drop the old session and arm the next
      // submit to be private. Collapse to the bar so the next submit lazily
      // starts a fresh private session via ensureForSubmit.
      if (text.length === 0 && attachments.length === 0) {
        abandonActiveSession();
        pendingPrivate.current = true;
        setArmedPrivate(true);
        if (useOttoStore.getState().windowMode !== 'chat') {
          setWindowMode('bar');
          void ipc.invoke('window.setMode', { mode: 'bar' });
        }
        return;
      }
      const { sessionId } = await ipc.invoke('session.start', { model, private: true });
      beginSession(sessionId, { private: true });
      if (useOttoStore.getState().windowMode === 'bar') {
        setWindowMode('panel');
        void ipc.invoke('window.setMode', { mode: 'panel' });
      }
      appendUserMessage(crypto.randomUUID(), text, attachments);
      await ipc.invoke('session.send', { sessionId, text, attachments });
      // Intentionally do NOT refresh session.list — private sessions stay out of history.
    },
    [abandonActiveSession, beginSession, setWindowMode, appendUserMessage, model],
  );

  const streaming = isSessionBusy(activeSession);
  const isFreshSession = !activeSession || activeSession.messages.length === 0;
  // Private when the active session is private, or while a bare "/p " has armed
  // the next message (before the session exists yet).
  const showPrivate = (activeSession?.private ?? false) || armedPrivate;

  const handleStop = useCallback(() => {
    if (!activeSession?.id) return;
    void ipc.invoke('session.interrupt', { sessionId: activeSession.id });
  }, [activeSession?.id]);

  const handleInterruptAndSend = useCallback(
    async ({ text, attachments }: { text: string; attachments: ImageRef[] }) => {
      if (!activeSession?.id) return;
      try {
        // Interrupt the current turn first, then enqueue the new message.
        // The session subprocess stays alive so the new message flows immediately.
        await ipc.invoke('session.interrupt', { sessionId: activeSession.id });
        appendUserMessage(crypto.randomUUID(), text, attachments);
        await ipc.invoke('session.send', { sessionId: activeSession.id, text, attachments });
        void ipc.invoke('session.list', undefined).then(setSessions);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[otto] handleInterruptAndSend failed', err);
      }
    },
    [activeSession?.id, appendUserMessage, setSessions]
  );

  const { toggle: toggleVoice } = useVoice({
    submitText: (text) => handleSubmit({ text, attachments: [] }),
    ensureSession,
  });
  const voiceMode = useOttoStore((s) => s.voiceMode);
  const voiceState = useOttoStore((s) => s.voiceState);

  // One Esc handler with a priority order: cancel a streaming response, else
  // collapse panel→bar, else hide. Splitting into two listeners caused a
  // capture/bubble race that swallowed the cancel.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (streaming && activeSession?.id) {
        handleStop();
        return;
      }
      if (windowMode === 'chat') {
        setWindowMode('panel');
        void ipc.invoke('window.setMode', { mode: 'panel' });
        return;
      }
      if (windowMode === 'panel') {
        setWindowMode('bar');
        void ipc.invoke('window.setMode', { mode: 'bar' });
      } else {
        void ipc.invoke('window.hide', undefined);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [windowMode, setWindowMode, streaming, activeSession?.id, handleStop]);

  // Ctrl+Shift+Arrow moves Otto across monitors. Right = next, Left = prev.
  // Chord is uncommon enough not to clash with normal typing.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !e.shiftKey) return;
      const direction =
        e.key === 'ArrowRight' ? 'next' : e.key === 'ArrowLeft' ? 'prev' : null;
      if (!direction) return;
      e.preventDefault();
      void ipc.invoke('window.cycleDisplay', { direction });
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Up arrow promotes bar→panel→chat
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp') return;
      // Only expand if focus is on the input (not mid-typing elsewhere)
      const input = document.querySelector('input[type="text"]');
      if (document.activeElement !== input) return;
      if (windowMode === 'bar') {
        e.preventDefault();
        setWindowMode('panel');
        void ipc.invoke('window.setMode', { mode: 'panel' });
      } else if (windowMode === 'panel') {
        e.preventDefault();
        setWindowMode('chat');
        void ipc.invoke('window.setMode', { mode: 'chat' });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [windowMode, setWindowMode]);

  // Down arrow demotes chat→panel→bar
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowDown') return;
      const input = document.querySelector('input[type="text"]');
      if (document.activeElement !== input) return;
      if (windowMode === 'chat') {
        e.preventDefault();
        setWindowMode('panel');
        void ipc.invoke('window.setMode', { mode: 'panel' });
      } else if (windowMode === 'panel') {
        e.preventDefault();
        setWindowMode('bar');
        void ipc.invoke('window.setMode', { mode: 'bar' });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [windowMode, setWindowMode]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && (e.key === 'N' || e.key === 'n')) {
        e.preventDefault();
        void handleNewConversation({ text: '', attachments: [] });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleNewConversation]);

  if (windowMode === 'chat') {
    return (
      <ChatWindow
        onSubmit={handleSubmit}
        ensureSession={ensureSession}
        onStop={handleStop}
        onInterruptAndSend={handleInterruptAndSend}
        onNewConversation={handleNewConversation}
        onPrivateConversation={handlePrivateConversation}
        onSelectSession={handleSelectSession}
        isPrivate={showPrivate}
      />
    );
  }

  if (windowMode === 'bar') {
    return (
      <div data-window-mode="bar" key={`bar-${enterTick}`} className="w-screen h-screen p-1 otto-enter">
        <CommandBar
          onSubmit={handleSubmit}
          ensureSession={ensureSession}
          onStop={handleStop}
          onInterruptAndSend={handleInterruptAndSend}
          onNewConversation={handleNewConversation}
          onPrivateConversation={handlePrivateConversation}
          isPrivate={showPrivate}
          busy={streaming}
          queueDepth={activeSession?.queueDepth ?? 0}
          welcome={isFreshSession}
          voice={{ mode: voiceMode, state: voiceState, onToggle: () => void toggleVoice() }}
        />
      </div>
    );
  }

  return (
    <div data-window-mode="panel" key={`panel-${enterTick}`} className="w-screen h-screen p-1 otto-enter">
      <Panel
        busy={streaming}
        header={
          <SessionSwitcher
            sessions={sessions}
            activeSessionId={activeSession?.id ?? null}
            onSelect={handleSelectSession}
            onNew={handleNewSession}
          />
        }
        footer={
          <div className="flex flex-col gap-2">
            {pendingTopicShift && (
              <TopicShiftChip
                onStartNew={() => {
                  const p = pendingTopicShift;
                  setPendingTopicShift(null);
                  if (p) void handleNewConversation(p);
                }}
                onKeepGoing={() => {
                  const p = pendingTopicShift;
                  setPendingTopicShift(null);
                  if (p) void submitToActiveSession(p);
                }}
              />
            )}
            <CommandBar
              onSubmit={handleSubmit}
              ensureSession={ensureSession}
              onStop={handleStop}
              onInterruptAndSend={handleInterruptAndSend}
              onNewConversation={handleNewConversation}
              onPrivateConversation={handlePrivateConversation}
              isPrivate={showPrivate}
              busy={streaming}
              queueDepth={activeSession?.queueDepth ?? 0}
              welcome={isFreshSession}
              voice={{ mode: voiceMode, state: voiceState, onToggle: () => void toggleVoice() }}
            />
            <StatusFooter
              model={model}
              sessionId={activeSession?.id ?? null}
              mode={mode}
              isPrivate={showPrivate}
            />
          </div>
        }
      >
        <MessageList
          sessionId={activeSession?.id ?? null}
          messages={activeSession?.messages ?? []}
          streaming={activeSession?.currentTurnActive ?? false}
        />
        {activeSession?.error && (
          <div className="px-4">
            <ErrorCard error={activeSession.error} />
          </div>
        )}
      </Panel>
    </div>
  );
}
