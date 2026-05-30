import { useMemo } from 'react';
import { ChatTitlebar } from './ChatTitlebar';
import { ConversationSidebar } from './ConversationSidebar';
import { MessageList } from './MessageList';
import { CommandBar } from './CommandBar';
import { ipc } from '../ipc';
import { useOttoStore, isSessionBusy } from '../state/store';
import type { SidebarSession, SessionState } from '../lib/conversation-grouping';
import type { ContentBlock } from '@shared/messages';

type ImageRef = Extract<ContentBlock, { type: 'image-ref' }>;

interface Props {
  onSubmit: (args: { text: string; attachments: ImageRef[] }) => void | Promise<void>;
  ensureSession: () => Promise<string>;
  onStop: () => void;
  onInterruptAndSend: (args: { text: string; attachments: ImageRef[] }) => void | Promise<void>;
  onNewConversation: (args: { text: string; attachments: ImageRef[] }) => void | Promise<void>;
  onSelectSession: (id: string) => void | Promise<void>;
}

export function ChatWindow({
  onSubmit,
  ensureSession,
  onStop,
  onInterruptAndSend,
  onNewConversation,
  onSelectSession,
}: Props) {
  const sessions = useOttoStore((s) => s.sessions);
  const activeSession = useOttoStore((s) => s.activeSession);
  const pinnedIds = useOttoStore((s) => s.pinnedSessionIds);
  const togglePinned = useOttoStore((s) => s.togglePinned);
  const autonomyMode = useOttoStore((s) => s.mode);

  const streaming = isSessionBusy(activeSession);
  const isFreshSession = !activeSession || activeSession.messages.length === 0;

  const sidebarSessions: SidebarSession[] = useMemo(
    () =>
      sessions.map((s) => {
        const state: SessionState =
          s.id === activeSession?.id && streaming
            ? 'running'
            : s.status === 'ended'
              ? 'done'
              : 'idle';
        return {
          id: s.id,
          title: s.title ?? 'Untitled',
          updatedAt: s.lastActive,
          state,
          recentToolNames: [],
        };
      }),
    [sessions, activeSession?.id, streaming]
  );

  const activeTitle = useMemo(() => {
    const meta = sessions.find((s) => s.id === activeSession?.id);
    return meta?.title ?? '';
  }, [sessions, activeSession?.id]);

  return (
    <div
      data-window-mode="chat"
      className="w-screen h-screen flex flex-col"
      style={{
        background: 'linear-gradient(180deg, #16171c 0%, #131419 100%)',
        borderRadius: 16,
        overflow: 'hidden',
        border: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      <ChatTitlebar
        sessionTitle={activeTitle}
        isLive={streaming}
        onMinimize={() => void ipc.invoke('window.minimize', undefined)}
        onToggleMaximize={() => void ipc.invoke('window.toggleMaximize', undefined)}
      />

      <div className="flex flex-1 min-h-0">
        <ConversationSidebar
          sessions={sidebarSessions}
          activeSessionId={activeSession?.id ?? null}
          pinnedIds={pinnedIds}
          autonomyLabel={autonomyMode.toUpperCase()}
          conversationCount={sidebarSessions.length}
          onNew={() => void onNewConversation({ text: '', attachments: [] })}
          onSelect={(id) => void onSelectSession(id)}
          onTogglePin={(id) => {
            togglePinned(id);
            void ipc.invoke('settings.setPinnedSessionIds', {
              ids: useOttoStore.getState().pinnedSessionIds,
            });
          }}
          onOpenSettings={() => void ipc.invoke('settings.open', undefined)}
        />

        <main className="flex-1 flex flex-col min-w-0 min-h-0" style={{ background: '#16171c' }}>
          <MessageList
            sessionId={activeSession?.id ?? null}
            messages={activeSession?.messages ?? []}
            streaming={activeSession?.currentTurnActive ?? false}
          />
          <div className="px-4 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
            <CommandBar
              onSubmit={onSubmit}
              ensureSession={ensureSession}
              onStop={onStop}
              onInterruptAndSend={onInterruptAndSend}
              onNewConversation={onNewConversation}
              busy={streaming}
              queueDepth={activeSession?.queueDepth ?? 0}
              welcome={isFreshSession}
            />
          </div>
        </main>
      </div>
    </div>
  );
}
