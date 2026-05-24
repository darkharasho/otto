import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemorySection } from './MemorySection';

const invokeMock = vi.fn();

beforeEach(() => {
  invokeMock.mockReset();
  (globalThis as unknown as { window: { otto: unknown } }).window.otto = {
    invoke: invokeMock,
  };
});

describe('MemorySection', () => {
  it('loads the given kind on mount and renders titles', async () => {
    invokeMock.mockResolvedValueOnce({
      artifacts: [
        {
          id: 'p1', kind: 'playbook', title: 'Restart audio', body: 'steps', tags: ['audio'],
          createdAt: 0, updatedAt: 0, useCount: 3, lastUsedAt: null, archived: false,
        },
      ],
      facts: [],
    });
    render(<MemorySection kind="playbook" />);
    await waitFor(() => expect(screen.getByText('Restart audio')).toBeTruthy());
    expect(invokeMock).toHaveBeenCalledWith('memory.list', expect.objectContaining({ kind: 'playbook' }));
  });

  it('renders facts list when kind is "fact"', async () => {
    invokeMock.mockResolvedValueOnce({
      artifacts: [],
      facts: [{ id: 'f1', body: 'Browser is Zen', pinned: true, useCount: 4, lastUsedAt: null }],
    });
    render(<MemorySection kind="fact" />);
    await waitFor(() => expect(screen.getByText(/Browser is Zen/)).toBeTruthy());
    expect(screen.getByText(/pinned/i)).toBeTruthy();
    expect(screen.getByText(/4×/)).toBeTruthy();
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
    render(<MemorySection kind="playbook" />);
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
