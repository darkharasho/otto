import type { ReactNode } from 'react';
import { Star } from 'lucide-react';

interface Props {
  label: 'Pinned' | 'Today' | 'Yesterday' | 'Earlier';
  children: ReactNode;
}

export function ConversationGroup({ label, children }: Props) {
  const isPinned = label === 'Pinned';
  return (
    <>
      <div className="flex items-center gap-1.5 px-2.5 pt-3 pb-1.5">
        {isPinned && (
          <Star className="w-[9px] h-[9px] text-[#7c7dff]" strokeWidth={1.8} fill="currentColor" aria-hidden />
        )}
        <span
          className={`text-[9px] uppercase font-bold tracking-[1.4px] ${isPinned ? 'text-[#7c7dff]' : 'text-[#6b6e76]'}`}
        >
          {label}
        </span>
        <span
          className="flex-1 h-px"
          style={{
            background: isPinned
              ? 'linear-gradient(90deg, rgba(124,125,255,0.25), transparent)'
              : 'linear-gradient(90deg, rgba(255,255,255,0.05), transparent)',
          }}
        />
      </div>
      <div className="flex flex-col gap-0.5 px-1.5">{children}</div>
    </>
  );
}
