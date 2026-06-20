import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Menu, Paperclip } from 'lucide-react';
import { rehypeEmojiIcons } from '../renderer/components/rehype-emoji-icons';
import { EMOJI_TO_ICON, fluentEmojiUrl } from '../renderer/components/emoji-icons';
import { useRemoteStore } from './store';
import { openWs, getHistory, loadMessages, type WsHandle, type ImageRef } from './wire';
import { ApprovalCard } from './approval-card';
import { SudoPromptCard } from './sudo-prompt-card';
import { Screenshot } from './screenshot';
import { SessionDrawer } from './SessionDrawer';
import { describeTool, summarizeInput, classifyResult } from '../shared/tool-presenters';
import { extFromMime } from '../shared/messages';

function userImageUrl(ref: ImageRef, token: string): string {
  return `/user-upload/${ref.sessionId}/${ref.id}.${extFromMime(ref.mimeType)}?token=${encodeURIComponent(token)}`;
}
import { ToolIcon } from './tool-icon';
import { ToolResultRenderer } from './tool-result-renderer';
import { toLocalImageSrc } from '../shared/image-src';

type ToolStatus = 'pending' | 'resolved' | 'denied';

interface TextItem { kind: 'text'; id: string; text: string; done: boolean }
interface ToolItem { kind: 'tool'; id: string; callId: string; name: string; input: unknown; status: ToolStatus; result?: unknown; isError?: boolean }
interface ScreenshotItem { kind: 'screenshot'; id: string; shotId: string; signedUrl: string }
interface UserItem { kind: 'user'; id: string; text: string; content?: Array<{ type: string; [k: string]: unknown }> }
type TranscriptItem = TextItem | ToolItem | ScreenshotItem | UserItem;

interface PendingApproval { decisionId: string; tool: string; actionClass: string; summary: string }
interface PendingSudo { callId: string; promptId: string; command: string; error?: string }

function UnreachableBanner(): JSX.Element {
  const host = typeof window !== 'undefined' ? window.location.host : '';
  return (
    <div className="px-3 py-2 text-xs bg-amber-500/15 border-b border-amber-500/30 text-amber-200 space-y-1">
      <div className="font-semibold">Can&apos;t reach Otto at {host || 'this address'}.</div>
      <div className="text-amber-200/80">
        Still trying. If your desktop restarted, check that Tailscale is online on both devices — or
        re-scan the pairing QR if the URL has changed.
      </div>
    </div>
  );
}

function AddToHomeScreenBanner(): JSX.Element | null {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem('otto.a2hs.dismissed') === '1'; } catch { return false; }
  });
  // iOS-only: navigator.standalone is true once launched from the home screen.
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = (navigator as unknown as { standalone?: boolean }).standalone === true;
  if (!isIos || standalone || dismissed) return null;
  return (
    <div className="flex items-start gap-2 px-3 py-2 text-xs bg-accent/10 border-b border-accent/20 text-text">
      <span className="flex-1">
        Tap <span className="font-semibold">Share → Add to Home Screen</span> so Otto stays paired across launches.
      </span>
      <button
        onClick={() => {
          try { localStorage.setItem('otto.a2hs.dismissed', '1'); } catch { /* */ }
          setDismissed(true);
        }}
        className="text-muted hover:text-text px-1"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  );
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

function ToolCard({ item }: { item: ToolItem }): JSX.Element {
  const [open, setOpen] = useState(false);
  const status =
    item.status === 'pending' ? 'running'
    : item.status === 'denied' ? 'denied'
    : item.isError ? 'error'
    : 'done';
  const statusLabel = status === 'running' ? '…' : status;

  const desc = describeTool(item.name);
  const summary = summarizeInput(item.name, item.input);
  const view = item.result === undefined ? null : classifyResult(item.name, item.result, Boolean(item.isError), item.input);

  const pillClass =
    status === 'running'
      ? 'bg-white/[0.04] border border-border text-muted'
      : status === 'done'
        ? 'otto-accent-pill'
        : 'bg-danger/15 text-danger border border-danger/30';

  return (
    <div className="otto-elevated rounded-[10px] overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-2.5 py-2 text-xs min-h-[44px] hover:bg-white/[0.03]"
      >
        <span className="flex items-center gap-2 min-w-0 flex-1">
          <span className="w-5 h-5 rounded bg-gradient-to-br from-accent/30 to-accent2/20 text-[#b9b9ff] flex items-center justify-center flex-shrink-0">
            <ToolIcon name={desc.icon} className="w-3 h-3" />
          </span>
          <span className="flex flex-col min-w-0 text-left">
            <span className="flex items-baseline gap-1.5">
              {desc.group && (
                <span className="text-[9px] uppercase tracking-wide text-muted font-semibold">{desc.group}</span>
              )}
              <span className="font-semibold truncate">{desc.label}</span>
            </span>
            {summary && (
              <span className="font-mono text-[10px] text-muted truncate">{summary}</span>
            )}
          </span>
        </span>
        <span className="flex items-center gap-1.5 flex-shrink-0">
          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide ${pillClass}`}>{statusLabel}</span>
          <svg
            viewBox="0 0 24 24"
            className={`w-3 h-3 text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
            fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>
      {open && (
        <div className="px-2.5 pb-2.5 space-y-2 border-t border-white/[0.06] pt-2 text-[11px]">
          {item.input !== undefined && item.input !== null && (
            <div>
              <div className="text-muted mb-1 text-[9px] uppercase tracking-wide">Input</div>
              <pre className="bg-bg/60 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words font-mono text-[10px]">
                {JSON.stringify(item.input, null, 2)}
              </pre>
            </div>
          )}
          {view && view.kind !== 'empty' && (
            <div>
              <div className="text-muted mb-1 text-[9px] uppercase tracking-wide">Result</div>
              <ToolResultRenderer view={view} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Tailwind doesn't have @tailwindcss/typography installed, so we map the
// common markdown elements to explicit classes here. Keep this list small —
// it's just enough to make AI responses readable on the phone (paragraphs,
// headings, code, lists, links).
function makeMdComponents(token: string) {
  return {
  ...MD_BASE,
  img: (props: { src?: string; alt?: string }) => {
    const resolved = toLocalImageSrc(props.src, { kind: 'remote', token });
    if (!resolved) return null;
    // span+block: react-markdown wraps images in <p>; <figure> inside <p> is invalid.
    return (
      <span className="block my-2 max-w-full">
        <img
          src={resolved}
          alt={props.alt ?? ''}
          loading="lazy"
          className="rounded-md border border-border w-full h-auto bg-bg/40"
        />
        {props.alt && <span className="block mt-1 text-[10px] text-muted italic">{props.alt}</span>}
      </span>
    );
  },
  } as const;
}

const MD_BASE = {
  // The rehype plugin emits <span class="otto-emoji" data-emoji="…" />; render
  // Lucide for mapped emojis and Fluent Emoji High Contrast (via CSS mask)
  // for everything else, matching the desktop look.
  span: (props: { className?: string; children?: ReactNode; 'data-emoji'?: string }) => {
    const classes = props.className ?? '';
    if (classes.includes('otto-emoji')) {
      const emoji = props['data-emoji'];
      if (emoji) {
        const Icon = EMOJI_TO_ICON[emoji];
        if (Icon) {
          return (
            <Icon
              className="inline-block align-[-0.2em] mx-[0.1em] w-[1.1em] h-[1.1em] text-accent"
              strokeWidth={2.25}
              aria-label={emoji}
            />
          );
        }
        const url = fluentEmojiUrl(emoji);
        if (url) {
          return (
            <span
              role="img"
              aria-label={emoji}
              title={emoji}
              className="otto-emoji-mask text-accent"
              style={{ WebkitMaskImage: `url(${url})`, maskImage: `url(${url})` }}
            />
          );
        }
        return null;
      }
    }
    return <span className={classes}>{props.children}</span>;
  },
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
  const mdComponents = useMemo(() => makeMdComponents(token ?? ''), [token]);
  const sessionId = useRemoteStore((s) => s.sessionId);
  const setSessionId = useRemoteStore((s) => s.setSessionId);
  const setToken = useRemoteStore((s) => s.setToken);
  const deviceLabel = useRemoteStore((s) => s.deviceLabel);
  const setDeviceLabel = useRemoteStore((s) => s.setDeviceLabel);

  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [sudos, setSudos] = useState<PendingSudo[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [queueDepth, setQueueDepth] = useState(0);
  const busy = streaming || queueDepth > 0;
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [pendingUploads, setPendingUploads] = useState<Array<{ correlationId: string; mimeType: string; previewUrl: string }>>([]);
  const [confirmedAttachments, setConfirmedAttachments] = useState<ImageRef[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const failedReconnectsRef = useRef(0);
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

  function bytesToBase64(bytes: Uint8Array): string {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  async function stageFile(file: File): Promise<void> {
    const ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
    if (!(ALLOWED as readonly string[]).includes(file.type)) return;
    const correlationId = crypto.randomUUID();
    const previewUrl = URL.createObjectURL(file);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const bytesBase64 = bytesToBase64(bytes);
    setPendingUploads((p) => [...p, { correlationId, mimeType: file.type, previewUrl }]);
    wsRef.current?.send({
      v: 1,
      type: 'attach',
      sessionId: sessionIdRef.current ?? '',
      mimeType: file.type as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
      bytesBase64,
      clientCorrelationId: correlationId,
    });
  }

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
    setSudos([]);
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
          const hasContent = text || content.some((b) => b.type === 'image-ref');
          const typedContent = content as Array<{ type: string; [k: string]: unknown }>;
          if (hasContent) built.push({ kind: 'user', id: idBase, text, content: typedContent });
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
    if (msg.type === 'attach_ok') {
      const cid = typeof msg.clientCorrelationId === 'string' ? msg.clientCorrelationId : '';
      const ref = msg.ref as ImageRef;
      // Revoke the pending preview blob URL — the HTTP URL is now canonical.
      setPendingUploads((p) => {
        const match = p.find((u) => u.correlationId === cid);
        if (match) URL.revokeObjectURL(match.previewUrl);
        return p.filter((u) => u.correlationId !== cid);
      });
      setConfirmedAttachments((c) => [...c, ref]);
      return;
    }
    if (msg.type === 'attach_err') {
      const cid = typeof msg.clientCorrelationId === 'string' ? msg.clientCorrelationId : '';
      setPendingUploads((p) => {
        const match = p.find((u) => u.correlationId === cid);
        if (match) URL.revokeObjectURL(match.previewUrl);
        return p.filter((u) => u.correlationId !== cid);
      });
      console.warn('attach failed', msg.message);
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
        const content = Array.isArray(msg.content) ? (msg.content as Array<{ type: string; [k: string]: unknown }>) : undefined;
        setItems((prev) => prev.some((it) => it.id === id) ? prev : [...prev, { kind: 'user', id, text, content }]);
        return;
      }
      case 'user-message-queued': {
        const depth = typeof msg.queueDepth === 'number' ? msg.queueDepth : 0;
        setQueueDepth(depth);
        return;
      }
      case 'user-message-consumed': {
        const depth = typeof msg.queueDepth === 'number' ? msg.queueDepth : 0;
        setQueueDepth(depth);
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
        setItems((prev) => {
          // Close any in-flight text bubble so its inline typing dots stop
          // animating above the tool card; the bottom-anchored indicator
          // takes over while the tool runs.
          const closed = prev.map((it) => it.kind === 'text' && !it.done ? { ...it, done: true } : it);
          return [...closed, { kind: 'tool', id: newId(), callId, name, input: msg.input, status: 'pending' }];
        });
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
        const summary = summarizeInput(tool, msg.input) ?? '';
        setApprovals((prev) => prev.some((p) => p.decisionId === decisionId) ? prev : [...prev, { decisionId, tool, actionClass, summary }]);
        return;
      }
      case 'tool-call-decided': {
        const decisionId = String(msg.decisionId ?? '');
        setApprovals((prev) => prev.filter((p) => p.decisionId !== decisionId));
        return;
      }
      case 'sudo-prompt': {
        const callId = String(msg.callId ?? '');
        const promptId = String(msg.promptId ?? '');
        if (!callId || !promptId) return;
        const command = String(msg.command ?? '');
        const error = typeof msg.error === 'string' ? msg.error : undefined;
        // A retry re-emits with a new promptId for the same callId — replace in place.
        setSudos((prev) => {
          const rest = prev.filter((s) => s.callId !== callId);
          return [...rest, { callId, promptId, command, error }];
        });
        return;
      }
      case 'sudo-resolved': {
        const callId = String(msg.callId ?? '');
        setSudos((prev) => prev.filter((s) => s.callId !== callId));
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
        setUnreachable(false);
        failedReconnectsRef.current = 0;
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
        failedReconnectsRef.current += 1;
        // After ~3 failures (~7s of backoff), surface the routing banner so
        // the user can see the URL their phone is trying to reach instead of
        // sitting in a silent reconnect loop. Tailnet IP changes and asleep
        // Tailscale clients are the usual culprits.
        if (failedReconnectsRef.current >= 3) setUnreachable(true);
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
    if (!text && confirmedAttachments.length === 0) return;
    if (pendingUploads.length > 0) return; // don't send while uploads in flight
    // sessionId may be empty on the first send; bridge will route via activeSessionId.
    const sid = sessionIdRef.current ?? '';
    wsRef.current?.send({
      v: 1,
      type: 'prompt',
      sessionId: sid,
      text,
      attachmentIds: confirmedAttachments.length > 0 ? confirmedAttachments.map((r) => r.id) : undefined,
    });
    setInput('');
    setErrorMsg(null);
    setConfirmedAttachments([]);
    // Treat as streaming until the next 'done' event.
    setStreaming(true);
    armWatchdog();
  };

  const resolveApproval = (decisionId: string, decision: 'approve' | 'deny'): void => {
    wsRef.current?.send({ v: 1, type: 'approval', decisionId, decision });
    setApprovals((prev) => prev.filter((p) => p.decisionId !== decisionId));
  };

  const resolveSudo = (promptId: string, password: string | null): void => {
    wsRef.current?.send({ v: 1, type: 'sudo', promptId, password });
    // Drop the card optimistically; a retry will re-add it via sudo-prompt.
    setSudos((prev) => prev.filter((s) => s.promptId !== promptId));
  };

  const onUnpair = (): void => {
    wsRef.current?.close();
    setToken(null);
  };

  const onStop = (): void => {
    const sid = sessionIdRef.current ?? '';
    wsRef.current?.send({ v: 1, type: 'interrupt', sessionId: sid });
  };

  return (
    <div className="flex flex-col h-full bg-bg text-text">
      <header className="flex items-center justify-between px-4 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-3 border-b border-border bg-surface sticky top-0 z-10">
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
      <AddToHomeScreenBanner />
      {unreachable && !connected && <UnreachableBanner />}

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

      {(approvals.length > 0 || sudos.length > 0) && (
        <div className="sticky top-[57px] z-10 px-3 py-2 space-y-2 bg-bg/95 backdrop-blur border-b border-border">
          {sudos.map((s) => (
            <SudoPromptCard
              key={s.callId}
              command={s.command}
              error={s.error}
              onResolve={(pw) => resolveSudo(s.promptId, pw)}
            />
          ))}
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
            const imageRefs = (it.content ?? []).filter((b) => b.type === 'image-ref') as Array<{ type: 'image-ref'; id: string; sessionId: string; mimeType: string; [k: string]: unknown }>;
            return (
              <div key={it.id} className="flex justify-end">
                <div className="rounded-[10px] bg-gradient-to-br from-accent/20 to-accent/10 border border-accent/20 text-text px-3 py-2 text-sm break-words max-w-[85%] space-y-1 shadow-sm">
                  {imageRefs.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-1">
                      {imageRefs.map((ref) => {
                        if (!token) {
                          return (
                            <span key={ref.id} className="text-muted text-xs italic">📷 image</span>
                          );
                        }
                        return (
                          <img
                            key={ref.id}
                            src={userImageUrl(ref as ImageRef, token)}
                            alt=""
                            loading="lazy"
                            className="rounded-md max-h-40 object-contain border border-border"
                          />
                        );
                      })}
                    </div>
                  )}
                  {it.text && (
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeEmojiIcons]} components={mdComponents}>
                      {it.text}
                    </ReactMarkdown>
                  )}
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
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeEmojiIcons]} components={mdComponents}>
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
            return <ToolCard key={it.id} item={it} />;
          }
          // screenshot
          return (
            <div key={it.id} className="rounded-md bg-surface p-2">
              <Screenshot id={it.shotId} signedUrl={it.signedUrl} />
            </div>
          );
        })}
        {streaming && !items.some((it) => it.kind === 'text' && !it.done) && (
          <div className="px-3 py-1 text-accent">
            <TypingDots />
          </div>
        )}
        <div ref={transcriptEndRef} />
      </main>

      {queueDepth > 0 && (
        <div
          className="px-3 py-1 text-[11px] text-muted border-t border-border bg-surface/60"
          aria-live="polite"
        >
          {queueDepth} queued
        </div>
      )}
      {errorMsg && (
        <div className="px-3 py-2 text-xs bg-danger/15 text-danger border-t border-danger/40 flex items-center justify-between gap-2">
          <span className="break-words">{errorMsg}</span>
          <button onClick={() => setErrorMsg(null)} className="text-muted hover:text-text">dismiss</button>
        </div>
      )}

      <footer className="border-t border-border bg-surface pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="flex items-end gap-2 p-2">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) {
                for (const file of Array.from(e.target.files)) {
                  void stageFile(file);
                }
              }
              e.target.value = '';
            }}
          />
          {/* Paperclip button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={!connected}
            className="flex-shrink-0 p-2 text-muted hover:text-text disabled:opacity-50"
            aria-label="Attach image"
          >
            <Paperclip size={18} />
          </button>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
            }}
            onPaste={(e) => {
              const items = Array.from(e.clipboardData?.items ?? []);
              const imageItems = items.filter((item) => item.kind === 'file' && item.type.startsWith('image/'));
              if (imageItems.length > 0) {
                e.preventDefault();
                for (const item of imageItems) {
                  const file = item.getAsFile();
                  if (file) void stageFile(file);
                }
              }
            }}
            placeholder={
              !connected
                ? 'Disconnected — reconnecting…'
                : busy
                  ? 'Otto is working — your message will queue'
                  : 'Message Otto…'
            }
            rows={1}
            disabled={!connected}
            className="flex-1 bg-bg border border-border rounded-md p-2 text-sm resize-none max-h-32 outline-none focus:border-accent disabled:opacity-50"
          />
          {/* Inline attachment chips — between textarea and send button */}
          {(pendingUploads.length > 0 || confirmedAttachments.length > 0) && (
            <div className="flex gap-1 flex-wrap items-end shrink-0 max-w-[30%]">
              {confirmedAttachments.map((a) => (
                <div key={a.id} className="flex items-center gap-1 px-1.5 py-0.5 bg-bg/60 rounded text-[10px]">
                  {token ? (
                    <img src={userImageUrl(a, token)} alt="" className="h-5 w-5 object-cover rounded" />
                  ) : (
                    <img src={`otto-user-image://${a.sessionId}/${a.id}.${extFromMime(a.mimeType)}`} alt="" className="h-5 w-5 object-cover rounded" />
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmedAttachments((s) => s.filter((x) => x.id !== a.id));
                    }}
                    aria-label="Remove attachment"
                  >×</button>
                </div>
              ))}
              {pendingUploads.map((p) => (
                <div key={p.correlationId} className="flex items-center gap-1 px-1.5 py-0.5 bg-bg/60 rounded text-[10px] opacity-60">
                  <img src={p.previewUrl} alt="" className="h-5 w-5 object-cover rounded" />
                </div>
              ))}
            </div>
          )}
          {busy && (
            <button
              onClick={onStop}
              className="rounded-md bg-danger/80 hover:bg-danger text-white px-3 py-2 text-sm font-medium"
              aria-label="Stop current turn"
            >
              Stop
            </button>
          )}
          <button
            onClick={onSend}
            disabled={!connected || (!input.trim() && confirmedAttachments.length === 0) || pendingUploads.length > 0}
            className="otto-send rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </footer>
    </div>
  );
}
