import { type ReactNode } from 'react';

interface Props {
  header: ReactNode;
  footer: ReactNode;
  children: ReactNode;
}

export function Panel({ header, footer, children }: Props) {
  return (
    <div className="flex flex-col h-full w-full rounded-xl bg-surface border border-border shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-bg/50">
        {header}
      </div>
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
      <div className="border-t border-border px-3 py-2 bg-bg/40">{footer}</div>
    </div>
  );
}
