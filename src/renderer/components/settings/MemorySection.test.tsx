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

  it('renders facts with provenance when kind is "fact"', async () => {
    invokeMock.mockResolvedValueOnce({
      artifacts: [],
      facts: [{
        id: 'f1', body: 'Browser is Zen', pinned: true, useCount: 4,
        lastUsedAt: Date.UTC(2026, 5, 10, 12), createdAt: Date.UTC(2026, 4, 1, 12),
        distinctSessions: 3, archived: false,
      }],
    });
    render(<MemorySection kind="fact" />);
    await waitFor(() => expect(screen.getByText(/Browser is Zen/)).toBeTruthy());
    expect(screen.getByText(/pinned/i)).toBeTruthy();
    const provenance = screen.getByText(/learned .*2026/);
    expect(provenance.textContent).toMatch(/last used/);
    expect(provenance.textContent).toMatch(/3 sessions/);
    expect(provenance.textContent).toMatch(/4×/);
  });

  it('shows an archived badge on archived facts', async () => {
    invokeMock.mockResolvedValueOnce({
      artifacts: [],
      facts: [{
        id: 'f2', body: 'Old fact', pinned: false, useCount: 0,
        lastUsedAt: null, createdAt: Date.UTC(2025, 0, 1), distinctSessions: 0, archived: true,
      }],
    });
    render(<MemorySection kind="fact" />);
    await waitFor(() => expect(screen.getByText(/Old fact/)).toBeTruthy());
    expect(screen.getByText(/archived/i)).toBeTruthy();
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
