import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdateBanner } from './UpdateBanner';
import type { UpdaterBridge, UpdaterState } from '@shared/ipc-contract';

function fakeUpdater(initial: UpdaterState) {
  let listener: ((s: UpdaterState) => void) | null = null;
  const bridge: UpdaterBridge = {
    status: vi.fn(async () => initial),
    check: vi.fn(async () => initial),
    download: vi.fn(async () => initial),
    install: vi.fn(async () => undefined),
    onStateChange: vi.fn((cb: (s: UpdaterState) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
  };
  return { bridge, emit: (s: UpdaterState) => act(() => listener?.(s)) };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  localStorage.clear();
});

describe('UpdateBanner', () => {
  it.each<UpdaterState>([
    { kind: 'idle' },
    { kind: 'checking' },
    { kind: 'up-to-date' },
    { kind: 'available', version: '0.15.0' },
    { kind: 'downloading', version: '0.15.0', percent: 40 },
    { kind: 'error', message: 'boom' },
  ])('renders nothing for state $kind', async (state) => {
    const { bridge } = fakeUpdater(state);
    const { container } = render(<UpdateBanner updater={bridge} />);
    await flush();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows version and actions when an update is downloaded', async () => {
    const { bridge } = fakeUpdater({ kind: 'downloaded', version: '0.15.0' });
    render(<UpdateBanner updater={bridge} />);
    expect(await screen.findByText('Otto v0.15.0 is ready.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /restart to update/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /later/i })).toBeInTheDocument();
  });

  it('appears when a live state change reports downloaded', async () => {
    const { bridge, emit } = fakeUpdater({ kind: 'idle' });
    const { container } = render(<UpdateBanner updater={bridge} />);
    await flush();
    expect(container).toBeEmptyDOMElement();
    emit({ kind: 'downloaded', version: '0.15.0' });
    expect(await screen.findByText('Otto v0.15.0 is ready.')).toBeInTheDocument();
  });

  it('calls install when Restart to update is clicked', async () => {
    const { bridge } = fakeUpdater({ kind: 'downloaded', version: '0.15.0' });
    render(<UpdateBanner updater={bridge} />);
    await userEvent.click(await screen.findByRole('button', { name: /restart to update/i }));
    expect(bridge.install).toHaveBeenCalledTimes(1);
  });

  it('Later hides the banner and persists the dismissal for that version', async () => {
    const { bridge } = fakeUpdater({ kind: 'downloaded', version: '0.15.0' });
    const { container, unmount } = render(<UpdateBanner updater={bridge} />);
    await userEvent.click(await screen.findByRole('button', { name: /later/i }));
    expect(container).toBeEmptyDOMElement();
    expect(localStorage.getItem('otto.update-dismissed')).toBe('0.15.0');
    unmount();
    // A fresh mount (new window) stays hidden for the dismissed version.
    const second = render(<UpdateBanner updater={fakeUpdater({ kind: 'downloaded', version: '0.15.0' }).bridge} />);
    await flush();
    expect(second.container).toBeEmptyDOMElement();
  });

  it('shows the banner for a newer version despite an older dismissal', async () => {
    localStorage.setItem('otto.update-dismissed', '0.15.0');
    const { bridge } = fakeUpdater({ kind: 'downloaded', version: '0.16.0' });
    render(<UpdateBanner updater={bridge} />);
    expect(await screen.findByText('Otto v0.16.0 is ready.')).toBeInTheDocument();
  });

  it('appends className to the root element', async () => {
    const { bridge } = fakeUpdater({ kind: 'downloaded', version: '0.15.0' });
    render(<UpdateBanner updater={bridge} className="mb-2" />);
    expect((await screen.findByRole('status')).className).toContain('mb-2');
  });
});
