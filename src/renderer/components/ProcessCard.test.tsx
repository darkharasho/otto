import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProcessCard } from './ProcessCard';

const baseBlock = {
  type: 'process_output' as const,
  handle: 'h1',
  command: 'sleep 60',
  cwd: '/tmp',
  lines: [{ stream: 'stdout' as const, data: 'starting...' }],
  status: 'running' as const,
  exitCode: null,
};

let invoke: ReturnType<typeof vi.fn>;
beforeEach(() => {
  invoke = vi.fn().mockResolvedValue({ killed: true });
  (window as unknown as { otto: { invoke: typeof invoke } }).otto = { invoke } as never;
});

describe('ProcessCard', () => {
  it('renders command, running status, and stdout lines', () => {
    render(<ProcessCard block={baseBlock} />);
    expect(screen.getByText('sleep 60')).toBeInTheDocument();
    // Status label is "RUNNING" (uppercase) in the header badge
    expect(screen.getByText('RUNNING')).toBeInTheDocument();
    expect(screen.getByText('starting...')).toBeInTheDocument();
  });

  it('Cancel button visible while running and invokes shell.kill with the handle', async () => {
    render(<ProcessCard block={baseBlock} />);
    // There is exactly one <button> element with accessible name matching cancel
    const cancel = screen.getByRole('button', { name: /cancel/i });
    expect(cancel).toBeInTheDocument();
    await userEvent.click(cancel);
    expect(invoke).toHaveBeenCalledWith('shell.kill', { handle: 'h1' });
  });

  it('Cancel button hidden once status is not running', () => {
    render(<ProcessCard block={{ ...baseBlock, status: 'exited', exitCode: 0 }} />);
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
  });

  it('shows exit code badge on exited', () => {
    render(<ProcessCard block={{ ...baseBlock, status: 'exited', exitCode: 7 }} />);
    // Header badge reads "EXITED 7"
    expect(screen.getByText('EXITED 7')).toBeInTheDocument();
  });

  it('shows killed badge on killed', () => {
    render(<ProcessCard block={{ ...baseBlock, status: 'killed' }} />);
    // Header badge reads "KILLED"
    expect(screen.getByText('KILLED')).toBeInTheDocument();
  });
});
