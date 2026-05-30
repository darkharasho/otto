import { useMemo, useState } from 'react';
import { Settings, MessagesSquare, Search, Plus, X } from 'lucide-react';
import { ConversationGroup } from './ConversationGroup';
import { ConversationSidebarItem } from './ConversationSidebarItem';
import {
  groupSessions,
  sessionStatusDot,
  type SidebarSession,
} from '../lib/conversation-grouping';

interface Props {
  sessions: SidebarSession[];
  activeSessionId: string | null;
  pinnedIds: string[];
  autonomyLabel: string;
  conversationCount: number;
  onNew: () => void;
  onSelect: (id: string) => void;
  onTogglePin: (id: string) => void;
  onOpenSettings: () => void;
}

function formatSubtitle(s: SidebarSession, now: number): string {
  const diff = now - s.updatedAt;
  const mins = Math.round(diff / 60000);
  if (s.state === 'running') return 'Otto is working…';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago${s.state === 'done' ? ' · done' : ''}`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago${s.state === 'done' ? ' · done' : ''}`;
  return new Date(s.updatedAt).toLocaleDateString();
}

export function ConversationSidebar({
  sessions, activeSessionId, pinnedIds, autonomyLabel, conversationCount,
  onNew, onSelect, onTogglePin, onOpenSettings,
}: Props) {
  const [query, setQuery] = useState('');
  const now = Date.now();

  const filtered = useMemo(
    () => (query ? sessions.filter((s) => s.title.toLowerCase().includes(query.toLowerCase())) : sessions),
    [sessions, query]
  );
  const groups = useMemo(() => groupSessions(filtered, pinnedIds, now), [filtered, pinnedIds, now]);
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);

  const hasNoSessions = sessions.length === 0;
  const hasNoMatches = !hasNoSessions && filtered.length === 0;

  return (
    <aside
      className="flex flex-col relative"
      style={{
        width: 260,
        borderRight: '1px solid rgba(255,255,255,0.04)',
        background: 'linear-gradient(180deg, #0f1014 0%, #0c0d11 100%)',
      }}
    >
      <div className="px-3.5 pt-3.5 pb-2.5 flex flex-col gap-[3px]">
        <div className="text-[10px] text-[#7c7dff] uppercase tracking-[1.6px] font-bold">Workspace</div>
        <div className="text-[13px] text-[#ebecf1] font-semibold leading-tight">Coworking with Otto</div>
        <div className="text-[11px] text-[#6b6e76] tracking-[0.1px]">
          {conversationCount} {conversationCount === 1 ? 'conversation' : 'conversations'} · {pinnedIds.length} pinned
        </div>
      </div>

      <div className="px-2.5 pb-2">
        <button
          type="button"
          onClick={onNew}
          className="w-full flex items-center gap-2 px-2.5 py-2 rounded-[10px] text-[12px] text-[#ebecf1] font-medium transition-colors hover:brightness-110"
          style={{
            background: 'linear-gradient(135deg, rgba(124,125,255,0.16), rgba(168,130,255,0.08))',
            border: '1px solid rgba(124,125,255,0.4)',
            boxShadow: '0 0 16px rgba(124,125,255,0.12) inset',
          }}
        >
          <span className="w-5 h-5 rounded-[7px] flex items-center justify-center text-white"
            style={{ background: 'rgba(124,125,255,0.3)' }}>
            <Plus className="w-3 h-3" strokeWidth={2.4} aria-hidden />
          </span>
          <span className="flex-1 text-left">New conversation</span>
          <span className="text-[10px] text-[#9598a0] font-mono">⌘N</span>
        </button>
      </div>

      <div className="px-2.5 pb-2.5">
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-[9px]"
          style={{ background: '#0a0b0e', border: '1px solid #1c1d23' }}>
          <Search className="w-[13px] h-[13px] text-[#5b5e66] flex-shrink-0" strokeWidth={2.2} aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-[#cfd2d8] placeholder:text-[#5b5e66]"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="flex-shrink-0 w-[14px] h-[14px] rounded-full flex items-center justify-center text-[#6b6e76] hover:text-[#cfd2d8] hover:bg-white/5 transition-colors"
            >
              <X className="w-[10px] h-[10px]" strokeWidth={2.4} aria-hidden />
            </button>
          )}
        </div>
      </div>

      <div className="otto-scrollbar flex-1 overflow-auto px-1.5 pb-1.5">
        {hasNoSessions ? (
          <div className="flex flex-col items-center justify-center text-center px-5 pt-12 pb-8 gap-2.5">
            <MessagesSquare className="w-5 h-5 text-[#3a3b41]" strokeWidth={1.5} aria-hidden />
            <div className="text-[11px] text-[#6b6e76] leading-relaxed">
              No conversations yet.
              <br />
              <span className="text-[#5b5e66]">Start a new one above.</span>
            </div>
          </div>
        ) : hasNoMatches ? (
          <div className="text-center px-5 pt-8 pb-4">
            <div className="text-[11px] text-[#6b6e76]">No matches for “{query}”.</div>
          </div>
        ) : (
          groups.map((g) => (
            <ConversationGroup key={g.label} label={g.label}>
              {g.items.map((s) => (
                <ConversationSidebarItem
                  key={s.id}
                  session={s}
                  status={sessionStatusDot(s.state)}
                  active={s.id === activeSessionId}
                  pinned={pinnedSet.has(s.id)}
                  subtitle={formatSubtitle(s, now)}
                  onSelect={() => onSelect(s.id)}
                  onTogglePin={() => onTogglePin(s.id)}
                />
              ))}
            </ConversationGroup>
          ))
        )}
      </div>

      <div className="px-3 py-2 flex items-center gap-2.5"
        style={{ borderTop: '1px solid rgba(255,255,255,0.04)', background: '#0a0b0e' }}>
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-full"
          style={{ background: 'rgba(82,210,126,0.1)', border: '1px solid rgba(82,210,126,0.35)' }}>
          <span className="w-[5px] h-[5px] rounded-full" style={{ background: '#52d27e', boxShadow: '0 0 6px #52d27e' }} />
          <span className="text-[9px] text-[#9be3b3] font-bold tracking-[0.6px]">{autonomyLabel}</span>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onOpenSettings}
          className="w-[26px] h-[26px] rounded-full flex items-center justify-center text-[#9598a0] transition-colors hover:text-white hover:bg-white/[0.04]"
          style={{ background: '#15161a', border: '1px solid #2a2b2e' }}
          aria-label="Settings"
        >
          <Settings className="w-[13px] h-[13px]" strokeWidth={1.8} aria-hidden />
        </button>
      </div>
    </aside>
  );
}
