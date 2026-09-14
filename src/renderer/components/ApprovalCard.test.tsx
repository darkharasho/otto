import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApprovalCard } from './ApprovalCard';

describe('ApprovalCard', () => {
  const block = {
    type: 'pending_tool_use' as const,
    callId: 'c1',
    decisionId: 'd1',
    name: 'fake-mutate',
    input: { target: 'thing' },
    actionClass: 'reversible' as const,
    reason: 'mode=balanced',
    decision: 'pending' as const,
  };

  let invoke: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    invoke = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { otto: { invoke: typeof invoke } }).otto = { invoke } as never;
  });

  it('renders the verb header, action class badge, and exact input', () => {
    render(<ApprovalCard block={block} />);
    expect(screen.getByText(/fake-mutate/)).toBeInTheDocument();
    expect(screen.getByText(/reversible/i)).toBeInTheDocument();
    expect(screen.getByText(/thing/)).toBeInTheDocument();
  });

  it('reversible: Approve & run sends approve in one click', async () => {
    render(<ApprovalCard block={block} />);
    await userEvent.click(screen.getByRole('button', { name: /approve & run/i }));
    expect(invoke).toHaveBeenCalledWith('autonomy.decide', { decisionId: 'd1', decision: 'approve' });
  });

  it('Approve for session sends approve-session', async () => {
    render(<ApprovalCard block={block} />);
    await userEvent.click(screen.getByRole('button', { name: /session/i }));
    expect(invoke).toHaveBeenCalledWith('autonomy.decide', { decisionId: 'd1', decision: 'approve-session' });
  });

  it('Deny sends deny', async () => {
    render(<ApprovalCard block={block} />);
    await userEvent.click(screen.getByRole('button', { name: /^deny$/i }));
    expect(invoke).toHaveBeenCalledWith('autonomy.decide', { decisionId: 'd1', decision: 'deny' });
  });

  it('destructive: approval is gated behind reviewing the command', async () => {
    render(<ApprovalCard block={{ ...block, actionClass: 'destructive' }} />);
    const approve = screen.getByRole('button', { name: /approve & run/i });
    expect(approve).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: /review the full command/i }));
    expect(screen.getByRole('button', { name: /approve & run/i })).toBeEnabled();
  });

  it('irreversible: approval arms only after typing the confirmation word', async () => {
    render(<ApprovalCard block={{ ...block, actionClass: 'irreversible' }} />);
    const approve = screen.getByRole('button', { name: /approve & run/i });
    expect(approve).toBeDisabled();
    expect(screen.queryByRole('button', { name: /session/i })).toBeNull();
    await userEvent.type(screen.getByLabelText('Confirmation word'), 'confirm');
    expect(screen.getByRole('button', { name: /approve & run/i })).toBeEnabled();
  });

  it('catastrophic block hides Approve for session but keeps Approve and Deny', () => {
    render(<ApprovalCard block={{ ...block, actionClass: 'destructive', catastrophic: true }} />);
    expect(screen.queryByRole('button', { name: /session/i })).toBeNull();
    expect(screen.getByRole('button', { name: /approve & run/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^deny$/i })).toBeInTheDocument();
  });

  it('post-decision: settles to a receipt with attribution', () => {
    render(<ApprovalCard block={{ ...block, decision: 'approved' }} />);
    expect(screen.getByText(/approved by you/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve & run/i })).toBeNull();
  });

  it('denied receipt says denied', () => {
    render(<ApprovalCard block={{ ...block, decision: 'denied' }} />);
    expect(screen.getByText(/denied by you/i)).toBeInTheDocument();
  });
});
