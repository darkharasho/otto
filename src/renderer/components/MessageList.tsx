import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Message } from '@shared/messages';
import { MessageView } from './Message';

function formatTime(ts: number): string {
  const d = new Date(ts);
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${m} ${ampm}`;
}

interface Props {
  sessionId: string | null;
  messages: Message[];
  streaming: boolean;
  startedAt: number | null;
}

const STICK_THRESHOLD_PX = 80;

// Per-session scroll memory survives session switches within the lifetime of
// the renderer (good enough — full reloads start fresh).
const scrollMemory = new Map<string, number>();

export function MessageList({ sessionId, messages, streaming, startedAt }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(true);
  const [stuck, setStuck] = useState(true);
  const lastSeenLenRef = useRef(messages.length);
  const [unread, setUnread] = useState(0);
  const currentSessionRef = useRef<string | null>(sessionId);

  const streamingMessageId = (() => {
    if (!streaming) return null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      if (m.role === 'assistant') return m.id;
    }
    return null;
  })();

  function checkStuck() {
    const el = containerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isStuck = distance <= STICK_THRESHOLD_PX;
    stuckRef.current = isStuck;
    setStuck(isStuck);
  }

  function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    setUnread(0);
  }

  // Restore remembered scroll position when session changes (or jump to bottom
  // for a brand-new session). Runs before paint to avoid a visible jump.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || sessionId === currentSessionRef.current) return;
    // Persist the outgoing session's position before swapping.
    const prev = currentSessionRef.current;
    if (prev) scrollMemory.set(prev, el.scrollTop);
    currentSessionRef.current = sessionId;
    const remembered = sessionId ? scrollMemory.get(sessionId) : undefined;
    if (remembered !== undefined) {
      el.scrollTop = remembered;
    } else {
      el.scrollTop = el.scrollHeight;
    }
    lastSeenLenRef.current = messages.length;
    checkStuck();
  }, [sessionId, messages.length]);

  // Auto-stick: only follow content when the user is already at the bottom.
  useLayoutEffect(() => {
    if (sessionId !== currentSessionRef.current) return;
    if (stuckRef.current) {
      scrollToBottom(messages.length > lastSeenLenRef.current ? 'smooth' : 'auto');
    } else if (messages.length > lastSeenLenRef.current) {
      setUnread((n) => n + (messages.length - lastSeenLenRef.current));
    }
    lastSeenLenRef.current = messages.length;
  }, [messages, streaming, sessionId]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      checkStuck();
      if (currentSessionRef.current) {
        scrollMemory.set(currentSessionRef.current, el.scrollTop);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    checkStuck();
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={containerRef} className="absolute inset-0 overflow-y-auto px-4">
        {startedAt !== null && (
          <div
            role="separator"
            className="otto-conv-divider flex items-center gap-2 py-3 text-xs text-muted-foreground/70 select-none"
          >
            <div className="flex-1 h-px bg-border/60" />
            <span>New conversation · {formatTime(startedAt)}</span>
            <div className="flex-1 h-px bg-border/60" />
          </div>
        )}
        {messages.map((m) => (
          <MessageView
            key={m.id}
            message={m}
            isStreamingTarget={m.id === streamingMessageId}
          />
        ))}
      </div>
      {!stuck && unread > 0 && (
        <button
          type="button"
          onClick={() => scrollToBottom('smooth')}
          className="otto-pill-enter absolute left-1/2 -translate-x-1/2 bottom-3 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-accent text-white text-xs font-medium shadow-lg hover:bg-accent/90 transition-colors"
        >
          <svg viewBox="0 0 24 24" className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
          {unread} new
        </button>
      )}
    </div>
  );
}
