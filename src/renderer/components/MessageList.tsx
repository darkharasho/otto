import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Message } from '@shared/messages';
import { MessageView } from './Message';

interface Props {
  messages: Message[];
  streaming: boolean;
}

const STICK_THRESHOLD_PX = 80;

export function MessageList({ messages, streaming }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(true);
  const [stuck, setStuck] = useState(true);
  const lastSeenLenRef = useRef(messages.length);
  const [unread, setUnread] = useState(0);

  // id of the last assistant message — caret target during streaming
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

  // Auto-stick: only follow content when the user is already at the bottom.
  useLayoutEffect(() => {
    if (stuckRef.current) {
      scrollToBottom(messages.length > lastSeenLenRef.current ? 'smooth' : 'auto');
    } else if (messages.length > lastSeenLenRef.current) {
      setUnread((n) => n + (messages.length - lastSeenLenRef.current));
    }
    lastSeenLenRef.current = messages.length;
  }, [messages, streaming]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => checkStuck();
    el.addEventListener('scroll', onScroll, { passive: true });
    checkStuck();
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="relative flex-1 min-h-0">
      <div ref={containerRef} className="absolute inset-0 overflow-y-auto px-4">
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
