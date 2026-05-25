import { useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Menu } from 'lucide-react';
import { useRemoteStore } from './store';
import { openWs, getHistory, loadMessages, type WsHandle } from './wire';
import { ApprovalCard } from './approval-card';
import { Screenshot } from './screenshot';
import { SessionDrawer } from './SessionDrawer';

type ToolStatus = 'pending' | 'resolved' | 'denied';

interface TextItem { kind: 'text'; id: string; text: string; done: boolean }
interface ToolItem { kind: 'tool'; id: string; callId: string; name: string; input: unknown; status: ToolStatus; result?: unknown; isError?: boolean }
interface ScreenshotItem { kind: 'screenshot'; id: string; shotId: string; signedUrl: string }
interface UserItem { kind: 'user'; id: string; text: string }
type TranscriptItem = TextItem | ToolItem | ScreenshotItem | UserItem;

interface PendingApproval { decisionId: string; tool: string; actionClass: string; summary: string }

function summarizeInput(input: unknown): string {
  if (input == null) return '';
  try {
    const s = typeof input === 'string' ? input : JSON.stringify(input);
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  } catch {
    return String(input);
  }
}

function TypingDots(): JSX.Element {
  return (
    <span className="otto-typing inline-flex" aria-label="Otto is typing">
      <span />
      <span />
      <span />
    </span>
  );
}

function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Tailwind doesn't have @tailwindcss/typography installed, so we map the
// common markdown elements to explicit classes here. Keep this list small —
// it's just enough to make AI responses readable on the phone (paragraphs,
// headings, code, lists, links).
const MD_COMPONENTS = {
  p: (props: { children?: ReactNode }) => <p className="my-1 first:mt-0 last:mb-0">{props.children}</p>,
  h1: (props: { children?: ReactNode }) => <h1 className="text-base font-semibold mt-2 mb-1">{props.children}</h1>,
  h2: (props: { children?: ReactNode }) => <h2 className="text-sm font-semibold mt-2 mb-1">{props.children}</h2>,
  h3: (props: { children?: ReactNode }) => <h3 className="text-sm font-semibold mt-2 mb-1">{props.children}</h3>,
  h4: (props: { children?: ReactNode }) => <h4 className="text-sm font-semibold mt-2 mb-1">{props.children}</h4>,
  ul: (props: { children?: ReactNode }) => <ul className="list-disc pl-5 my-1 space-y-0.5">{props.children}</ul>,
  ol: (props: { children?: ReactNode }) => <ol className="list-decimal pl-5 my-1 space-y-0.5">{props.children}</ol>,
  li: (props: { children?: ReactNode }) => <li>{props.children}</li>,
  a: (props: { href?: string; children?: ReactNode }) => (
    <a href={props.href} target="_blank" rel="noreferrer noopener" className="text-accent underline break-words">{props.children}</a>
  ),
  code: (props: { inline?: boolean; children?: ReactNode }) =>
    props.inline
      ? <code className="rounded bg-bg/60 px-1 py-0.5 font-mono text-[0.85em]">{props.children}</code>
      : <code className="font-mono text-[0.85em]">{props.children}</code>,
  pre: (props: { children?: ReactNode }) => (
    <pre className="my-1 rounded bg-bg/60 p-2 overflow-x-auto text-xs">{props.children}</pre>
  ),
  blockquote: (props: { children?: ReactNode }) => (
    <blockquote className="border-l-2 border-border pl-2 my-1 text-muted">{props.children}</blockquote>
  ),
  hr: () => <hr className="my-2 border-border" />,
  table: (props: { children?: ReactNode }) => <table className="my-1 border-collapse text-xs">{props.children}</table>,
  th: (props: { children?: ReactNode }) => <th className="border border-border px-2 py-1 text-left font-semibold">{props.children}</th>,
  td: (props: { children?: ReactNode }) => <td className="border border-border px-2 py-1">{props.children}</td>,
} as const;

export function Chat(): JSX.Element {
  const token = useRemoteStore((s) => s.token);
  const sessionId = useRemoteStore((s) => s.sessionId);
  const setSessionId = useRemoteStore((s) => s.setSessionId);
  const setToken = useRemoteStore((s) => s.setToken);
  const deviceLabel = useRemoteStore((s) => s.deviceLabel);
  const setDeviceLabel = useRemoteStore((s) => s.setDeviceLabel);

  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const streamWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearWatchdog = (): void => {
    if (streamWatchdogRef.current) {
      clearTimeout(streamWatchdogRef.current);
      streamWatchdogRef.current = null;
    }
  };

  const armWatchdog = (): void => {
    clearWatchdog();
    // If 30s passes after a send with no event from the backend, unjam the
    // UI so the user can try again. The bridge swallows fire-and-forget
    // sendPrompt failures in some paths; this is the client-side safety net.
    streamWatchdogRef.current = setTimeout(() => {
      setStreaming(false);
      setErrorMsg('No response from Otto — try again.');
    }, 30_000);
  };

  const wsRef = useRef<WsHandle | null>(null);
  const backoffRef = useRef(1000);
  const pingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tokenRef = useRef(token);
  const sessionIdRef = useRef(sessionId);
  const lastSeqRef = useRef(0);
  const transcriptEndRef = useRef<HTMLDivElement | null>(null);
  const currentTextIdRef = useRef<string | null>(null);

  useEffect(() => { tokenRef.current = token; }, [token]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);

  // Auto-scroll on new items.
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [items, approvals]);

  const resetForSession = (newSid: string): void => {
    setItems([]);
    setApprovals([]);
    lastSeqRef.current = 0;
    sessionIdRef.current = newSid;
    setSessionId(newSid);
    currentTextIdRef.current = null;
    setStreaming(false);
    clearWatchdog();
    setErrorMsg(null);
  };

  const backfillMessages = async (sid: string): Promise<void> => {
    const tok = tokenRef.current;
    if (!tok) return;
    try {
      const { messages } = await loadMessages(tok, sid);
      const built: TranscriptItem[] = [];
      for (const raw of messages) {
        const role = String((raw as { role?: unknown }).role ?? '');
        const content = ((raw as { content?: unknown }).content ?? []) as Array<Record<string, unknown>>;
        const idBase = String((raw as { id?: unknown }).id ?? newId());
        if (role === 'user') {
          const text = content
            .filter((b) => b.type === 'text' && typeof b.text === 'string')
            .map((b) => String(b.text))
            .join('');
          if (text) built.push({ kind: 'user', id: idBase, text });
          continue;
        }
        if (role === 'assistant') {
          let textBuf = '';
          for (const block of content) {
            const t = block.type;
            if (t === 'text' && typeof block.text === 'string') {
              textBuf += String(block.text);
            } else if (t === 'tool_use') {
              if (textBuf) {
                built.push({ kind: 'text', id: `${idBase}-t-${built.length}`, text: textBuf, done: true });
                textBuf = '';
              }
              const callId = String(block.callId ?? '');
              built.push({
                kind: 'tool',
                id: `${idBase}-tu-${callId || built.length}`,
                callId,
                name: String(block.name ?? ''),
                input: block.input,
                status: 'pending',
              });
            } else if (t === 'tool_result') {
              const callId = String(block.callId ?? '');
              const idx = built.findIndex((it) => it.kind === 'tool' && it.callId === callId);
              if (idx !== -1) {
                const it = built[idx] as ToolItem;
                built[idx] = { ...it, status: 'resolved', result: block.result, isError: Boolean(block.isError) };
              }
            }
          }
          if (textBuf) built.push({ kind: 'text', id: `${idBase}-t-${built.length}`, text: textBuf, done: true });
          continue;
        }
        // tool / system roles: skip in the simple replay.
      }
      setItems(built);
    } catch {
      /* non-fatal — historical replay is best-effort */
    }
  };

  const handleEvent = (msg: { type: string; [k: string]: unknown }): void => {
    if (msg.type === 'pong') return;
    if (msg.type === 'session_switched' && typeof msg.sessionId === 'string') {
      const sid = msg.sessionId;
      resetForSession(sid);
      void backfillMessages(sid);
      return;
    }
    // Surface non-fatal errors (e.g. failed sendPrompt) inline.
    if (msg.type === 'error') {
      clearWatchdog();
      setStreaming(false);
      const m = typeof msg.message === 'string' ? msg.message : 'error';
      setErrorMsg(m);
      return;
    }
    // Bridge wraps agent events as {type:'event', kind, ...origEvent}.
    if (msg.type !== 'event') return;
    const kind = msg.kind as string;
    const sid = msg.sessionId as string | undefined;
    if (sid && sid !== sessionIdRef.current) {
      sessionIdRef.current = sid;
      setSessionId(sid);
    }
    // Any event for our session means the backend is alive — disarm watchdog.
    clearWatchdog();

    switch (kind) {
      case 'user-message': {
        const id = String(msg.messageId ?? newId());
        const text = String(msg.text ?? '');
        setItems((prev) => prev.some((it) => it.id === id) ? prev : [...prev, { kind: 'user', id, text }]);
        return;
      }
      case 'message-start': {
        const id = newId();
        currentTextIdRef.current = id;
        setItems((prev) => [...prev, { kind: 'text', id, text: '', done: false }]);
        setStreaming(true);
        return;
      }
      case 'text-delta': {
        const text = typeof msg.text === 'string' ? msg.text : '';
        setItems((prev) => {
          // Append to current streaming text bubble; create one if missing.
          const idx = prev.findIndex((it) => it.kind === 'text' && it.id === currentTextIdRef.current);
          if (idx === -1) {
            const id = newId();
            currentTextIdRef.current = id;
            return [...prev, { kind: 'text', id, text, done: false }];
          }
          const copy = prev.slice();
          const item = copy[idx] as TextItem;
          copy[idx] = { ...item, text: item.text + text };
          return copy;
        });
        return;
      }
      case 'tool-call-start': {
        const callId = String(msg.callId ?? newId());
        const name = String(msg.name ?? '');
        // End the current text bubble — any subsequent text-deltas should
        // start a new bubble *below* this tool card so the transcript
        // reads in chronological order instead of accreting text above
        // earlier tool calls.
        currentTextIdRef.current = null;
        setItems((prev) => [...prev, { kind: 'tool', id: newId(), callId, name, input: msg.input, status: 'pending' }]);
        return;
      }
      case 'tool-call-result': {
        const callId = String(msg.callId ?? '');
        setItems((prev) => prev.map((it) =>
          it.kind === 'tool' && it.callId === callId
            ? { ...it, status: 'resolved', result: msg.result, isError: Boolean(msg.isError) }
            : it
        ));
        return;
      }
      case 'tool-call-denied': {
        const callId = String(msg.callId ?? '');
        setItems((prev) => prev.map((it) =>
          it.kind === 'tool' && it.callId === callId ? { ...it, status: 'denied' } : it
        ));
        return;
      }
      case 'tool-call-pending': {
        const decisionId = String(msg.decisionId ?? '');
        if (!decisionId) return;
        const tool = String(msg.name ?? '');
        const actionClass = String(msg.actionClass ?? 'reversible');
        const summary = summarizeInput(msg.input);
        setApprovals((prev) => prev.some((p) => p.decisionId === decisionId) ? prev : [...prev, { decisionId, tool, actionClass, summary }]);
        return;
      }
      case 'tool-call-decided': {
        const decisionId = String(msg.decisionId ?? '');
        setApprovals((prev) => prev.filter((p) => p.decisionId !== decisionId));
        return;
      }
      case 'screenshot-captured': {
        const id = String(msg.id ?? '');
        const signedUrl = typeof msg.signedUrl === 'string' ? msg.signedUrl : '';
        if (id && signedUrl) {
          setItems((prev) => [...prev, { kind: 'screenshot', id: newId(), shotId: id, signedUrl }]);
        }
        return;
      }
      case 'message-end':
      case 'done': {
        setStreaming(false);
        setItems((prev) => prev.map((it) => it.kind === 'text' && !it.done ? { ...it, done: true } : it));
        currentTextIdRef.current = null;
        return;
      }
      case 'error': {
        clearWatchdog();
        setStreaming(false);
        const errObj = msg.error as { message?: string } | undefined;
        if (errObj && typeof errObj.message === 'string') setErrorMsg(errObj.message);
        return;
      }
      default:
        return;
    }
  };

  const connect = (): void => {
    const tok = tokenRef.current;
    if (!tok) return;
    const handle = openWs(tok, {
      onAuthOk: ({ deviceLabel: lbl }) => {
        setConnected(true);
        setDeviceLabel(lbl);
        backoffRef.current = 1000;
        // Backfill history for the current session, if known.
        const sid = sessionIdRef.current;
        if (sid) {
          getHistory(tok, sid, lastSeqRef.current).then((h) => {
            for (const entry of h.events) {
              lastSeqRef.current = Math.max(lastSeqRef.current, entry.seq);
              if (entry.event && typeof entry.event === 'object') {
                handleEvent(entry.event as { type: string });
              }
            }
          }).catch(() => { /* non-fatal */ });
        }
        // Ping keepalive.
        if (pingTimerRef.current) clearInterval(pingTimerRef.current);
        pingTimerRef.current = setInterval(() => {
          handle.send({ v: 1, type: 'ping' });
        }, 20_000);
      },
      onEvent: (e) => handleEvent(e),
      onClose: () => {
        setConnected(false);
        if (pingTimerRef.current) { clearInterval(pingTimerRef.current); pingTimerRef.current = null; }
        // Backoff: 1s → 2s → 4s → ... 30s.
        const delay = Math.min(backoffRef.current, 30_000);
        backoffRef.current = Math.min(backoffRef.current * 2, 30_000);
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(() => {
          if (tokenRef.current) connect();
        }, delay);
      },
    });
    wsRef.current = handle;
  };

  useEffect(() => {
    connect();
    return () => {
      if (pingTimerRef.current) clearInterval(pingTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      clearWatchdog();
      wsRef.current?.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSend = (): void => {
    const text = input.trim();
    if (!text || streaming) return;
    // sessionId may be empty on the first send; bridge will route via activeSessionId.
    const sid = sessionIdRef.current ?? '';
    wsRef.current?.send({ v: 1, type: 'prompt', sessionId: sid, text });
    setInput('');
    setErrorMsg(null);
    // Treat as streaming until the next 'done' event.
    setStreaming(true);
    armWatchdog();
  };

  const resolveApproval = (decisionId: string, decision: 'approve' | 'deny'): void => {
    wsRef.current?.send({ v: 1, type: 'approval', decisionId, decision });
    setApprovals((prev) => prev.filter((p) => p.decisionId !== decisionId));
  };

  const onUnpair = (): void => {
    wsRef.current?.close();
    setToken(null);
  };

  return (
    <div className="flex flex-col h-full bg-bg text-text">
      <header className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface sticky top-0 z-10">
        <div className="flex items-center gap-2 text-sm">
          <button
            onClick={() => setDrawerOpen(true)}
            className="p-1 -ml-1 text-muted hover:text-text"
            aria-label="Open sessions"
          >
            <Menu size={20} />
          </button>
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-orange-500'}`} />
          <span className="font-medium">Otto</span>
          {deviceLabel && <span className="text-muted text-xs">· {deviceLabel}</span>}
        </div>
        <button onClick={onUnpair} className="text-xs text-muted hover:text-text">Unpair</button>
      </header>

      {token && (
        <SessionDrawer
          open={drawerOpen}
          token={token}
          currentSessionId={sessionId}
          onClose={() => setDrawerOpen(false)}
          onNewSession={() => {
            wsRef.current?.send({ v: 1, type: 'new_session' });
            setDrawerOpen(false);
          }}
          onPickSession={(sid) => {
            wsRef.current?.send({ v: 1, type: 'switch_session', sessionId: sid });
            setDrawerOpen(false);
          }}
        />
      )}

      {approvals.length > 0 && (
        <div className="sticky top-[57px] z-10 px-3 py-2 space-y-2 bg-bg/95 backdrop-blur border-b border-border">
          {approvals.map((a) => (
            <ApprovalCard
              key={a.decisionId}
              decisionId={a.decisionId}
              tool={a.tool}
              actionClass={a.actionClass}
              summary={a.summary}
              onResolve={(d) => resolveApproval(a.decisionId, d)}
            />
          ))}
        </div>
      )}

      <main className="flex-1 overflow-y-auto px-3 py-4 space-y-3">
        {items.length === 0 && (
          <div className="text-center text-muted text-sm pt-8">
            {connected ? 'Connected. Send a prompt to begin.' : 'Connecting…'}
          </div>
        )}
        {items.map((it) => {
          if (it.kind === 'user') {
            return (
              <div key={it.id} className="flex justify-end">
                <div className="rounded-md bg-accent/15 text-text px-3 py-2 text-sm break-words max-w-[85%]">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                    {it.text}
                  </ReactMarkdown>
                </div>
              </div>
            );
          }
          if (it.kind === 'text') {
            // Bubble-less typing indicator until the first text-delta arrives.
            if (!it.text && !it.done) {
              return (
                <div key={it.id} className="px-3 py-1 text-accent">
                  <TypingDots />
                </div>
              );
            }
            return (
              <div key={it.id} className="rounded-md bg-surface px-3 py-2 text-sm break-words">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                  {it.text}
                </ReactMarkdown>
                {!it.done && (
                  <span className="inline-flex align-middle ml-1 text-accent">
                    <TypingDots />
                  </span>
                )}
              </div>
            );
          }
          if (it.kind === 'tool') {
            return (
              <div key={it.id} className="rounded-md border border-border bg-surface px-3 py-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{it.name}</span>
                  <span className={
                    it.status === 'pending' ? 'text-muted' :
                    it.status === 'denied' ? 'text-danger' :
                    it.isError ? 'text-danger' : 'text-emerald-500'
                  }>
                    {it.status === 'pending' ? '…' : it.status === 'denied' ? 'denied' : it.isError ? 'error' : 'ok'}
                  </span>
                </div>
                <div className="text-muted mt-1 truncate">{summarizeInput(it.input)}</div>
                {it.status === 'resolved' && it.result != null && (
                  <div className="text-muted mt-1 line-clamp-3 whitespace-pre-wrap break-words">
                    {summarizeInput(it.result)}
                  </div>
                )}
              </div>
            );
          }
          // screenshot
          return (
            <div key={it.id} className="rounded-md bg-surface p-2">
              <Screenshot id={it.shotId} signedUrl={it.signedUrl} />
            </div>
          );
        })}
        <div ref={transcriptEndRef} />
      </main>

      {errorMsg && (
        <div className="px-3 py-2 text-xs bg-danger/15 text-danger border-t border-danger/40 flex items-center justify-between gap-2">
          <span className="break-words">{errorMsg}</span>
          <button onClick={() => setErrorMsg(null)} className="text-muted hover:text-text">dismiss</button>
        </div>
      )}

      <footer className="border-t border-border bg-surface p-2 flex items-end gap-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
          }}
          placeholder={connected ? 'Message Otto…' : 'Disconnected — reconnecting…'}
          rows={1}
          disabled={!connected}
          className="flex-1 bg-bg border border-border rounded-md p-2 text-sm resize-none max-h-32 outline-none focus:border-accent disabled:opacity-50"
        />
        <button
          onClick={onSend}
          disabled={!connected || streaming || !input.trim()}
          className="rounded-md bg-accent text-white px-4 py-2 text-sm font-medium disabled:opacity-50"
        >
          Send
        </button>
      </footer>
    </div>
  );
}
