import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RemoteDesktopSection } from './RemoteDesktopSection';

const invokeMock = vi.fn();

beforeEach(() => {
  invokeMock.mockReset();
  (globalThis as unknown as { window: Window & { otto?: unknown } }).window.otto = {
    invoke: invokeMock,
  } as never;
});

describe('RemoteDesktopSection', () => {
  it('renders Granted when status reports granted', async () => {
    invokeMock.mockResolvedValueOnce({ granted: true });
    render(<RemoteDesktopSection />);
    await waitFor(() => expect(screen.getByText(/granted/i)).toBeTruthy());
  });

  it('renders Not yet requested when status reports not granted', async () => {
    invokeMock.mockResolvedValueOnce({ granted: false });
    render(<RemoteDesktopSection />);
    await waitFor(() => expect(screen.getByText(/not yet requested/i)).toBeTruthy());
  });

  it('clicking Revoke calls remoteDesktop.revoke and refreshes status', async () => {
    invokeMock
      .mockResolvedValueOnce({ granted: true })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ granted: false });
    render(<RemoteDesktopSection />);
    await waitFor(() => expect(screen.getByText(/granted/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /revoke access/i }));
    fireEvent.click(screen.getByRole('button', { name: /^yes$/i }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('remoteDesktop.revoke', undefined)
    );
  });
});
