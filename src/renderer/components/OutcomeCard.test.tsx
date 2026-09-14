import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OutcomeCard } from './OutcomeCard';
import type { ContentBlock } from '@shared/messages';

type OutcomeBlock = Extract<ContentBlock, { type: 'outcome' }>;

afterEach(() => {
  vi.restoreAllMocks();
});

const block: OutcomeBlock = {
  type: 'outcome',
  title: 'Stopped the frame hitches in Baldur\'s Gate',
  durationMs: 12 * 60_000,
  toolCalls: 9,
  approvals: 1,
  cause: 'baloo indexing a fresh 200GB dump',
  fix: 'balooctl suspend',
  verified: '0 spikes over 20ms in a 3m watch',
  undoCommand: 'balooctl resume',
  learnedNote: 'baloo indexing causes frame hitches under load',
};

describe('OutcomeCard', () => {
  it('renders title, stats, and the three fact tiles', () => {
    render(<OutcomeCard block={block} />);
    expect(screen.getByText(/Stopped the frame hitches/)).toBeInTheDocument();
    expect(screen.getByText('12 minutes · 9 tool calls · 1 approval')).toBeInTheDocument();
    expect(screen.getByText('Cause')).toBeInTheDocument();
    expect(screen.getByText('balooctl suspend')).toBeInTheDocument();
    expect(screen.getByText('0 spikes over 20ms in a 3m watch')).toBeInTheDocument();
  });

  it('copies the undo command', async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<OutcomeCard block={block} />);
    await userEvent.click(screen.getByRole('button', { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith('balooctl resume');
    expect(screen.getByText('Copied')).toBeInTheDocument();
  });

  it('renders the learned note row', () => {
    render(<OutcomeCard block={block} />);
    expect(screen.getByText(/Saved to machine notes:/)).toBeInTheDocument();
    expect(screen.getByText('baloo indexing causes frame hitches under load')).toBeInTheDocument();
  });

  it('omits undo and learned rows when absent', () => {
    const { undoCommand: _u, learnedNote: _l, approvals: _a, ...rest } = block;
    render(<OutcomeCard block={rest as OutcomeBlock} />);
    expect(screen.queryByText(/Undo anytime/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Saved to machine notes/)).not.toBeInTheDocument();
    expect(screen.getByText('12 minutes · 9 tool calls')).toBeInTheDocument();
  });
});
