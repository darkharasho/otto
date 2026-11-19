import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { DelegationSnapshot } from '@shared/delegation';
import { ToolCardBody } from './index';

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

describe('DelegationCard (phone surfaces)', () => {
  it('renders the remote machine, status and transcript instead of a bare status line', () => {
    render(<ToolCardBody view={{ kind: 'delegation', snapshot: snap() }} compact />);
    expect(screen.getByText('desk')).toBeInTheDocument();
    expect(screen.getByText('Working')).toBeInTheDocument();
    expect(screen.getByText('disk')).toBeInTheDocument();
    expect(screen.getByText('df -h')).toBeInTheDocument();
  });

  it('shows a waiting note for a remote approval, with no decision buttons', () => {
    const pendingApproval = {
      decisionId: 'd1', name: 'shell_exec', input: { command: 'ls' },
      actionClass: 'reversible' as const, reason: 'r', catastrophic: false,
    };
    render(<ToolCardBody view={{ kind: 'delegation', snapshot: snap({ pendingApproval }) }} compact />);
    expect(screen.getByText(/Waiting for approval of .* on desk\./)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('surfaces a sudo wait and a delegation error', () => {
    render(
      <ToolCardBody
        view={{ kind: 'delegation', snapshot: snap({ status: 'error', error: 'desk is not reachable', pendingSudo: { promptId: 'p1', command: 'sudo ls' } }) }}
        compact
      />
    );
    expect(screen.getByText('Waiting for a password on desk.')).toBeInTheDocument();
    expect(screen.getByText('desk is not reachable')).toBeInTheDocument();
    expect(screen.getByText('Error')).toBeInTheDocument();
  });
});
