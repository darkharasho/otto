import type { ReactNode } from 'react';

interface Props {
  title: string;
  description?: string;
  children: ReactNode;
}

export function SubsectionPage({ title, description, children }: Props) {
  return (
    <section>
      <header>
        <h2 className="text-base font-semibold text-text">{title}</h2>
        {description && <p className="text-xs text-muted mt-1">{description}</p>}
      </header>
      <div className="border-b border-border mt-3 mb-4" />
      <div>{children}</div>
    </section>
  );
}
