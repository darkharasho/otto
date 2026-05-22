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
    actionClass: 'destructive' as const,
    reason: 'mode=balanced',
    decision: 'pending' as const,
  };

  let invoke: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    invoke = vi.fn().mockResolvedValue(undefined);
    (window as unknown as { otto: { invoke: typeof invoke } }).otto = { invoke } as never;
  });

  it('renders tool name, action class, and input summary', () => {
    render(<ApprovalCard block={block} />);
    expect(screen.getByText('fake-mutate')).toBeInTheDocument();
    expect(screen.getByText(/destructive/i)).toBeInTheDocument();
    expect(screen.getByText(/thing/)).toBeInTheDocument();
  });

  it('Approve sends autonomy.decide with approve', async () => {
    render(<ApprovalCard block={block} />);
    await userEvent.click(screen.getByRole('button', { name: /^approve$/i }));
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

  it('post-decision: buttons disabled, badge visible', () => {
    render(<ApprovalCard block={{ ...block, decision: 'approved' }} />);
    expect(screen.getByText(/approved/i)).toBeInTheDocument();
    for (const btn of screen.getAllByRole('button')) {
      expect(btn).toBeDisabled();
    }
  });
});
