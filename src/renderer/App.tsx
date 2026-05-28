import { useEffect, useCallback, useState, useRef } from 'react';
import { ipc } from './ipc';
import { useOttoStore, isSessionBusy } from './state/store';
import type { ContentBlock } from '@shared/messages';
import { IDLE_GATE_MS, TOPIC_SHIFT_EVALUATE_TIMEOUT_MS } from '@shared/topic-shift-constants';
import { CommandBar } from './components/CommandBar';
import { Panel } from './components/Panel';
import { MessageList } from './components/MessageList';
import { SessionSwitcher } from './components/SessionSwitcher';
import { StatusFooter } from './components/StatusFooter';
import { ErrorCard } from './components/ErrorCard';
import { TopicShiftChip } from './components/TopicShiftChip';

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


  type ImageRef = Extract<ContentBlock, { type: 'image-ref' }>;

  // Holds an in-flight session.start promise so concurrent callers (e.g.
  // stageFile paste and handleSubmit racing) always await the same promise
  // and end up with the same sessionId.
  const inFlightSessionStart = useRef<Promise<string> | null>(null);
  const lastUserSubmitAt = useRef<number>(Date.now());
  const [pendingTopicShift, setPendingTopicShift] = useState<
    { text: string; attachments: ImageRef[] } | null
  >(null);

  const ensureSession = useCallback(async (): Promise<string> => {
    if (inFlightSessionStart.current) return inFlightSessionStart.current;
    const p = ipc
      .invoke('session.ensureForSubmit', {
        current: activeSession?.id ?? null,
        model,
      })
      .then(({ sessionId, isNew }) => {
        if (isNew) beginSession(sessionId);
        inFlightSessionStart.current = null;
        return sessionId;
      });
    inFlightSessionStart.current = p;
    return p;
  }, [activeSession, beginSession, model]);

  const submitToActiveSession = useCallback(
    async ({ text, attachments }: { text: string; attachments: ImageRef[] }) => {
      try {
        setWindowMode('panel');
        void ipc.invoke('window.setMode', { mode: 'panel' });
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
      const messages = await ipc.invoke('session.load', { sessionId: id });
      loadSession(id, messages);
      setWindowMode('panel');
      void ipc.invoke('window.setMode', { mode: 'panel' });
    },
    [loadSession, setWindowMode]
  );

  const handleNewSession = useCallback(async () => {
    const { sessionId } = await ipc.invoke('session.start', { model });
    beginSession(sessionId);
    setWindowMode('panel');
    void ipc.invoke('window.setMode', { mode: 'panel' });
  }, [beginSession, setWindowMode, model]);

  const handleNewConversation = useCallback(
    async ({ text, attachments }: { text: string; attachments: ImageRef[] }) => {
      const prevId = useOttoStore.getState().activeSession?.id ?? null;
      if (prevId) {
        // Use close (not interrupt) so the old SDK subprocess is fully torn
        // down; interrupt only signals cancel and leaves the stream alive,
        // which blocks new sessions from making progress.
        void ipc.invoke('session.close', { sessionId: prevId }).catch(() => {});
      }
      // Empty trigger (the common /n␣ + space case): just drop the old
      // session and collapse to the bar. The next submit will lazily start a
      // fresh session via ensureForSubmit, which keeps the empty bar entirely
      // free of any in-flight stream's busy/queue state.
      if (text.length === 0 && attachments.length === 0) {
        abandonActiveSession();
        setWindowMode('bar');
        void ipc.invoke('window.setMode', { mode: 'bar' });
        return;
      }
      const { sessionId } = await ipc.invoke('session.start', { model });
      beginSession(sessionId);
      setWindowMode('panel');
      void ipc.invoke('window.setMode', { mode: 'panel' });
      appendUserMessage(crypto.randomUUID(), text, attachments);
      await ipc.invoke('session.send', { sessionId, text, attachments });
      void ipc.invoke('session.list', undefined).then(setSessions);
    },
    [abandonActiveSession, beginSession, setWindowMode, setSessions, appendUserMessage, model],
  );

  const streaming = isSessionBusy(activeSession);
  const isFreshSession = !activeSession || activeSession.messages.length === 0;

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

  // Up arrow expands bar→panel to show the current session
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp') return;
      if (windowMode !== 'bar') return;
      // Only expand if focus is on the input (not mid-typing elsewhere)
      const input = document.querySelector('input[type="text"]');
      if (document.activeElement !== input) return;
      e.preventDefault();
      setWindowMode('panel');
      void ipc.invoke('window.setMode', { mode: 'panel' });
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

  if (windowMode === 'bar') {
    return (
      <div key={`bar-${enterTick}`} className="w-screen h-screen p-1 otto-enter">
        <CommandBar
          onSubmit={handleSubmit}
          ensureSession={ensureSession}
          onStop={handleStop}
          onInterruptAndSend={handleInterruptAndSend}
          onNewConversation={handleNewConversation}
          busy={streaming}
          queueDepth={activeSession?.queueDepth ?? 0}
          welcome={isFreshSession}
        />
      </div>
    );
  }

  return (
    <div key={`panel-${enterTick}`} className="w-screen h-screen p-1 otto-enter">
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
              busy={streaming}
              queueDepth={activeSession?.queueDepth ?? 0}
              welcome={isFreshSession}
            />
            <StatusFooter
              model={model}
              sessionId={activeSession?.id ?? null}
              mode={mode}
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
