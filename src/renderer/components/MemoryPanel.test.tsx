import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryPanel } from './MemoryPanel';

const invokeMock = vi.fn();

beforeEach(() => {
  invokeMock.mockReset();
  (globalThis as unknown as { window: { otto: unknown } }).window.otto = {
    invoke: invokeMock,
  };
});

describe('MemoryPanel', () => {
  it('loads playbooks by default and renders titles', async () => {
    invokeMock.mockResolvedValueOnce({
      artifacts: [
        {
          id: 'p1', kind: 'playbook', title: 'Restart audio', body: 'steps', tags: ['audio'],
          createdAt: 0, updatedAt: 0, useCount: 3, lastUsedAt: null, archived: false,
        },
      ],
      facts: [],
    });
    render(<MemoryPanel />);
    await waitFor(() => expect(screen.getByText('Restart audio')).toBeTruthy());
    expect(invokeMock).toHaveBeenCalledWith('memory.list', expect.objectContaining({ kind: 'playbook' }));
  });

  it('switches to Facts tab and lists lines', async () => {
    invokeMock.mockResolvedValueOnce({ artifacts: [], facts: [] });
    invokeMock.mockResolvedValueOnce({
      artifacts: [],
      facts: ['- (2026-05-22) Browser is Zen'],
    });
    render(<MemoryPanel />);
    fireEvent.click(screen.getByRole('tab', { name: /facts/i }));
    await waitFor(() => expect(screen.getByText(/Browser is Zen/)).toBeTruthy());
    expect(invokeMock).toHaveBeenLastCalledWith(
      'memory.list',
      expect.objectContaining({ kind: 'fact' })
    );
  });

  it('archive calls memory.update with archived:true and refreshes', async () => {
    invokeMock
      .mockResolvedValueOnce({
        artifacts: [
          {
            id: 'p1', kind: 'playbook', title: 'Restart audio', body: 'steps', tags: [],
            createdAt: 0, updatedAt: 0, useCount: 0, lastUsedAt: null, archived: false,
          },
        ],
        facts: [],
      })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ artifacts: [], facts: [] });
    render(<MemoryPanel />);
    await waitFor(() => expect(screen.getByText('Restart audio')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /archive/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        'memory.update',
        expect.objectContaining({ id: 'p1', patch: { archived: true } })
      )
    );
  });
});
