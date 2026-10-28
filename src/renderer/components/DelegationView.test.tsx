import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DelegationSnapshot } from '@shared/delegation';

const invoke = vi.fn(async () => undefined);
vi.mock('../ipc', () => ({ ipc: { invoke: (...a: unknown[]) => invoke(...(a as [])) } }));

import { DelegationView } from './DelegationView';

function snap(over: Partial<DelegationSnapshot> = {}): DelegationSnapshot {
  return {
    v: 1, machine: 'desk', remoteSessionId: 's', status: 'running',
    items: [
      { kind: 'text', text: 'Checking the **disk**' },
      { kind: 'tool', callId: 'c1', name: 'shell_exec', summary: 'df -h', status: 'done' },
    ],
    pendingApproval: null, pendingSudo: null, finalText: '', ...over,
  };
}
const approval = (catastrophic: boolean) => ({
  decisionId: 'd1', name: 'shell_exec', input: { command: 'ls' }, actionClass: 'reversible' as const, reason: 'r', catastrophic,
});

describe('DelegationView', () => {
  beforeEach(() => invoke.mockClear());

  it('renders machine, status and items', () => {
    render(<DelegationView snapshot={snap()} />);
    expect(screen.getByText('desk')).toBeInTheDocument();
    expect(screen.getByText('Working')).toBeInTheDocument();
    expect(screen.getByText('disk')).toBeInTheDocument();
    expect(screen.getByText('df -h')).toBeInTheDocument();
  });

  it('Approve invokes peers:decide', async () => {
    render(<DelegationView snapshot={snap({ pendingApproval: approval(false) })} />);
    fireEvent.click(screen.getByRole('button', { name: /Approve & run/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('peers:decide', { machine: 'desk', decisionId: 'd1', decision: 'approve' }));
  });

  it('catastrophic approval offers only Deny', () => {
    render(<DelegationView snapshot={snap({ pendingApproval: approval(true) })} />);
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
    expect(screen.getByText('Approve this one at desk.')).toBeInTheDocument();
  });

  it('sudo submit invokes peers:sudo', async () => {
    render(<DelegationView snapshot={snap({ pendingSudo: { promptId: 'p1', command: 'sudo ls' } })} />);
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('peers:sudo', { machine: 'desk', promptId: 'p1', password: 'pw' }));
  });
});
