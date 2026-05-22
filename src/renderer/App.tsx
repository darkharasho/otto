import { useEffect, useCallback } from 'react';
import { ipc } from './ipc';
import { useOttoStore } from './state/store';
import { CommandBar } from './components/CommandBar';
import { Panel } from './components/Panel';
import { MessageList } from './components/MessageList';
import { SessionSwitcher } from './components/SessionSwitcher';
import { StatusFooter } from './components/StatusFooter';
import { ErrorCard } from './components/ErrorCard';

const MODEL = 'claude-sonnet-4-6';

export function App() {
  const windowMode = useOttoStore((s) => s.windowMode);
  const activeSession = useOttoStore((s) => s.activeSession);
  const sessions = useOttoStore((s) => s.sessions);
  const mode = useOttoStore((s) => s.mode);
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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (windowMode === 'panel') {
        setWindowMode('bar');
        void ipc.invoke('window.setMode', { mode: 'bar' });
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [windowMode, setWindowMode]);

  const handleSubmit = useCallback(
    async (text: string) => {
      setWindowMode('panel');
      void ipc.invoke('window.setMode', { mode: 'panel' });
      let sessionId = activeSession?.id;
      if (!sessionId) {
        const { sessionId: newId } = await ipc.invoke('session.start', {});
        sessionId = newId;
        beginSession(newId);
      }
      appendUserMessage(crypto.randomUUID(), text);
      await ipc.invoke('session.send', { sessionId, text });
      void ipc.invoke('session.list', undefined).then(setSessions);
    },
    [activeSession, beginSession, appendUserMessage, setWindowMode, setSessions]
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
    const { sessionId } = await ipc.invoke('session.start', {});
    beginSession(sessionId);
    setWindowMode('panel');
    void ipc.invoke('window.setMode', { mode: 'panel' });
  }, [beginSession, setWindowMode]);

  if (windowMode === 'bar') {
    return (
      <div className="w-screen h-screen p-1">
        <CommandBar onSubmit={handleSubmit} />
      </div>
    );
  }

  return (
    <div className="w-screen h-screen p-1">
      <Panel
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
            <CommandBar onSubmit={handleSubmit} busy={activeSession?.streaming ?? false} />
            <StatusFooter
              model={MODEL}
              sessionId={activeSession?.id ?? null}
              streaming={activeSession?.streaming ?? false}
              mode={mode}
            />
          </div>
        }
      >
        <MessageList
          messages={activeSession?.messages ?? []}
          streaming={activeSession?.streaming ?? false}
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
