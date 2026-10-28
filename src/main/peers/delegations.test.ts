import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DelegationSnapshot, RemoteEvent } from '@shared/delegation';
import type { Peer, PeerStore } from './peer-store';
import type { ConnectionState, DelegateResult, PeerClient } from './peer-client';
import { DelegationManager, buildDelegationTools } from './delegations';

class FakeClient {
  connectError: Error | null = null;
  delegateImpl: (a: { text: string; sessionId?: string; ifBusy?: 'reject' | 'interrupt' }) => Promise<DelegateResult> =
    async () => ({ kind: 'started', sessionId: 'r1' });
  delegateCalls: Array<{ text: string; sessionId?: string; ifBusy?: 'reject' | 'interrupt' }> = [];
  listeners = new Map<string, Set<(e: RemoteEvent) => void>>();
  stateListeners = new Set<(s: ConnectionState) => void>();
  interrupts: string[] = [];
  decisions: Array<[string, string]> = [];
  sudos: Array<[string, string | null]> = [];
  forgotten: string[] = [];
  closed = false;
  revoked = false;
  connectGate: Promise<void> | null = null;

  async connect() {
    if (this.connectGate) await this.connectGate;
    if (this.connectError) throw this.connectError;
  }
  delegate(a: { text: string; sessionId?: string; ifBusy?: 'reject' | 'interrupt' }) {
    this.delegateCalls.push(a);
    return this.delegateImpl(a);
  }
  onEvent(sid: string, cb: (e: RemoteEvent) => void) {
    let set = this.listeners.get(sid);
    if (!set) { set = new Set(); this.listeners.set(sid, set); }
    set.add(cb);
    return () => { set!.delete(cb); };
  }
  onConnectionChange(cb: (s: ConnectionState) => void) {
    this.stateListeners.add(cb);
    return () => { this.stateListeners.delete(cb); };
  }
  decide(id: string, d: string) { this.decisions.push([id, d]); }
  sudo(id: string, pw: string | null) { this.sudos.push([id, pw]); }
  interrupt(sid: string) { this.interrupts.push(sid); }
  forget(sid: string) { this.forgotten.push(sid); }
  close() { this.closed = true; }

  emit(sid: string, kind: string, extra: Record<string, unknown> = {}) {
    for (const cb of [...(this.listeners.get(sid) ?? [])]) cb({ type: 'event', kind, sessionId: sid, ...extra });
  }
  listenerCount(sid: string) { return this.listeners.get(sid)?.size ?? 0; }
  setState(s: ConnectionState) { for (const cb of [...this.stateListeners]) cb(s); }
}

function makeStore(names: string[], tokenError = false) {
  const peers: Peer[] = names.map((n, i) => ({ id: `p${i}`, name: n, baseUrl: `http://h${i}`, deviceId: `d${i}`, pairedAt: i }));
  return {
    list: () => peers,
    findByName: (q: string) => {
      const lq = q.toLowerCase();
      return peers.find((p) => p.name.toLowerCase() === lq)
        ?? (peers.filter((p) => p.name.toLowerCase().startsWith(lq)).length === 1 ? peers.find((p) => p.name.toLowerCase().startsWith(lq))! : null);
    },
    token: (_id: string) => { if (tokenError) throw new Error('Error while decrypting the ciphertext'); return 'tok'; },
  } as unknown as PeerStore;
}

function setup(opts: { names?: string[]; tokenError?: boolean; waitCapMs?: number } = {}) {
  const clients: FakeClient[] = [];
  let next: FakeClient | null = null;
  const notify = vi.fn();
  const mgr = new DelegationManager({
    store: makeStore(opts.names ?? ['Desk', 'Laptop'], opts.tokenError),
    makeClient: () => { const c = next ?? new FakeClient(); next = null; clients.push(c); return c as unknown as PeerClient; },
    notifyApproval: notify,
    snapshotThrottleMs: 250,
    waitCapMs: opts.waitCapMs ?? 600_000,
  });
  const prime = (c: FakeClient) => { next = c; return c; };
  return { mgr, clients, notify, prime };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

function runArgs(over: Partial<Parameters<DelegationManager['run']>[0]> = {}) {
  const snaps: DelegationSnapshot[] = [];
  const kills: Array<() => void> = [];
  return {
    snaps,
    kills,
    args: {
      localSessionId: 'L1',
      machine: 'Desk',
      task: 'Quit the Slack app.',
      ifBusy: 'ask' as const,
      followUp: false,
      emitSnapshot: (s: DelegationSnapshot) => snaps.push(s),
      registerKill: (k: () => void) => kills.push(k),
      ...over,
    },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('DelegationManager.run', () => {
  it('lists paired machines for an unknown or empty machine', async () => {
    const { mgr } = setup();
    expect(await mgr.run(runArgs({ machine: 'Server' }).args)).toBe('Unknown machine "Server". Paired machines: Desk, Laptop.');
    expect(await mgr.run(runArgs({ machine: '   ' }).args)).toBe('Unknown machine "". Paired machines: Desk, Laptop.');
  });

  it('says none are paired', async () => {
    const { mgr } = setup({ names: [] });
    expect(await mgr.run(runArgs().args)).toBe('No machines are paired. Pair one in Settings → Other machines.');
    expect(mgr.machineNames()).toEqual([]);
  });

  it('trims the machine name', async () => {
    const { mgr, prime } = setup();
    const c = prime(new FakeClient());
    const p = mgr.run(runArgs({ machine: '  desk ' }).args);
    await flush();
    c.emit('r1', 'done');
    expect(await p).toBe('Desk: done. ');
  });

  it('maps a token decrypt failure to a re-pair message', async () => {
    const { mgr } = setup({ tokenError: true });
    const out = await mgr.run(runArgs().args);
    expect(out).toContain('re-pair Desk in Settings → Other machines');
    expect(out).not.toContain('decrypting');
  });

  it('reports an unreachable machine', async () => {
    const { mgr, prime } = setup();
    const c = prime(new FakeClient());
    c.connectError = new Error('unreachable');
    expect(await mgr.run(runArgs().args)).toBe("Desk's Otto isn't reachable — is it on and is Remote enabled in its settings?");
    expect(c.closed).toBe(true);
  });

  it('asks when busy with if_busy ask, without interrupting', async () => {
    const { mgr, prime } = setup();
    const c = prime(new FakeClient());
    c.delegateImpl = async () => ({ kind: 'busy', activeSessionId: 'x' });
    const { args, snaps } = runArgs();
    expect(await mgr.run(args)).toBe('Desk is busy with another task. Ask the user whether to wait for it or interrupt it, then call again with if_busy "wait" or "interrupt".');
    expect(c.delegateCalls[0]!.ifBusy).toBe('reject');
    expect(c.interrupts).toEqual([]);
    expect(snaps.at(-1)!.status).toBe('busy');
  });

  it('polls every 5 s while busy with if_busy wait', async () => {
    const { mgr, prime } = setup();
    const c = prime(new FakeClient());
    let n = 0;
    c.delegateImpl = async () => (++n < 3 ? { kind: 'busy', activeSessionId: 'x' } : { kind: 'started', sessionId: 'r1' });
    const p = mgr.run(runArgs({ ifBusy: 'wait' }).args);
    await flush();
    expect(c.delegateCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(c.delegateCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.delegateCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.delegateCalls).toHaveLength(3);
    expect(c.delegateCalls.every((d) => d.ifBusy === 'reject')).toBe(true);
    c.emit('r1', 'text-delta', { text: 'Quit.' });
    c.emit('r1', 'done');
    expect(await p).toBe('Desk: done. Quit.');
  });

  it('gives up polling at the wait cap', async () => {
    const { mgr, prime } = setup({ waitCapMs: 12_000 });
    const c = prime(new FakeClient());
    c.delegateImpl = async () => ({ kind: 'busy', activeSessionId: 'x' });
    const p = mgr.run(runArgs({ ifBusy: 'wait' }).args);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await p).toContain('Desk is still busy');
    expect(c.interrupts).toEqual([]);
  });

  it('sends ifBusy interrupt only when asked', async () => {
    const { mgr, prime } = setup();
    const c = prime(new FakeClient());
    const p = mgr.run(runArgs({ ifBusy: 'interrupt' }).args);
    await flush();
    expect(c.delegateCalls[0]!.ifBusy).toBe('interrupt');
    c.emit('r1', 'done');
    await p;
  });

  it('returns the summary when finished, unsubscribes and forgets the session', async () => {
    const { mgr, prime } = setup();
    const c = prime(new FakeClient());
    const p = mgr.run(runArgs().args);
    await flush();
    expect(c.delegateCalls[0]).toEqual({ text: 'Quit the Slack app.', sessionId: undefined, ifBusy: 'reject' });
    c.emit('r1', 'tool-call-start', { callId: 'c1', name: 'shell_exec', input: { command: 'pkill slack' } });
    c.emit('r1', 'tool-call-result', { callId: 'c1', result: 'ok' });
    c.emit('r1', 'text-delta', { text: 'Slack is closed.' });
    c.emit('r1', 'done');
    expect(await p).toBe('Desk: done. Slack is closed.');
    expect(c.listenerCount('r1')).toBe(0);
    expect(c.forgotten).toEqual(['r1']);
  });

  it('returns still running past the wait cap and wait reattaches', async () => {
    const { mgr, prime } = setup({ waitCapMs: 60_000 });
    const c = prime(new FakeClient());
    const p = mgr.run(runArgs().args);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await p).toBe('Still running on Desk. Call wait_for_machine to keep watching.');
    expect(c.interrupts).toEqual([]);
    c.emit('r1', 'text-delta', { text: 'Half way. ' });

    const snaps: DelegationSnapshot[] = [];
    const w = mgr.wait({ localSessionId: 'L1', machine: 'desk', emitSnapshot: (s) => snaps.push(s), registerKill: () => {} });
    await flush();
    c.emit('r1', 'text-delta', { text: 'Done.' });
    c.emit('r1', 'done');
    expect(await w).toBe('Desk: done. Half way. Done.');
    expect(snaps.at(-1)!.status).toBe('done');
    // A finished delegation reports its result again.
    expect(await mgr.wait({ localSessionId: 'L1', machine: 'Desk', emitSnapshot: () => {}, registerKill: () => {} })).toBe('Desk: done. Half way. Done.');
  });

  it('wait with nothing delegated says so', async () => {
    const { mgr } = setup();
    expect(await mgr.wait({ localSessionId: 'L1', machine: 'Desk', emitSnapshot: () => {}, registerKill: () => {} }))
      .toBe('Nothing has been delegated to Desk in this conversation.');
    expect(await mgr.wait({ localSessionId: 'L1', machine: 'Nope', emitSnapshot: () => {}, registerKill: () => {} }))
      .toBe('Unknown machine "Nope". Paired machines: Desk, Laptop.');
  });

  it('follow-up reuses the remote session id; a fresh task does not', async () => {
    const { mgr, prime } = setup();
    const c = prime(new FakeClient());
    c.delegateImpl = async (a) => ({ kind: 'started', sessionId: a.sessionId ?? 'r1' });
    const p1 = mgr.run(runArgs().args);
    await flush();
    c.emit('r1', 'done');
    await p1;
    const p2 = mgr.run(runArgs({ task: 'Now reopen it.', followUp: true }).args);
    await flush();
    expect(c.delegateCalls[1]!.sessionId).toBe('r1');
    c.emit('r1', 'done');
    await p2;
    const p3 = mgr.run(runArgs({ task: 'Other.', followUp: false }).args);
    await flush();
    expect(c.delegateCalls[2]!.sessionId).toBeUndefined();
    c.emit('r1', 'done');
    await p3;
    // One client per machine.
    expect(mgr.machineNames()).toEqual(['Desk', 'Laptop']);
  });

  it('keeps one client per machine', async () => {
    const { mgr, clients } = setup();
    const a = mgr.run(runArgs().args);
    const b = mgr.run(runArgs({ localSessionId: 'L2' }).args);
    await flush();
    expect(clients).toHaveLength(1);
    clients[0]!.emit('r1', 'done');
    await Promise.all([a, b]);
  });

  it('reports lost connection and recreates the client next time', async () => {
    const { mgr, clients } = setup();
    const p = mgr.run(runArgs().args);
    await flush();
    clients[0]!.setState('lost');
    expect(await p).toBe('Lost connection to Desk; the task may still be running there.');
    expect(clients[0]!.closed).toBe(true);
    const p2 = mgr.run(runArgs().args);
    await flush();
    expect(clients).toHaveLength(2);
    clients[1]!.emit('r1', 'done');
    await p2;
  });

  it("treats a 'connection lost' rejection from delegate as lost, not unreachable", async () => {
    const { mgr, prime } = setup();
    const c = prime(new FakeClient());
    c.delegateImpl = async () => { throw new Error('connection lost'); };
    expect(await mgr.run(runArgs().args)).toBe('Lost connection to Desk; the task may still be running there.');
  });

  it('surfaces a delegate error message', async () => {
    const { mgr, prime } = setup();
    const c = prime(new FakeClient());
    c.delegateImpl = async () => { throw new Error('boom'); };
    expect(await mgr.run(runArgs().args)).toBe("Desk couldn't start the task: boom");
  });

  it('throttles snapshot emits', async () => {
    const { mgr, prime } = setup();
    const c = prime(new FakeClient());
    const { args, snaps } = runArgs();
    const p = mgr.run(args);
    await flush();
    const before = snaps.length;
    for (let i = 0; i < 10; i++) c.emit('r1', 'text-delta', { text: `${i}` });
    expect(snaps.length - before).toBeLessThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(snaps.at(-1)!.finalText).toBe('0123456789');
    const mid = snaps.length;
    expect(mid - before).toBeLessThanOrEqual(2);
    c.emit('r1', 'done');
    await p;
    expect(snaps.at(-1)!.status).toBe('done');
  });

  it('notifies once per approval decision id', async () => {
    const { mgr, prime, notify } = setup();
    const c = prime(new FakeClient());
    const p = mgr.run(runArgs().args);
    await flush();
    c.emit('r1', 'tool-call-pending', { decisionId: 'd1', name: 'shell_exec', input: {}, actionClass: 'destructive' });
    c.emit('r1', 'text-delta', { text: 'x' });
    c.emit('r1', 'tool-call-pending', { decisionId: 'd1', name: 'shell_exec', input: {}, actionClass: 'destructive' });
    c.emit('r1', 'tool-call-decided', { decisionId: 'd1' });
    c.emit('r1', 'tool-call-pending', { decisionId: 'd2', name: 'click', input: {}, actionClass: 'reversible' });
    expect(notify.mock.calls).toEqual([['Desk', 'shell_exec'], ['Desk', 'click']]);
    mgr.decide('desk', 'd2', 'approve');
    mgr.sudo('Desk', 's1', 'pw');
    expect(c.decisions).toEqual([['d2', 'approve']]);
    expect(c.sudos).toEqual([['s1', 'pw']]);
    c.emit('r1', 'done');
    await p;
  });

  it('kill interrupts the remote session and ends the call', async () => {
    const { mgr, prime } = setup();
    const c = prime(new FakeClient());
    const { args, kills } = runArgs();
    const p = mgr.run(args);
    await flush();
    expect(kills).toHaveLength(1);
    kills[0]!();
    expect(c.interrupts).toEqual(['r1']);
    expect(await p).toMatch(/^Desk: interrupted\./);
  });

  it('interruptAllFor interrupts only that local session', async () => {
    const { mgr, clients } = setup();
    let n = 0;
    const p1 = mgr.run(runArgs({ localSessionId: 'L1' }).args);
    await flush();
    clients[0]!.delegateImpl = async () => ({ kind: 'started', sessionId: `r${++n + 1}` });
    const p2 = mgr.run(runArgs({ localSessionId: 'L2' }).args);
    await flush();
    mgr.interruptAllFor('L1');
    expect(clients[0]!.interrupts).toEqual(['r1']);
    expect(await p1).toMatch(/interrupted/);
    clients[0]!.emit('r2', 'done');
    expect(await p2).toBe('Desk: done. ');
  });

  it('interruptAllFor stops a busy wait without interrupting the remote', async () => {
    const { mgr, prime } = setup();
    const c = prime(new FakeClient());
    c.delegateImpl = async () => ({ kind: 'busy', activeSessionId: 'x' });
    const p = mgr.run(runArgs({ ifBusy: 'wait' }).args);
    await flush();
    mgr.interruptAllFor('L1');
    expect(await p).toBe('Stopped waiting for Desk.');
    expect(c.interrupts).toEqual([]);
    expect(c.delegateCalls).toHaveLength(1);
  });
});

describe('DelegationManager fix round 1', () => {
  it("a 'not connected' rejection (reconnecting) does not close the shared client or strand live delegations", async () => {
    const { mgr, prime } = setup();
    const c = prime(new FakeClient());
    const p1 = mgr.run(runArgs().args);
    await flush();
    c.delegateImpl = async () => { throw new Error('not connected'); };
    expect(await mgr.run(runArgs({ localSessionId: 'L2' }).args)).toBe("Desk's Otto isn't reachable — is it on and is Remote enabled in its settings?");
    expect(c.closed).toBe(false);
    c.emit('r1', 'text-delta', { text: 'ok' });
    c.emit('r1', 'done');
    expect(await p1).toBe('Desk: done. ok');
  });

  it('a lost client ends every live delegation on it as lost', async () => {
    const { mgr, clients } = setup();
    let n = 0;
    const p1 = mgr.run(runArgs().args);
    await flush();
    clients[0]!.delegateImpl = async () => ({ kind: 'started', sessionId: `r${++n + 1}` });
    const p2 = mgr.run(runArgs({ localSessionId: 'L2' }).args);
    await flush();
    clients[0]!.setState('lost');
    expect(await p1).toBe('Lost connection to Desk; the task may still be running there.');
    expect(await p2).toBe('Lost connection to Desk; the task may still be running there.');
  });

  it('forgetPeer ends live delegations as lost, closes the client and recreates it next time', async () => {
    const { mgr, clients } = setup();
    const p = mgr.run(runArgs().args);
    await flush();
    mgr.forgetPeer('p0');
    expect(await p).toBe('Lost connection to Desk; the task may still be running there.');
    expect(clients[0]!.closed).toBe(true);
    const p2 = mgr.run(runArgs().args);
    await flush();
    expect(clients).toHaveLength(2);
    clients[1]!.emit('r1', 'done');
    await p2;
  });

  it('follow-up reads the latest delegation after busy polling', async () => {
    const { mgr, prime } = setup();
    const c = prime(new FakeClient());
    let followCalls = 0;
    c.delegateImpl = async (a) => {
      if (a.text === 'follow' && ++followCalls === 1) return { kind: 'busy', activeSessionId: 'x' };
      return { kind: 'started', sessionId: a.sessionId ?? 'r7' };
    };
    const pf = mgr.run(runArgs({ task: 'follow', followUp: true, ifBusy: 'wait' }).args);
    await flush();
    expect(c.delegateCalls[0]!.sessionId).toBeUndefined();
    const pOther = mgr.run(runArgs({ task: 'other' }).args);
    await flush();
    c.emit('r7', 'done');
    await pOther;
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.delegateCalls[2]).toMatchObject({ text: 'follow', sessionId: 'r7' });
    c.emit('r7', 'done');
    await pf;
  });

  it('a superseded wait gets a final snapshot and no trailing emit', async () => {
    const { mgr, prime } = setup({ waitCapMs: 1000 });
    const c = prime(new FakeClient());
    const p = mgr.run(runArgs().args);
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    const snaps1: DelegationSnapshot[] = [];
    const w1 = mgr.wait({ localSessionId: 'L1', machine: 'Desk', emitSnapshot: (s) => snaps1.push(s), registerKill: () => {} });
    c.emit('r1', 'text-delta', { text: 'a' });
    c.emit('r1', 'text-delta', { text: 'b' });
    const w2 = mgr.wait({ localSessionId: 'L1', machine: 'Desk', emitSnapshot: () => {}, registerKill: () => {} });
    expect(await w1).toBe('Still running on Desk. Call wait_for_machine to keep watching.');
    expect(snaps1.at(-1)!.finalText).toBe('ab');
    const len = snaps1.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(snaps1.length).toBe(len);
    c.emit('r1', 'done');
    await w2;
  });

  it('a cancel while delegate is in flight beats a busy reply', async () => {
    const { mgr, prime } = setup();
    const c = prime(new FakeClient());
    let reply!: (r: DelegateResult) => void;
    c.delegateImpl = () => new Promise((r) => { reply = r; });
    const { args, kills } = runArgs();
    const p = mgr.run(args);
    await flush();
    kills[0]!();
    reply({ kind: 'busy', activeSessionId: 'x' });
    expect(await p).toBe('Stopped waiting for Desk.');
  });

  it('a start that lands after a cancel interrupts it and says so', async () => {
    const { mgr, prime } = setup();
    const c = prime(new FakeClient());
    let reply!: (r: DelegateResult) => void;
    c.delegateImpl = () => new Promise((r) => { reply = r; });
    const { args, kills } = runArgs();
    const p = mgr.run(args);
    await flush();
    kills[0]!();
    reply({ kind: 'started', sessionId: 'r1' });
    expect(await p).toBe('Stopped the task on Desk.');
    expect(c.interrupts).toEqual(['r1']);
  });

  it('forgetPeer during the first connect closes the new client and reports the machine was forgotten', async () => {
    const { mgr, prime } = setup();
    const c = prime(new FakeClient());
    let release!: () => void;
    c.connectGate = new Promise((r) => { release = r; });
    const p = mgr.run(runArgs().args);
    await flush();
    mgr.forgetPeer('p0');
    release();
    expect(await p).toBe('Desk was removed from the paired machines while connecting; the task was not sent.');
    expect(c.closed).toBe(true);
    expect(c.delegateCalls).toEqual([]);
  });

  it('a client lost because the device was revoked asks for a re-pair', async () => {
    const { mgr, clients } = setup();
    const p = mgr.run(runArgs().args);
    await flush();
    clients[0]!.revoked = true;
    clients[0]!.setState('lost');
    const out = await p;
    expect(out).toContain('re-pair Desk in Settings → Other machines');
    expect(out).not.toContain('Lost connection');
  });

  it('an unauthorized connect asks for a re-pair', async () => {
    const { mgr, prime } = setup();
    const c = prime(new FakeClient());
    c.connectError = new Error('unauthorized');
    const out = await mgr.run(runArgs().args);
    expect(out).toContain('re-pair Desk in Settings → Other machines');
    expect(out).not.toContain("isn't reachable");
  });
});

describe('delegation tools', () => {
  it('are registered with the right classes', () => {
    const { mgr } = setup();
    const [delegate, wait] = buildDelegationTools(mgr, 'L1');
    expect(delegate!.name).toBe('delegate_to_machine');
    expect(delegate!.actionClass).toBe('reversible');
    expect(delegate!.actionClassFor!({ machine: 'Desk', task: 'x', if_busy: 'interrupt' })).toBe('destructive');
    expect(delegate!.actionClassFor!({ machine: 'Desk', task: 'x', if_busy: 'wait' })).toBe('reversible');
    expect(delegate!.actionClassFor!({ machine: 'Desk', task: 'x' })).toBe('reversible');
    expect(wait!.name).toBe('wait_for_machine');
    expect(wait!.actionClass).toBe('read');
    expect((delegate!.schema as unknown as { shape: object }).shape).toBeDefined();
  });

  it('pass io through to the manager', async () => {
    const { mgr, clients } = setup();
    const [delegate] = buildDelegationTools(mgr, 'L1');
    const emitSnapshot = vi.fn();
    const kills: Array<() => void> = [];
    const p = delegate!.run({ machine: 'Desk', task: 'Quit Slack.', follow_up: false }, { emitSnapshot, registerKill: (k) => kills.push(k) });
    await flush();
    expect(emitSnapshot).toHaveBeenCalled();
    expect(clients[0]!.delegateCalls[0]!.ifBusy).toBe('reject');
    kills[0]!();
    expect(clients[0]!.interrupts).toEqual(['r1']);
    expect(await p).toMatch(/interrupted/);
  });
});
