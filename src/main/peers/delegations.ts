import { z } from 'zod';
import {
  initialSnapshot,
  reduceDelegation,
  summarizeForModel,
  type DelegationSnapshot,
  type RemoteEvent,
} from '@shared/delegation';
import type { OttoTool } from '../agent/tools';
import type { Peer, PeerStore } from './peer-store';
import type { ConnectionState, DelegateResult, PeerClient } from './peer-client';
import { logger } from '../logger';

type IfBusy = 'ask' | 'wait' | 'interrupt';
type Emit = (s: DelegationSnapshot) => void;

const BUSY_POLL_MS = 5000;

export interface DelegationManagerDeps {
  store: PeerStore;
  makeClient: (p: Peer, token: string) => PeerClient;
  notifyApproval: (machine: string, toolName: string) => void;
  snapshotThrottleMs?: number;
  waitCapMs?: number;
}

export interface RunArgs {
  localSessionId: string;
  machine: string;
  task: string;
  ifBusy: IfBusy;
  followUp: boolean;
  emitSnapshot: Emit;
  registerKill: (k: () => void) => void;
}

export interface WaitArgs {
  localSessionId: string;
  machine: string;
  emitSnapshot: Emit;
  registerKill: (k: () => void) => void;
}

interface Throttle {
  push(s: DelegationSnapshot): void;
  final(s: DelegationSnapshot): void;
}

interface Attachment {
  throttle: Throttle;
  resolve: (out: string) => void;
}

interface Delegation {
  localSessionId: string;
  peerId: string;
  machine: string;
  remoteSessionId: string;
  client: PeerClient;
  snapshot: DelegationSnapshot;
  unsub: (() => void) | null;
  notified: Set<string>;
  attachment: Attachment | null;
  /** Set once terminal; what the model is told from then on. */
  result: string | null;
}

interface RunCtl {
  localSessionId: string;
  cancelled: boolean;
  wake: (() => void) | null;
  delegation: Delegation | null;
}

class TokenError extends Error {}

const msg = {
  none: () => 'No machines are paired. Pair one in Settings → Other machines.',
  unknown: (x: string, names: string[]) => `Unknown machine "${x}". Paired machines: ${names.join(', ')}.`,
  revoked: (m: string) => `${m} no longer accepts this machine's credentials. Ask the user to re-pair ${m} in Settings → Other machines.`,
  repair: (m: string) => `Couldn't read the saved credentials for ${m}. Ask the user to re-pair ${m} in Settings → Other machines.`,
  unreachable: (m: string) => `${m}'s Otto isn't reachable — is it on and is Remote enabled in its settings?`,
  busyAsk: (m: string) =>
    `${m} is busy with another task. Ask the user whether to wait for it or interrupt it, then call again with if_busy "wait" or "interrupt".`,
  busyCap: (m: string) => `${m} is still busy with another task. Ask the user whether to keep waiting or interrupt it.`,
  stillRunning: (m: string) => `Still running on ${m}. Call wait_for_machine to keep watching.`,
  lost: (m: string) => `Lost connection to ${m}; the task may still be running there.`,
  stopped: (m: string) => `Stopped waiting for ${m}.`,
  stoppedTask: (m: string) => `Stopped the task on ${m}.`,
  startFailed: (m: string, e: string) => `${m} couldn't start the task: ${e}`,
  nothing: (m: string) => `Nothing has been delegated to ${m} in this conversation.`,
};

const isTerminal = (s: DelegationSnapshot['status']) => s === 'done' || s === 'interrupted' || s === 'error' || s === 'lost';
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function makeThrottle(emit: Emit, ms: number): Throttle {
  let last = -Infinity;
  let timer: NodeJS.Timeout | null = null;
  let pending: DelegationSnapshot | null = null;
  const send = (s: DelegationSnapshot) => {
    last = Date.now();
    try { emit(s); } catch (err) { logger.warn(`delegations: emitSnapshot threw: ${err}`); }
  };
  const fire = () => {
    timer = null;
    if (pending) { const s = pending; pending = null; send(s); }
  };
  return {
    push(s) {
      pending = s;
      if (timer) return;
      const wait = last + ms - Date.now();
      if (wait <= 0) fire();
      else timer = setTimeout(fire, wait);
    },
    final(s) {
      if (timer) { clearTimeout(timer); timer = null; }
      pending = null;
      send(s);
    },
  };
}

export class DelegationManager {
  private readonly store: PeerStore;
  private readonly makeClient: DelegationManagerDeps['makeClient'];
  private readonly notifyApproval: DelegationManagerDeps['notifyApproval'];
  private readonly throttleMs: number;
  private readonly waitCapMs: number;
  /** One client per peer id; the promise covers the initial connect. */
  private readonly clients = new Map<string, Promise<PeerClient>>();
  private readonly ready = new Map<string, PeerClient>();
  /** Keyed by localSessionId + peer id: the latest delegation to that machine from that conversation. */
  private readonly delegations = new Map<string, Delegation>();
  private readonly runs = new Set<RunCtl>();

  constructor(deps: DelegationManagerDeps) {
    this.store = deps.store;
    this.makeClient = deps.makeClient;
    this.notifyApproval = deps.notifyApproval;
    this.throttleMs = deps.snapshotThrottleMs ?? 250;
    this.waitCapMs = deps.waitCapMs ?? 600_000;
  }

  machineNames(): string[] {
    return this.store.list().map((p) => p.name);
  }

  async run(a: RunArgs): Promise<string> {
    const r = this.resolvePeer(a.machine);
    if ('error' in r) return r.error;
    const ctl: RunCtl = { localSessionId: a.localSessionId, cancelled: false, wake: null, delegation: null };
    this.runs.add(ctl);
    a.registerKill(() => this.cancelRun(ctl));
    try {
      return await this.runInner(a, r.peer, ctl, makeThrottle(a.emitSnapshot, this.throttleMs));
    } finally {
      this.runs.delete(ctl);
    }
  }

  private async runInner(a: RunArgs, peer: Peer, ctl: RunCtl, throttle: Throttle): Promise<string> {
    const name = peer.name;
    let snap = initialSnapshot(name);
    throttle.push(snap);
    // Early exits publish a last snapshot so the card never sits on a stale status.
    const end = (out: string, status: DelegationSnapshot['status'], error?: string): string => {
      throttle.final({ ...snap, status, ...(error ? { error } : {}) });
      return out;
    };
    let client: PeerClient;
    try {
      client = await this.getClient(peer);
    } catch (err) {
      const out = err instanceof TokenError
        ? msg.repair(name)
        : errText(err) === 'unauthorized' ? msg.revoked(name) : msg.unreachable(name);
      return end(out, 'error', out);
    }
    if (ctl.cancelled) return end(msg.stopped(name), 'interrupted');

    const key = keyOf(a.localSessionId, peer.id);
    const deadline = Date.now() + this.waitCapMs;
    let started: string;
    for (;;) {
      let res: DelegateResult;
      const sessionId = a.followUp ? this.delegations.get(key)?.remoteSessionId : undefined;
      try {
        res = await client.delegate({ text: a.task, sessionId, ifBusy: a.ifBusy === 'interrupt' ? 'interrupt' : 'reject' });
      } catch (err) {
        const e = errText(err);
        // The frame may have reached the remote before the socket dropped.
        if (e === 'connection lost') return end(msg.lost(name), 'lost');
        // Never drop the client here: it may be reconnecting on behalf of other live delegations.
        if (e === 'not connected' || e === 'closed') return end(msg.unreachable(name), 'error', msg.unreachable(name));
        return end(msg.startFailed(name, e), 'error', e);
      }
      if (res.kind === 'started') {
        if (ctl.cancelled) {
          client.interrupt(res.sessionId);
          client.forget(res.sessionId);
          return end(msg.stoppedTask(name), 'interrupted');
        }
        started = res.sessionId;
        break;
      }
      snap = { ...snap, status: 'busy' };
      if (ctl.cancelled) return end(msg.stopped(name), 'interrupted');
      if (a.ifBusy !== 'wait') return end(msg.busyAsk(name), 'busy');
      if (Date.now() + BUSY_POLL_MS > deadline) return end(msg.busyCap(name), 'busy');
      throttle.push(snap);
      await this.sleep(BUSY_POLL_MS, ctl);
      if (ctl.cancelled) return end(msg.stopped(name), 'interrupted');
    }

    const prev = this.delegations.get(key);
    if (prev) this.retire(prev, started);
    const d: Delegation = {
      localSessionId: a.localSessionId,
      peerId: peer.id,
      machine: name,
      remoteSessionId: started,
      client,
      snapshot: { ...initialSnapshot(name), remoteSessionId: started, status: 'running' },
      unsub: null,
      notified: new Set(),
      attachment: null,
      result: null,
    };
    this.delegations.set(key, d);
    ctl.delegation = d;
    const outcome = this.attach(d, throttle, deadline);
    // onEvent flushes buffered frames synchronously, which may already finish the delegation.
    const unsub = client.onEvent(started, (e) => this.onRemoteEvent(d, e));
    if (d.result !== null) unsub();
    else d.unsub = unsub;
    return outcome;
  }

  async wait(a: WaitArgs): Promise<string> {
    const r = this.resolvePeer(a.machine);
    if ('error' in r) return r.error;
    const d = this.delegations.get(keyOf(a.localSessionId, r.peer.id));
    if (!d) return msg.nothing(r.peer.name);
    if (d.result !== null) return d.result;
    a.registerKill(() => this.kill(d));
    return this.attach(d, makeThrottle(a.emitSnapshot, this.throttleMs), Date.now() + this.waitCapMs);
  }

  decide(machine: string, decisionId: string, d: 'approve' | 'approve-session' | 'deny'): void {
    this.readyClient(machine)?.decide(decisionId, d);
  }

  sudo(machine: string, promptId: string, pw: string | null): void {
    this.readyClient(machine)?.sudo(promptId, pw);
  }

  /** Drop the cached client for a forgotten peer; live delegations to it end as lost. */
  forgetPeer(peerId: string): void {
    const c = this.ready.get(peerId);
    if (c) this.dropClient(peerId, c);
    this.clients.delete(peerId);
  }

  interruptAllFor(localSessionId: string): void {
    for (const ctl of [...this.runs]) if (ctl.localSessionId === localSessionId) this.cancelRun(ctl);
    for (const d of [...this.delegations.values()]) if (d.localSessionId === localSessionId) this.kill(d);
  }

  private resolvePeer(machine: string): { peer: Peer } | { error: string } {
    const names = this.machineNames();
    if (names.length === 0) return { error: msg.none() };
    const q = machine.trim();
    const peer = q ? this.store.findByName(q) : null;
    return peer ? { peer } : { error: msg.unknown(q, names) };
  }

  private readyClient(machine: string): PeerClient | undefined {
    const peer = this.store.findByName(machine.trim());
    return peer ? this.ready.get(peer.id) : undefined;
  }

  private getClient(peer: Peer): Promise<PeerClient> {
    const cached = this.clients.get(peer.id);
    if (cached) return cached;
    const p = (async () => {
      let token: string;
      try {
        token = this.store.token(peer.id);
      } catch (err) {
        logger.warn(`delegations: could not decrypt token for ${peer.name}: ${errText(err)}`);
        throw new TokenError(errText(err));
      }
      const c = this.makeClient(peer, token);
      try {
        await c.connect();
      } catch (err) {
        c.close();
        throw err;
      }
      c.onConnectionChange((s) => this.onClientState(peer.id, c, s));
      this.ready.set(peer.id, c);
      return c;
    })();
    this.clients.set(peer.id, p);
    p.catch(() => { if (this.clients.get(peer.id) === p) this.clients.delete(peer.id); });
    return p;
  }

  /** Uncache and close a client, ending every live delegation on it as lost. */
  private dropClient(peerId: string, c: PeerClient): void {
    if (this.ready.get(peerId) === c) {
      this.ready.delete(peerId);
      this.clients.delete(peerId);
    }
    for (const d of [...this.delegations.values()]) {
      if (d.client !== c || d.result !== null) continue;
      d.snapshot = { ...d.snapshot, status: 'lost', pendingApproval: null, pendingSudo: null };
      this.finish(d);
    }
    c.close();
  }

  private onClientState(peerId: string, c: PeerClient, s: ConnectionState): void {
    if (s === 'lost') this.dropClient(peerId, c);
  }

  private attach(d: Delegation, throttle: Throttle, deadline: number): Promise<string> {
    if (d.result !== null) return Promise.resolve(d.result);
    const old = d.attachment;
    if (old) {
      d.attachment = null;
      old.throttle.final(d.snapshot);
      old.resolve(msg.stillRunning(d.machine));
    }
    return new Promise((resolve) => {
      const att: Attachment = {
        throttle,
        resolve: (out) => { clearTimeout(timer); resolve(out); },
      };
      const timer = setTimeout(() => {
        if (d.attachment !== att) return;
        d.attachment = null;
        throttle.final(d.snapshot);
        resolve(msg.stillRunning(d.machine));
      }, Math.max(0, deadline - Date.now()));
      d.attachment = att;
      throttle.push(d.snapshot);
    });
  }

  private onRemoteEvent(d: Delegation, e: RemoteEvent): void {
    if (d.result !== null) return;
    d.snapshot = reduceDelegation(d.snapshot, e);
    const pa = d.snapshot.pendingApproval;
    if (pa && !d.notified.has(pa.decisionId)) {
      d.notified.add(pa.decisionId);
      try { this.notifyApproval(d.machine, pa.name); } catch (err) { logger.warn(`delegations: notifyApproval threw: ${err}`); }
    }
    if (isTerminal(d.snapshot.status)) this.finish(d);
    else d.attachment?.throttle.push(d.snapshot);
  }

  private finish(d: Delegation): void {
    if (d.result !== null) return;
    d.result = d.snapshot.status === 'lost' ? msg.lost(d.machine) : summarizeForModel(d.snapshot);
    d.unsub?.();
    d.unsub = null;
    d.client.forget(d.remoteSessionId);
    const att = d.attachment;
    d.attachment = null;
    if (att) {
      att.throttle.final(d.snapshot);
      att.resolve(d.result);
    }
  }

  /** A newer delegation replaced `prev` for the same conversation and machine. */
  private retire(prev: Delegation, newRemoteSessionId: string): void {
    if (prev.result !== null) return;
    prev.result = summarizeForModel(prev.snapshot);
    prev.unsub?.();
    prev.unsub = null;
    if (prev.remoteSessionId !== newRemoteSessionId) prev.client.forget(prev.remoteSessionId);
    const att = prev.attachment;
    prev.attachment = null;
    if (att) {
      att.throttle.final(prev.snapshot);
      att.resolve(prev.result);
    }
  }

  private kill(d: Delegation): void {
    if (d.result !== null) return;
    d.client.interrupt(d.remoteSessionId);
    d.snapshot = { ...d.snapshot, status: 'interrupted', pendingApproval: null, pendingSudo: null };
    this.finish(d);
  }

  private cancelRun(ctl: RunCtl): void {
    ctl.cancelled = true;
    ctl.wake?.();
    if (ctl.delegation) this.kill(ctl.delegation);
  }

  private sleep(ms: number, ctl: RunCtl): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => { ctl.wake = null; resolve(); }, ms);
      ctl.wake = () => { clearTimeout(t); ctl.wake = null; resolve(); };
    });
  }
}

function keyOf(localSessionId: string, peerId: string): string {
  return `${localSessionId}\u0000${peerId}`;
}

const delegateSchema = z.object({
  machine: z.string(),
  task: z.string().min(1),
  if_busy: z.enum(['ask', 'wait', 'interrupt']).optional(),
  follow_up: z.boolean().optional(),
});
const waitSchema = z.object({ machine: z.string() });

export const DELEGATION_TOOL_NAMES = ['delegate_to_machine', 'wait_for_machine'] as const;

export function buildDelegationTools(m: DelegationManager, localSessionId: string): OttoTool[] {
  const delegate: OttoTool = {
    name: 'delegate_to_machine',
    description:
      "Hand a task to the Otto running on another of the user's paired machines and wait for its result. `task` must be self-contained, written in the second person (the other Otto has none of this conversation's context). follow_up: true continues the previous task on that machine. if_busy: what to do if that machine is mid-task — \"ask\" (default) reports it, \"wait\" waits for it to finish, \"interrupt\" stops it (only with the user's say-so).",
    actionClass: 'reversible',
    actionClassFor: (input) => ((input as { if_busy?: unknown } | null)?.if_busy === 'interrupt' ? 'destructive' : 'reversible'),
    schema: delegateSchema,
    async run(input, io) {
      const a = delegateSchema.parse(input);
      return m.run({
        localSessionId,
        machine: a.machine,
        task: a.task,
        ifBusy: a.if_busy ?? 'ask',
        followUp: a.follow_up ?? false,
        emitSnapshot: (s) => io?.emitSnapshot?.(s),
        registerKill: (k) => io?.registerKill?.(k),
      });
    },
  };
  const wait: OttoTool = {
    name: 'wait_for_machine',
    description: 'Keep watching a task delegated to another machine that was still running when delegate_to_machine returned. Returns its result.',
    actionClass: 'read',
    schema: waitSchema,
    async run(input, io) {
      const a = waitSchema.parse(input);
      return m.wait({
        localSessionId,
        machine: a.machine,
        emitSnapshot: (s) => io?.emitSnapshot?.(s),
        registerKill: (k) => io?.registerKill?.(k),
      });
    },
  };
  return [delegate, wait];
}
