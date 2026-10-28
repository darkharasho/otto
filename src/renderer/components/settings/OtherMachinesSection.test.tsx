import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OtherMachinesSection } from './OtherMachinesSection';

const invokeMock = vi.fn();
let machines: Array<{ id: string; name: string; baseUrl: string; pairedAt: number; online: boolean }>;

beforeEach(() => {
  invokeMock.mockReset();
  machines = [
    { id: '1', name: 'Desk', baseUrl: 'http://desk:17829', pairedAt: 1, online: true },
    { id: '2', name: 'Laptop', baseUrl: 'http://laptop:17829', pairedAt: 2, online: false },
  ];
  invokeMock.mockImplementation(async (ch: string) => (ch === 'peers:list' ? machines : undefined));
  (globalThis as unknown as { window: { otto: unknown } }).window.otto = { invoke: invokeMock };
});

const fill = (link: string, name?: string) => {
  fireEvent.change(screen.getByLabelText(/pairing link/i), { target: { value: link } });
  if (name !== undefined) fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: name } });
};

describe('OtherMachinesSection', () => {
  it('renders machines with their online state', async () => {
    render(<OtherMachinesSection />);
    await waitFor(() => expect(screen.getByText('Desk')).toBeTruthy());
    expect(screen.getByText('Laptop')).toBeTruthy();
    expect(screen.getAllByRole('img', { name: 'online' })).toHaveLength(1);
    expect(screen.getAllByRole('img', { name: 'offline' })).toHaveLength(1);
  });

  it('prefills the name from the link host up to the first dot', async () => {
    render(<OtherMachinesSection />);
    fill('http://steamdeck.tail1234.ts.net:17829/pair?code=abc');
    expect((screen.getByLabelText(/^name$/i) as HTMLInputElement).value).toBe('steamdeck');
  });

  it('adds a machine, refreshes and shows the new-conversation hint', async () => {
    render(<OtherMachinesSection />);
    fill('http://desk2:17829/pair?code=abc', '  Desk 2 ');
    fireEvent.click(screen.getByRole('button', { name: 'Add machine' }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith('peers:add', {
        name: 'Desk 2',
        pairingUrl: 'http://desk2:17829/pair?code=abc',
      }),
    );
    await waitFor(() => expect(screen.getByText('Start a new conversation (/n) to use it.')).toBeTruthy());
    expect(invokeMock.mock.calls.filter((c) => c[0] === 'peers:list').length).toBeGreaterThanOrEqual(2);
  });

  it('does not submit a whitespace-only name', async () => {
    render(<OtherMachinesSection />);
    fill('http://desk2:17829/pair?code=abc', '   ');
    const btn = screen.getByRole('button', { name: 'Add machine' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(invokeMock).not.toHaveBeenCalledWith('peers:add', expect.anything());
  });

  it.each([
    'That link has expired — make a new one on the other machine.',
    "Couldn't reach that machine.",
    'You already have a machine called "Desk".',
  ])('renders the error: %s', async (msg) => {
    invokeMock.mockImplementation(async (ch: string) => {
      if (ch === 'peers:add') throw new Error(`Error invoking remote method 'peers:add': Error: ${msg}`);
      return machines;
    });
    render(<OtherMachinesSection />);
    fill('http://desk:17829/pair?code=abc', 'Desk');
    fireEvent.click(screen.getByRole('button', { name: 'Add machine' }));
    await waitFor(() => expect(screen.getByText(msg)).toBeTruthy());
    expect(screen.queryByText('Start a new conversation (/n) to use it.')).toBeNull();
  });

  it('Forget calls peers:remove after confirmation', async () => {
    vi.stubGlobal('confirm', () => true);
    render(<OtherMachinesSection />);
    await waitFor(() => expect(screen.getByText('Desk')).toBeTruthy());
    fireEvent.click(screen.getAllByRole('button', { name: 'Forget' })[0]!);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('peers:remove', { id: '1' }));
    vi.unstubAllGlobals();
  });
});
