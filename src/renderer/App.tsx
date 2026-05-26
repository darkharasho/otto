import { useEffect, useCallback, useState } from 'react';
import { ipc } from './ipc';
import { useOttoStore } from './state/store';
import { CommandBar } from './components/CommandBar';
import { Panel } from './components/Panel';
import { MessageList } from './components/MessageList';
import { SessionSwitcher } from './components/SessionSwitcher';
import { StatusFooter } from './components/StatusFooter';
import { ErrorCard } from './components/ErrorCard';

export function App() {
  const windowMode = useOttoStore((s) => s.windowMode);
  const activeSession = useOttoStore((s) => s.activeSession);
  const sessions = useOttoStore((s) => s.sessions);
  const mode = useOttoStore((s) => s.mode);
  const model = useOttoStore((s) => s.model);
  const setWindowMode = useOttoStore((s) => s.setWindowMode);
  const beginSession = useOttoStore((s) => s.beginSession);
  const loadSession = useOttoStore((s) => s.loadSession);
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


  const handleSubmit = useCallback(
    async (text: string) => {
      try {
        setWindowMode('panel');
        void ipc.invoke('window.setMode', { mode: 'panel' });
        let sessionId = activeSession?.id;
        if (!sessionId) {
          // eslint-disable-next-line no-console
          console.debug('[otto] session.start', { model });
          const { sessionId: newId } = await ipc.invoke('session.start', { model });
          sessionId = newId;
          beginSession(newId);
        }
        appendUserMessage(crypto.randomUUID(), text);
        // eslint-disable-next-line no-console
        console.debug('[otto] session.send', { sessionId, len: text.length });
        await ipc.invoke('session.send', { sessionId, text });
        void ipc.invoke('session.list', undefined).then(setSessions);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[otto] handleSubmit failed', err);
      }
    },
    [activeSession, beginSession, appendUserMessage, setWindowMode, setSessions, model]
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

  const streaming = activeSession?.streaming ?? false;
  const isFreshSession = !activeSession || activeSession.messages.length === 0;

  const handleStop = useCallback(() => {
    if (!activeSession?.id) return;
    void ipc.invoke('session.cancel', { sessionId: activeSession.id });
  }, [activeSession?.id]);

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

  if (windowMode === 'bar') {
    return (
      <div key={`bar-${enterTick}`} className="w-screen h-screen p-1 otto-enter">
        <CommandBar
          onSubmit={handleSubmit}
          onStop={handleStop}
          busy={streaming}
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
            <CommandBar
              onSubmit={handleSubmit}
              onStop={handleStop}
              busy={streaming}
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
          streaming={streaming}
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
