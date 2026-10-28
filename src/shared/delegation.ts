import type { ActionClass } from './messages';
import { summarizeInput } from './tool-presenters';

/** A raw frame fanned out by a remote Otto's bridge (wire frame minus nothing; routed by `sessionId`). */
export type RemoteEvent = { type: string; kind?: string; sessionId?: string; [k: string]: unknown };

export type DelegationItem =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; callId: string; name: string; summary: string; status: 'running' | 'done' | 'error' | 'denied'; result?: string };

export interface DelegationSnapshot {
  v: 1;
  machine: string;
  remoteSessionId: string | null;
  status: 'connecting' | 'busy' | 'running' | 'done' | 'interrupted' | 'error' | 'lost';
  items: DelegationItem[];
  pendingApproval: { decisionId: string; name: string; input: unknown; actionClass: ActionClass; reason: string; catastrophic: boolean } | null;
  pendingSudo: { promptId: string; command: string; error?: string } | null;
  finalText: string;
  error?: string;
}

const MAX_RESULT = 2000;
const MAX_ITEMS = 200;
const MAX_SUMMARY = 2000;

export function initialSnapshot(machine: string): DelegationSnapshot {
  return { v: 1, machine, remoteSessionId: null, status: 'connecting', items: [], pendingApproval: null, pendingSudo: null, finalText: '' };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Flatten a tool result (string, content-block array, or object) to bounded text; images become `[image]`. */
function resultToText(result: unknown): string {
  const part = (r: unknown): string => {
    if (r == null) return '';
    if (typeof r === 'string') return r;
    if (Array.isArray(r)) return r.map(part).filter(Boolean).join('\n');
    if (typeof r === 'object') {
      const o = r as Record<string, unknown>;
      if (o.type === 'image' || o.type === 'image-ref') return '[image]';
      if (o.type === 'text' && typeof o.text === 'string') return o.text;
      try { return JSON.stringify(r) ?? ''; } catch { return String(r); }
    }
    return String(r);
  };
  return truncate(part(result), MAX_RESULT);
}

function computeFinalText(items: DelegationItem[]): string {
  let i = items.length;
  while (i > 0 && items[i - 1]?.kind === 'text') i--;
  return items.slice(i).map((it) => (it.kind === 'text' ? it.text : '')).join('');
}

function withItems(s: DelegationSnapshot, items: DelegationItem[], extra: Partial<DelegationSnapshot> = {}): DelegationSnapshot {
  const capped = items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items;
  return { ...s, ...extra, items: capped, finalText: computeFinalText(capped) };
}

function isTerminal(st: DelegationSnapshot['status']): boolean {
  return st === 'done' || st === 'interrupted' || st === 'error' || st === 'lost';
}

function liveStatus(s: DelegationSnapshot): DelegationSnapshot['status'] {
  return isTerminal(s.status) ? s.status : 'running';
}

function updateTool(items: DelegationItem[], callId: string, patch: Partial<Extract<DelegationItem, { kind: 'tool' }>>): DelegationItem[] | null {
  const idx = items.findIndex((it) => it.kind === 'tool' && it.callId === callId);
  if (idx === -1) return null;
  const copy = items.slice();
  copy[idx] = { ...(items[idx] as Extract<DelegationItem, { kind: 'tool' }>), ...patch };
  return copy;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function rebuildFromMessages(messages: unknown[]): DelegationItem[] {
  const items: DelegationItem[] = [];
  for (const raw of messages) {
    const m = raw as { role?: unknown; content?: unknown };
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
    let textBuf = '';
    const flush = (): void => {
      if (textBuf) items.push({ kind: 'text', text: textBuf });
      textBuf = '';
    };
    for (const b of m.content as Array<Record<string, unknown>>) {
      if (b.type === 'text' && typeof b.text === 'string') {
        textBuf += b.text;
      } else if (b.type === 'tool_use') {
        flush();
        const name = str(b.name);
        items.push({ kind: 'tool', callId: str(b.callId), name, summary: summarizeInput(name, b.input) ?? '', status: 'running' });
      } else if (b.type === 'tool_result') {
        const upd = updateTool(items, str(b.callId), { status: b.isError ? 'error' : 'done', result: resultToText(b.result) });
        if (upd) items.splice(0, items.length, ...upd);
      } else if (b.type === 'tool_denied') {
        const callId = str(b.callId);
        const upd = updateTool(items, callId, { status: 'denied' });
        if (upd) items.splice(0, items.length, ...upd);
        else {
          flush();
          const name = str(b.name);
          items.push({ kind: 'tool', callId, name, summary: summarizeInput(name, b.input) ?? '', status: 'denied' });
        }
      }
    }
    flush();
  }
  return items;
}

export function reduceDelegation(s: DelegationSnapshot, e: RemoteEvent): DelegationSnapshot {
  try {
    const sid = typeof e.sessionId === 'string' && e.sessionId ? e.sessionId : null;
    const base = sid && !s.remoteSessionId ? { ...s, remoteSessionId: sid } : s;
    switch (e.kind) {
      case 'message-start':
        return { ...base, status: liveStatus(base) };
      case 'text-delta': {
        const text = str(e.text);
        const last = base.items[base.items.length - 1];
        const items = last && last.kind === 'text'
          ? [...base.items.slice(0, -1), { kind: 'text' as const, text: last.text + text }]
          : [...base.items, { kind: 'text' as const, text }];
        return withItems(base, items, { status: liveStatus(base) });
      }
      case 'tool-call-start': {
        const name = str(e.name);
        const item: DelegationItem = { kind: 'tool', callId: str(e.callId), name, summary: summarizeInput(name, e.input) ?? '', status: 'running' };
        return withItems(base, [...base.items, item], { status: liveStatus(base) });
      }
      case 'tool-call-result': {
        const callId = str(e.callId);
        const denied = base.items.some((it) => it.kind === 'tool' && it.callId === callId && it.status === 'denied');
        const status = denied ? 'denied' : e.isError ? 'error' : 'done';
        const items = updateTool(base.items, callId, { status, result: resultToText(e.result) });
        return items ? withItems(base, items) : base;
      }
      case 'tool-call-denied': {
        const callId = str(e.callId);
        const items = updateTool(base.items, callId, { status: 'denied' });
        if (items) return withItems(base, items);
        const name = str(e.name);
        return withItems(base, [...base.items, { kind: 'tool', callId, name, summary: summarizeInput(name, e.input) ?? '', status: 'denied' }]);
      }
      case 'tool-call-pending': {
        const decisionId = str(e.decisionId);
        if (!decisionId) return base;
        return {
          ...base,
          pendingApproval: {
            decisionId,
            name: str(e.name),
            input: e.input,
            actionClass: (str(e.actionClass) || 'reversible') as ActionClass,
            reason: str(e.reason),
            catastrophic: Boolean(e.catastrophic),
          },
        };
      }
      case 'tool-call-decided': {
        const cleared = base.pendingApproval && (!e.decisionId || base.pendingApproval.decisionId === e.decisionId)
          ? { ...base, pendingApproval: null }
          : base;
        if (e.decision !== 'deny') return cleared;
        const items = updateTool(cleared.items, str(e.callId), { status: 'denied' });
        return items ? withItems(cleared, items) : cleared;
      }
      case 'sudo-prompt': {
        const promptId = str(e.promptId);
        if (!promptId) return base;
        return { ...base, pendingSudo: { promptId, command: str(e.command), ...(typeof e.error === 'string' ? { error: e.error } : {}) } };
      }
      case 'sudo-resolved':
        return { ...base, pendingSudo: null };
      case 'message-cancelled':
        return { ...base, status: 'interrupted', pendingApproval: null, pendingSudo: null };
      case 'error': {
        const err = e.error as { message?: unknown } | undefined;
        return { ...base, status: 'error', error: typeof err?.message === 'string' ? err.message : 'Remote error', pendingApproval: null, pendingSudo: null };
      }
      case 'done':
        return { ...base, status: base.status === 'interrupted' || base.status === 'error' || base.status === 'lost' ? base.status : 'done', pendingApproval: null, pendingSudo: null };
      case 'backfill-messages': {
        if (!Array.isArray(e.messages)) return base;
        return withItems(base, rebuildFromMessages(e.messages));
      }
      default:
        return base;
    }
  } catch {
    return s;
  }
}

export function summarizeForModel(s: DelegationSnapshot): string {
  const denied = s.items.filter((it) => it.kind === 'tool' && it.status === 'denied').map((it) => (it as { name: string }).name);
  let out = `${s.machine}: ${s.status}. ${s.finalText}`;
  if (s.error) out += ` Error: ${s.error}`;
  if (denied.length) out += ` Denied tools: ${[...new Set(denied)].join(', ')}.`;
  return truncate(out, MAX_SUMMARY);
}
