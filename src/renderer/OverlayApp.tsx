import { useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ipc } from './ipc';
import type { SessionEvent } from '@shared/ipc-contract';
import { OttoMark } from './components/OttoMark';
import { describeTool, summarizeInput, type IconName } from '@shared/tool-presenters';
import { ToolIcon } from './components/ToolIcon';

type StepKind = 'say' | 'tool' | 'pending' | 'denied' | 'process' | 'error';

interface Step {
  id: string;
  kind: StepKind;
  label: string;
  detail?: string;
  group?: string;
  icon?: IconName;
}

const MAX_STEPS = 8;

// Overlay is a glance-and-go ticker — collapse block elements to inline so the
// parent's `line-clamp-2` keeps each turn at two lines. Inline emphasis,
// inline code, and links are preserved with theme-friendly styling.
const OVERLAY_MD = {
  p: (props: { children?: ReactNode }) => <>{props.children}</>,
  h1: (props: { children?: ReactNode }) => <span className="font-semibold">{props.children}</span>,
  h2: (props: { children?: ReactNode }) => <span className="font-semibold">{props.children}</span>,
  h3: (props: { children?: ReactNode }) => <span className="font-semibold">{props.children}</span>,
  h4: (props: { children?: ReactNode }) => <span className="font-semibold">{props.children}</span>,
  ul: (props: { children?: ReactNode }) => <>{props.children}</>,
  ol: (props: { children?: ReactNode }) => <>{props.children}</>,
  li: (props: { children?: ReactNode }) => <span className="before:content-['•_'] before:text-muted">{props.children} </span>,
  strong: (props: { children?: ReactNode }) => <strong className="font-semibold">{props.children}</strong>,
  em: (props: { children?: ReactNode }) => <em className="italic">{props.children}</em>,
  code: (props: { inline?: boolean; children?: ReactNode }) => (
    <code className="rounded bg-bg/60 px-1 py-0.5 font-mono text-[0.9em]">{props.children}</code>
  ),
  pre: (props: { children?: ReactNode }) => <span className="font-mono">{props.children}</span>,
  a: (props: { children?: ReactNode }) => <span className="text-accent underline">{props.children}</span>,
  blockquote: (props: { children?: ReactNode }) => <span className="text-muted">{props.children}</span>,
  hr: () => <span className="text-muted"> — </span>,
  br: () => <> </>,
  // Overlay clamps to two inline lines; an image would blow the layout. Show
  // just the alt text so the user still sees Otto referenced something visual.
  img: (props: { alt?: string }) => (props.alt ? <span className="text-muted italic">[{props.alt}]</span> : null),
} as const;

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

function toStep(ev: SessionEvent, idSeed: number): Step | null {
  switch (ev.type) {
    case 'text-delta': {
      const text = ev.text.trim();
      if (!text) return null;
      return { id: `t${idSeed}`, kind: 'say', label: text };
    }
    case 'tool-call-start': {
      const desc = describeTool(ev.name);
      return {
        id: `c${idSeed}`, kind: 'tool',
        label: desc.label,
        group: desc.group,
        icon: desc.icon,
        detail: summarizeInput(ev.name, ev.input) ?? undefined,
      };
    }
    case 'tool-call-pending': {
      const desc = describeTool(ev.name);
      return {
        id: `p${idSeed}`, kind: 'pending', label: 'awaiting approval',
        detail: desc.group ? `${desc.group} · ${desc.label}` : desc.label,
      };
    }
    case 'tool-call-denied': {
      const desc = describeTool(ev.name);
      return {
        id: `d${idSeed}`, kind: 'denied', label: 'denied',
        detail: desc.group ? `${desc.group} · ${desc.label}` : desc.label,
      };
    }
    case 'sudo-prompt':
      return { id: `su${idSeed}`, kind: 'pending', label: 'awaiting sudo password', detail: truncate(ev.command, 60) };
    case 'process-spawned':
      return { id: `s${idSeed}`, kind: 'process', label: `pid ${ev.pid}`, detail: truncate(ev.command, 60) };
    case 'process-exited':
      return { id: `x${idSeed}`, kind: 'process', label: `exited`, detail: String(ev.exitCode ?? ev.signal ?? '?') };
    case 'error':
      return { id: `e${idSeed}`, kind: 'error', label: 'error', detail: truncate(ev.error.message, 60) };
    default:
      return null;
  }
}

function StepRow({ step }: { step: Step }) {
  if (step.kind === 'say') {
    return (
      <div className="otto-step-enter flex gap-2 items-start py-1">
        <span className="mt-1 inline-block w-1 h-1 rounded-full bg-accent shrink-0" />
        <span className="text-text text-[12.5px] leading-snug line-clamp-2 min-w-0">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={OVERLAY_MD}>
            {step.label}
          </ReactMarkdown>
        </span>
      </div>
    );
  }
  if (step.kind === 'pending') {
    return (
      <div className="otto-step-enter flex gap-2 items-center py-1 text-amber-300">
        <span className="text-[10px] uppercase tracking-wider font-semibold">{step.label}</span>
        <span className="font-mono text-[11px] text-amber-300/80 truncate">{step.detail}</span>
      </div>
    );
  }
  if (step.kind === 'denied' || step.kind === 'error') {
    return (
      <div className="otto-step-enter flex gap-2 items-center py-1 text-danger">
        <span className="text-[10px] uppercase tracking-wider font-semibold">{step.label}</span>
        {step.detail && <span className="font-mono text-[11px] text-danger/80 truncate">{step.detail}</span>}
      </div>
    );
  }
  return (
    <div className="otto-step-enter flex gap-2 items-center py-1 min-w-0">
      {step.icon && <ToolIcon name={step.icon} className="w-3 h-3 text-muted shrink-0" />}
      {step.group && (
        <span className="text-[10px] uppercase tracking-wide text-muted shrink-0">{step.group}</span>
      )}
      <span className="font-medium text-[11.5px] text-text shrink-0">{step.label}</span>
      {step.detail && <span className="font-mono text-[11px] text-text/60 truncate">{step.detail}</span>}
    </div>
  );
}

export function OverlayApp() {
  const [steps, setSteps] = useState<Step[]>([]);
  const counter = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    return ipc.onSessionEvent((ev) => {
      if (ev.type === 'message-start') {
        // New turn — clear the feed so previous turn's noise doesn't linger.
        // We use message-start as a soft reset rather than `done` so the user
        // can still glance at the prior turn's final state during the linger.
        setSteps([]);
        return;
      }
      counter.current += 1;
      const step = toStep(ev, counter.current);
      if (!step) return;
      setSteps((prev) => [...prev, step].slice(-MAX_STEPS));
    });
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [steps]);

  return (
    <div className="h-screen w-screen p-1 pointer-events-none">
      <div className="h-full w-full flex flex-col rounded-2xl bg-surface/85 backdrop-blur-xl border border-border shadow-2xl overflow-hidden font-sans">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60 bg-bg/40 shrink-0">
          <span className="relative flex items-center justify-center w-4 h-4">
            <span aria-hidden className="absolute inset-0 rounded-full bg-accent/30 otto-pulse" />
            <OttoMark className="relative w-4 h-4 text-accent" />
          </span>
          <span className="text-[11px] font-semibold tracking-wide text-text/90">Otto is working</span>
          <span className="ml-auto flex items-center gap-1 text-[10px] text-muted">
            <span className="otto-typing-dot" />
            <span className="otto-typing-dot" style={{ animationDelay: '120ms' }} />
            <span className="otto-typing-dot" style={{ animationDelay: '240ms' }} />
          </span>
        </div>
        <div ref={scrollRef} className="px-3 py-2 flex-1 min-h-0 overflow-hidden">
          {steps.length === 0 ? (
            <div className="text-muted text-[12px] italic py-1">thinking…</div>
          ) : (
            <div className="flex flex-col">
              {steps.map((s) => (
                <StepRow key={s.id} step={s} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
