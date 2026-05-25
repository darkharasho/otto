import { useEffect, useRef, useState } from 'react';
import { useRemoteStore } from './store';
import { openWs, getHistory, type WsHandle } from './wire';
import { ApprovalCard } from './approval-card';
import { Screenshot } from './screenshot';

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

function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

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

  const handleEvent = (msg: { type: string; [k: string]: unknown }): void => {
    // Bridge wraps agent events as {type:'event', kind, ...origEvent}.
    if (msg.type === 'pong') return;
    if (msg.type !== 'event') return;
    const kind = msg.kind as string;
    const sid = msg.sessionId as string | undefined;
    if (sid && sid !== sessionIdRef.current) {
      sessionIdRef.current = sid;
      setSessionId(sid);
    }

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
        setStreaming(false);
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
    // Treat as streaming until the next 'done' event.
    setStreaming(true);
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
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-orange-500'}`} />
          <span className="font-medium">Otto</span>
          {deviceLabel && <span className="text-muted text-xs">· {deviceLabel}</span>}
        </div>
        <button onClick={onUnpair} className="text-xs text-muted hover:text-text">Unpair</button>
      </header>

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
                <div className="rounded-md bg-accent/15 text-text px-3 py-2 text-sm whitespace-pre-wrap break-words max-w-[85%]">
                  {it.text}
                </div>
              </div>
            );
          }
          if (it.kind === 'text') {
            return (
              <div key={it.id} className="rounded-md bg-surface px-3 py-2 text-sm whitespace-pre-wrap break-words">
                {it.text}
                {!it.done && <span className="inline-block w-1 h-4 align-middle ml-1 bg-accent animate-pulse" />}
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
