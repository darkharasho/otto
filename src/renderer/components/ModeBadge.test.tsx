import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModeBadge } from './ModeBadge';

let invoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  invoke = vi.fn().mockResolvedValue(undefined);
  (window as unknown as { otto: { invoke: typeof invoke } }).otto = { invoke } as never;
});

describe('ModeBadge', () => {
  it('shows the current mode label', () => {
    render(<ModeBadge mode="balanced" />);
    expect(screen.getByRole('button', { name: /balanced/i })).toBeInTheDocument();
  });

  it('clicking the badge opens a popover with three options', async () => {
    render(<ModeBadge mode="balanced" />);
    await userEvent.click(screen.getByRole('button', { name: /balanced/i }));
    expect(screen.getByText(/strict/i)).toBeInTheDocument();
    expect(screen.getByText(/full-allow/i)).toBeInTheDocument();
  });

  it('selecting a different mode invokes autonomy.setMode', async () => {
    render(<ModeBadge mode="balanced" />);
    await userEvent.click(screen.getByRole('button', { name: /balanced/i }));
    await userEvent.click(screen.getByRole('button', { name: /strict/i }));
    expect(invoke).toHaveBeenCalledWith('autonomy.setMode', { mode: 'strict' });
  });
});
