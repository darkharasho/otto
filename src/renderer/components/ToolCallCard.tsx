import { useEffect, useRef, useState } from 'react';
import { describeTool, summarizeInput, classifyResult } from '@shared/tool-presenters';
import type { ResultView } from '@shared/tool-presenters';
import { ToolIcon } from './ToolIcon';
import { ToolResultRenderer } from './ToolResultRenderer';
import { ipc } from '../ipc';

interface Props {
  name: string;
  input: unknown;
  result: unknown;
  isError: boolean;
  /** Tool-call id — lets the Stop button on a streaming command reach its child process. */
  callId?: string;
  /** True while the surrounding assistant turn is still streaming. Settle-to-receipt fires when it flips false. */
  turnActive?: boolean;
  /** Rendered inside an activity-group spine — draw the state dot on the left rail. */
  inSpine?: boolean;
  /** Agent-supplied one-liner about the result (annotate_result). */
  takeaway?: string;
  /** Agent-supplied failure explanation; wins over stderr classification. */
  why?: string;
  /** Click reticles merged onto this capture (click→capture merge in Message.tsx). */
  markers?: Array<{ x: number; y: number; label?: string }>;
  /** Streamed stdout/stderr while the call is still running (tool-call-output). */
  partialOutput?: { stdout: string; stderr: string };
  /** Latest partial-result snapshot while the call is still running (tool-call-snapshot, observe). */
  partialSnapshot?: unknown;
}

const SETTLE_AFTER_DONE_MS = 30_000;
const SETTLE_ON_TURN_END_MS = 600;

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatClock(t: number): string {
  const d = new Date(t);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/** One-line right-side text for the receipt form: exit/duration, or the error reason. */
function receiptNote(view: ResultView | null, takeaway?: string): { text: string; tone: 'muted' | 'danger' } | null {
  if (view?.kind === 'error') {
    const first = view.text.split('\n')[0] ?? '';
    return { text: first.length > 64 ? `${first.slice(0, 63)}…` : first, tone: 'danger' };
  }
  if (takeaway) return { text: takeaway, tone: 'muted' };
  if (!view) return null;
  if (view.kind === 'terminal') {
    if (view.takeaway) return { text: view.takeaway, tone: 'muted' };
    if (view.exitCode !== undefined) {
      const dur = view.durationMs !== undefined ? ` · ${(view.durationMs / 1000).toFixed(1)}s` : '';
      return { text: `exit ${view.exitCode}${dur}`, tone: view.exitCode === 0 ? 'muted' : 'danger' };
    }
  }
  if (view.kind === 'observe' && view.verdict) {
    return { text: view.verdict.text, tone: view.verdict.ok ? 'muted' : 'danger' };
  }
  return null;
}

export function ToolCallCard({ name, input, result, isError, callId, turnActive, inSpine, takeaway, why, markers, partialOutput, partialSnapshot }: Props) {
  const status: 'running' | 'done' | 'error' =
    result === undefined ? 'running' : isError ? 'error' : 'done';

  const desc = describeTool(name);
  const summary = summarizeInput(name, input);
  // A running watch renders its latest snapshot as the live view.
  let view = result === undefined
    ? (partialSnapshot !== undefined ? classifyResult(name, partialSnapshot, false, input) : null)
    : classifyResult(name, result, isError, input);
  // Fold agent annotations and click markers into the classified view.
  if (view?.kind === 'terminal' && (takeaway !== undefined || why !== undefined)) {
    view = {
      ...view,
      ...(takeaway !== undefined ? { takeaway } : {}),
      ...(why !== undefined ? { why } : {}),
    };
  }
  if (view?.kind === 'image' && markers && markers.length > 0) {
    view = { ...view, markers };
  }
  // Action note (spec §3): what the click/capture did, under the thumbnail.
  if (view?.kind === 'image' && takeaway !== undefined) {
    view = { ...view, note: takeaway };
  }

  // Cards restored from history (result already present at mount) and quiet
  // tools start settled; live cards settle on turn end or 30s after done.
  // A manual toggle overrides the lifecycle in either direction.
  const [settled, setSettled] = useState(result !== undefined);
  const [override, setOverride] = useState<'expand' | 'receipt' | null>(null);
  const hoveredRef = useRef(false);
  const pendingSettleRef = useRef(false);

  const startRef = useRef(Date.now());
  const [doneAt, setDoneAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  // Elapsed ticker while running.
  useEffect(() => {
    if (status !== 'running') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status]);

  const settle = () => {
    if (hoveredRef.current) {
      pendingSettleRef.current = true; // never collapse under the cursor
    } else {
      setSettled(true);
    }
  };

  // Running → done/error transition: stamp the finish time, arm the 30s settle.
  const wasRunning = useRef(status === 'running');
  const [justFinished, setJustFinished] = useState(false);
  useEffect(() => {
    if (wasRunning.current && status !== 'running') {
      setDoneAt(Date.now());
      if (status === 'done') {
        setJustFinished(true);
        const pop = setTimeout(() => setJustFinished(false), 700);
        const settleTimer = setTimeout(settle, SETTLE_AFTER_DONE_MS);
        wasRunning.current = false;
        return () => { clearTimeout(pop); clearTimeout(settleTimer); };
      }
      const settleTimer = setTimeout(settle, SETTLE_AFTER_DONE_MS);
      wasRunning.current = false;
      return () => clearTimeout(settleTimer);
    }
    wasRunning.current = status === 'running';
  }, [status]);

  // Turn finished → settle shortly after (the assistant's takeaway text has landed).
  const prevTurnActive = useRef(turnActive);
  useEffect(() => {
    if (prevTurnActive.current === true && turnActive === false && status !== 'running') {
      const t = setTimeout(settle, SETTLE_ON_TURN_END_MS);
      prevTurnActive.current = turnActive;
      return () => clearTimeout(t);
    }
    prevTurnActive.current = turnActive;
  }, [turnActive, status]);

  const quiet = !!desc.quiet;
  // Quiet tools skip the expanded phase entirely — while running they show a
  // receipt with a spinner instead.
  const showReceipt =
    override === 'receipt' ||
    (override !== 'expand' && (quiet || (settled && status !== 'running')));

  const note = receiptNote(view, takeaway);
  const dotClass = inSpine
    ? showReceipt
      ? 'bg-[#3f4046]'
      : status === 'error'
        ? 'bg-danger'
        : `bg-accent ${status === 'running' ? 'otto-pulse-dot' : ''}`
    : '';
  const dot = inSpine ? (
    <span aria-hidden className={`absolute -left-[19px] top-[13px] w-[7px] h-[7px] rounded-full ${dotClass}`} />
  ) : null;

  if (showReceipt) {
    return (
      <div className="relative my-1">
        {dot}
        <button
          type="button"
          aria-expanded={false}
          onClick={() => { setOverride('expand'); setSettled(true); }}
          className="otto-receipt w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:border-accent/40 transition-colors"
        >
          <span className="w-4 h-4 rounded bg-accent/10 text-[#b9b9ff] flex items-center justify-center flex-shrink-0">
            <ToolIcon name={desc.icon} className="w-2.5 h-2.5" />
          </span>
          <span className="flex items-baseline gap-1.5 min-w-0 flex-1">
            {desc.group && <span className="text-[11px] text-muted flex-shrink-0">{desc.group}</span>}
            <span className="text-[11px] font-medium truncate">{desc.label}</span>
            {summary && <span className="font-mono text-[11px] text-muted truncate">{summary}</span>}
          </span>
          <span className="flex items-center gap-1.5 flex-shrink-0">
            {note && (
              <span className={`text-[10.5px] truncate max-w-[240px] ${note.tone === 'danger' ? 'text-danger' : 'text-muted'}`}>
                {note.text}
              </span>
            )}
            {doneAt !== null && (
              <span className="font-mono text-[10px] text-[#5f6167]">{formatClock(doneAt)}</span>
            )}
            <StatusGlyph status={status} justFinished={false} small />
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="relative my-2">
      {dot}
      <div className="rounded-[10px] otto-elevated overflow-hidden">
        <button
          type="button"
          aria-expanded={true}
          onClick={() => { setOverride('receipt'); setSettled(true); }}
          onMouseEnter={() => { hoveredRef.current = true; }}
          onMouseLeave={() => {
            hoveredRef.current = false;
            if (pendingSettleRef.current) { pendingSettleRef.current = false; setSettled(true); }
          }}
          className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-surface/40 transition-colors"
        >
          <span className="flex items-center gap-2.5 min-w-0 flex-1">
            <span className="w-6 h-6 rounded-md bg-gradient-to-br from-accent/30 to-accent2/20 text-[#b9b9ff] flex items-center justify-center flex-shrink-0">
              <ToolIcon name={desc.icon} className="w-3.5 h-3.5" />
            </span>
            <span className="flex flex-col min-w-0 text-left">
              <span className="flex items-baseline gap-1.5">
                {desc.group && (
                  <span className="text-[12.5px] font-medium text-muted">{desc.group} ·</span>
                )}
                <span className="text-[12.5px] font-semibold truncate">{desc.label}</span>
              </span>
              {summary && (
                <span className="font-mono text-[11px] text-muted truncate">{summary}</span>
              )}
            </span>
          </span>
          <span className="flex items-center gap-2 flex-shrink-0">
            {status === 'running' ? (
              <span className="font-mono text-[10px] text-[#5f6167]" data-testid="toolcall-elapsed">
                {formatElapsed(now - startRef.current)}
              </span>
            ) : doneAt !== null ? (
              <span className="font-mono text-[10px] text-[#5f6167]">{formatClock(doneAt)}</span>
            ) : null}
            <span className={[
              'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[9.5px] font-semibold uppercase tracking-wide',
              status === 'error'
                ? 'bg-danger/15 text-danger border border-danger/30'
                : status === 'running'
                  ? 'bg-white/[0.04] text-muted border border-border'
                  : 'otto-accent-pill',
            ].join(' ')}>
              <StatusGlyph status={status} justFinished={justFinished} />
              {status}
            </span>
            <svg
              viewBox="0 0 24 24"
              className="w-3 h-3 text-muted rotate-180"
              fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </span>
        </button>
        {status === 'running' && <div className="otto-hairline" aria-hidden />}
        <CardBody
          input={input}
          view={view}
          status={status}
          icon={desc.icon}
          partialOutput={partialOutput}
          onStop={
            callId !== undefined && status === 'running'
              ? () => { void ipc.invoke('shell.killToolCall', { callId }); }
              : undefined
          }
        />
      </div>
    </div>
  );
}

function CardBody({ input, view, status, icon, partialOutput, onStop }: {
  input: unknown;
  view: ResultView | null;
  status: 'running' | 'done' | 'error';
  icon: string;
  partialOutput?: { stdout: string; stderr: string };
  onStop?: () => void;
}) {
  const inputIsEmpty =
    input === undefined ||
    input === null ||
    (typeof input === 'object' && !Array.isArray(input) && Object.keys(input as object).length === 0);

  // Show the evidence, not the plumbing: raw input JSON only when there is no
  // richer view of it (or nothing else to show at all).
  const showInput =
    !inputIsEmpty &&
    (view === null || ['empty', 'json', 'tree', 'kv', 'error'].includes(view.kind)) &&
    view?.kind !== 'terminal';

  // Running bodies: screenshot tools show a capture placeholder; shell tools
  // echo the command in a terminal box that fills live from streamed stdout.
  const command = input && typeof input === 'object' ? (input as Record<string, unknown>)['command'] : undefined;
  const runningView: ResultView | null =
    status === 'running' && typeof command === 'string'
      ? {
          kind: 'terminal',
          command,
          streaming: true,
          ...(partialOutput?.stdout ? { stdout: partialOutput.stdout } : {}),
          ...(partialOutput?.stderr ? { stderr: partialOutput.stderr } : {}),
        }
      : null;

  if (status === 'running' && icon === 'camera') {
    return (
      <div className="px-3 pb-3 border-t border-border/40 pt-3" data-testid="toolcall-details">
        <div className="relative h-[186px] rounded-[7px] border border-border bg-term overflow-hidden flex flex-col items-center justify-center gap-2">
          <div className="otto-scan" aria-hidden />
          <ToolIcon name="camera" className="w-5 h-5 text-muted" />
          <div className="text-[10.5px] text-muted">Capturing the screen — nothing leaves this machine</div>
        </div>
      </div>
    );
  }

  const body = view ?? runningView;
  if ((body === null || body.kind === 'empty') && !showInput) return null;

  return (
    <div data-testid="toolcall-details" className="px-3 pb-3 text-xs space-y-3 border-t border-border/40 pt-3">
      {showInput && (
        <div>
          <div className="text-muted mb-1 text-[10px] uppercase tracking-wide">Input</div>
          <pre className="bg-bg/60 rounded p-2 overflow-x-auto font-mono text-[11px]">
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
      )}
      {body && body.kind !== 'empty' && (
        <div>
          {showInput && (
            <div className="text-muted mb-1 text-[10px] uppercase tracking-wide">Result</div>
          )}
          <ToolResultRenderer view={body} onStop={onStop} />
        </div>
      )}
    </div>
  );
}

function StatusGlyph({ status, justFinished, small }: { status: 'running' | 'done' | 'error'; justFinished: boolean; small?: boolean }) {
  const cls = small ? 'w-3 h-3' : 'w-3.5 h-3.5';
  if (status === 'running') {
    return (
      <svg viewBox="0 0 24 24" className={`${cls} text-muted otto-spin`}
           fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
      </svg>
    );
  }
  if (status === 'error') {
    return (
      <svg viewBox="0 0 24 24" className={`${cls} text-danger`}
           fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={`${cls} text-accent ${justFinished ? 'otto-pop' : ''}`}
         fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}
