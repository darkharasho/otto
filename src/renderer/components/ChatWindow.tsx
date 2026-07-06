import { useEffect, useMemo, useState, type RefObject } from 'react';
import { Sparkles } from 'lucide-react';
import { ChatTitlebar } from './ChatTitlebar';
import { ConversationSidebar } from './ConversationSidebar';
import { MessageList } from './MessageList';
import { CommandBar } from './CommandBar';
import { TopicShiftChip } from './TopicShiftChip';
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
  onPrivateConversation: (args: { text: string; attachments: ImageRef[] }) => void | Promise<void>;
  onSelectSession: (id: string) => void | Promise<void>;
  isPrivate?: boolean;
  voice?: { mode: boolean; state: 'idle' | 'starting' | 'listening' | 'transcribing' | 'speaking' | 'error'; onToggle(): void; micButtonRef?: RefObject<HTMLButtonElement>; downloadPct?: number | null };
  topicShift?: { onStartNew(): void; onKeepGoing(): void };
}

export function ChatWindow({
  onSubmit,
  ensureSession,
  onStop,
  onInterruptAndSend,
  onNewConversation,
  onPrivateConversation,
  onSelectSession,
  isPrivate = false,
  voice,
  topicShift,
}: Props) {
  const sessions = useOttoStore((s) => s.sessions);
  const activeSession = useOttoStore((s) => s.activeSession);
  const pinnedIds = useOttoStore((s) => s.pinnedSessionIds);
  const togglePinned = useOttoStore((s) => s.togglePinned);
  const autonomyMode = useOttoStore((s) => s.mode);

  const streaming = isSessionBusy(activeSession);
  const isFreshSession = !activeSession || activeSession.messages.length === 0;
  const [isMaximized, setIsMaximized] = useState(false);
  const [hideChord, setHideChord] = useState<string | null>(null);
  const showEmptyPane = !activeSession;

  useEffect(() => {
    void ipc.invoke('shortcut.info', undefined).then((info) => {
      setHideChord(info.registered ? info.recommendedChord : null);
    });
  }, []);

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
        isPrivate={isPrivate}
        isMaximized={isMaximized}
        hideChord={hideChord}
        mode={autonomyMode}
        onMinimize={() => void ipc.invoke('window.minimize', undefined)}
        onToggleMaximize={() => {
          setIsMaximized((v) => !v);
          void ipc.invoke('window.toggleMaximize', undefined);
        }}
      />

      <div className="flex flex-1 min-h-0">
        <ConversationSidebar
          sessions={sidebarSessions}
          activeSessionId={activeSession?.id ?? null}
          pinnedIds={pinnedIds}
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
          {showEmptyPane ? (
            <div className="flex-1 flex flex-col items-center justify-center px-8 text-center gap-3">
              <div
                className="w-9 h-9 rounded-[10px] flex items-center justify-center"
                style={{
                  background: 'linear-gradient(135deg, rgba(124,125,255,0.14), rgba(168,130,255,0.06))',
                  border: '1px solid rgba(124,125,255,0.22)',
                }}
              >
                <Sparkles className="w-[15px] h-[15px] text-[#a882ff]" strokeWidth={1.6} aria-hidden />
              </div>
              <div className="text-[12px] text-[#9598a0] max-w-[280px] leading-relaxed">
                Ask Otto to do something, or pick a conversation from the sidebar.
              </div>
              <div className="text-[10px] text-[#5b5e66] mt-1">
                <kbd className="px-1.5 py-[1px] rounded-[5px] bg-[#1b1c22] border border-[#2a2b2e] font-mono text-[#9598a0]">⌘N</kbd> for a new conversation
              </div>
            </div>
          ) : (
            <MessageList
              sessionId={activeSession?.id ?? null}
              messages={activeSession?.messages ?? []}
              streaming={activeSession?.currentTurnActive ?? false}
            />
          )}
          <div className="px-4 py-3" style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
            {topicShift && (
              <div className="mb-2">
                <TopicShiftChip onStartNew={topicShift.onStartNew} onKeepGoing={topicShift.onKeepGoing} />
              </div>
            )}
            <CommandBar
              onSubmit={onSubmit}
              ensureSession={ensureSession}
              onStop={onStop}
              onInterruptAndSend={onInterruptAndSend}
              onNewConversation={onNewConversation}
              onPrivateConversation={onPrivateConversation}
              isPrivate={isPrivate}
              busy={streaming}
              queueDepth={activeSession?.queueDepth ?? 0}
              welcome={isFreshSession}
              voice={voice}
            />
          </div>
        </main>
      </div>
    </div>
  );
}
