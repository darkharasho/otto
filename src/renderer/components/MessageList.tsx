import { useEffect, useRef } from 'react';
import type { Message } from '@shared/messages';
import { MessageView } from './Message';

interface Props {
  messages: Message[];
  streaming: boolean;
}

export function MessageList({ messages, streaming }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, streaming]);

  return (
    <div className="flex-1 overflow-y-auto px-4">
      {messages.map((m) => (
        <MessageView key={m.id} message={m} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
