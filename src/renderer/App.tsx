import { useEffect, useCallback, useState } from 'react';
import { ipc } from './ipc';
import { useOttoStore } from './state/store';
import { CommandBar } from './components/CommandBar';
import { Panel } from './components/Panel';
import { MessageList } from './components/MessageList';
import { SessionSwitcher } from './components/SessionSwitcher';
import { StatusFooter } from './components/StatusFooter';
import { ErrorCard } from './components/ErrorCard';
import { SettingsModal } from './components/SettingsModal';

export function App() {
  const windowMode = useOttoStore((s) => s.windowMode);
  const activeSession = useOttoStore((s) => s.activeSession);
  const sessions = useOttoStore((s) => s.sessions);
  const mode = useOttoStore((s) => s.mode);
  const model = useOttoStore((s) => s.model);
  const setModel = useOttoStore((s) => s.setModel);
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
      } else {
        // Bar mode → hide window entirely (Spotlight / Raycast behavior).
        void ipc.invoke('window.hide', undefined);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [windowMode, setWindowMode]);

  // Re-trigger entrance animation each time the window is shown/focused.
  const [enterTick, setEnterTick] = useState(0);
  useEffect(() => {
    const onFocus = () => setEnterTick((n) => n + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const sessionHasTraffic = (activeSession?.messages.length ?? 0) > 0;

  // Tray right-click → "Settings…" opens the modal. The bar is too short to
  // host a dialog, so force panel mode whenever settings opens.
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    return ipc.onOpenSettings(() => {
      setSettingsOpen(true);
      setWindowMode('panel');
      void ipc.invoke('window.setMode', { mode: 'panel' });
    });
  }, [setWindowMode]);

  const handleSubmit = useCallback(
    async (text: string) => {
      setWindowMode('panel');
      void ipc.invoke('window.setMode', { mode: 'panel' });
      let sessionId = activeSession?.id;
      if (!sessionId) {
        const { sessionId: newId } = await ipc.invoke('session.start', { model });
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
    const { sessionId } = await ipc.invoke('session.start', { model });
    beginSession(sessionId);
    setWindowMode('panel');
    void ipc.invoke('window.setMode', { mode: 'panel' });
  }, [beginSession, setWindowMode, model]);

  const streaming = activeSession?.streaming ?? false;
  const isFreshSession = !activeSession || activeSession.messages.length === 0;

  if (windowMode === 'bar') {
    return (
      <div key={`bar-${enterTick}`} className="w-screen h-screen p-1 otto-enter">
        <CommandBar
          onSubmit={handleSubmit}
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
            <CommandBar onSubmit={handleSubmit} busy={streaming} welcome={isFreshSession} />
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
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        model={model}
        onModelChange={setModel}
        modelLocked={sessionHasTraffic}
        modelLockedReason="Active session is using its original model — start a new session to switch."
      />
    </div>
  );
}
