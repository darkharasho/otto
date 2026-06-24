import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommandBar } from './CommandBar';

const noopEnsure = async () => 's1';

describe('CommandBar', () => {
  it('renders an input with a placeholder', () => {
    render(<CommandBar onSubmit={() => {}} ensureSession={noopEnsure} />);
    expect(screen.getByPlaceholderText(/ask otto/i)).toBeInTheDocument();
  });

  it('calls onSubmit with trimmed text on Enter and clears the input', async () => {
    const onSubmit = vi.fn();
    render(<CommandBar onSubmit={onSubmit} ensureSession={noopEnsure} />);
    const input = screen.getByPlaceholderText(/ask otto/i) as HTMLInputElement;
    await userEvent.type(input, '  hello  {Enter}');
    expect(onSubmit).toHaveBeenCalledWith({ text: 'hello', attachments: [] });
    expect(input.value).toBe('');
  });

  it('does not submit empty input', async () => {
    const onSubmit = vi.fn();
    render(<CommandBar onSubmit={onSubmit} ensureSession={noopEnsure} />);
    const input = screen.getByPlaceholderText(/ask otto/i);
    await userEvent.type(input, '{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('fires onNewConversation immediately when input value becomes "/n "', async () => {
    const onSubmit = vi.fn();
    const onNewConversation = vi.fn();
    render(
      <CommandBar
        onSubmit={onSubmit}
        ensureSession={noopEnsure}
        onNewConversation={onNewConversation}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await userEvent.type(input, '/n ');
    expect(onNewConversation).toHaveBeenCalledWith({ text: '', attachments: [] });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });

  it('fires onPrivateConversation immediately when input value becomes "/p "', async () => {
    const onSubmit = vi.fn();
    const onPrivateConversation = vi.fn();
    render(
      <CommandBar
        onSubmit={onSubmit}
        ensureSession={noopEnsure}
        onPrivateConversation={onPrivateConversation}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await userEvent.type(input, '/p ');
    expect(onPrivateConversation).toHaveBeenCalledWith({ text: '', attachments: [] });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });

  it('routes a "/p text" submit to onPrivateConversation with the remainder', () => {
    // Set the whole value at once (as paste / programmatic set does) so it
    // bypasses the char-by-char path where "/p " momentarily matches the prefix
    // and fires the immediate-private branch. This exercises handleSubmit's
    // parsePrivateConversationPrefix routing directly.
    const onSubmit = vi.fn();
    const onPrivateConversation = vi.fn();
    render(
      <CommandBar
        onSubmit={onSubmit}
        ensureSession={noopEnsure}
        onPrivateConversation={onPrivateConversation}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '/p hush hush' } });
    fireEvent.submit(document.querySelector('form')!);
    expect(onPrivateConversation).toHaveBeenCalledWith({ text: 'hush hush', attachments: [] });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });

  it('shows the private indicator when isPrivate is set', () => {
    render(<CommandBar onSubmit={() => {}} ensureSession={noopEnsure} isPrivate />);
    expect(screen.getByTestId('private-indicator')).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/private/i)).toBeInTheDocument();
  });

  it('hides the private indicator by default', () => {
    render(<CommandBar onSubmit={() => {}} ensureSession={noopEnsure} />);
    expect(screen.queryByTestId('private-indicator')).toBeNull();
  });

  it('submits with attachments when only an image is staged via paste', async () => {
    const onSubmit = vi.fn();
    const mockRef = {
      type: 'image-ref' as const,
      id: 'r1',
      sessionId: 's1',
      path: '/tmp/r1.png',
      width: 10,
      height: 10,
      mimeType: 'image/png' as const,
      source: 'user' as const,
    };
    (window as unknown as { otto: { invoke: ReturnType<typeof vi.fn> } }).otto = {
      invoke: vi.fn().mockResolvedValue(mockRef),
    };

    render(<CommandBar onSubmit={onSubmit} ensureSession={noopEnsure} />);

    // jsdom's File doesn't implement arrayBuffer — stub it directly
    const bytes = new Uint8Array([0]);
    const file = new File([bytes], 'a.png', { type: 'image/png' });
    (file as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = () =>
      Promise.resolve(bytes.buffer);

    const form = document.querySelector('form')!;

    await act(async () => {
      fireEvent.paste(form, {
        clipboardData: {
          items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }],
        },
      });
      // Let the stageFile async chain resolve (ensureSession + arrayBuffer + invoke)
      await new Promise((r) => setTimeout(r, 50));
    });

    // Verify no submit happened yet
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.submit(form);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        text: '',
        attachments: [expect.objectContaining({ id: 'r1' })],
      });
    });
  });

  describe('type-to-focus', () => {
    it('focuses the input when a plain printable key is pressed while focus is elsewhere', () => {
      render(<CommandBar onSubmit={() => {}} ensureSession={noopEnsure} autoFocus={false} />);
      const input = screen.getByRole('textbox') as HTMLInputElement;
      (document.activeElement as HTMLElement | null)?.blur?.();
      expect(document.activeElement).not.toBe(input);

      fireEvent.keyDown(window, { key: 'a' });

      expect(document.activeElement).toBe(input);
    });

    it('ignores modifier-key chords so shortcuts are not hijacked', () => {
      render(<CommandBar onSubmit={() => {}} ensureSession={noopEnsure} autoFocus={false} />);
      const input = screen.getByRole('textbox') as HTMLInputElement;
      (document.activeElement as HTMLElement | null)?.blur?.();

      fireEvent.keyDown(window, { key: 'k', metaKey: true });
      expect(document.activeElement).not.toBe(input);

      fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
      expect(document.activeElement).not.toBe(input);
    });

    it('ignores non-printable keys', () => {
      render(<CommandBar onSubmit={() => {}} ensureSession={noopEnsure} autoFocus={false} />);
      const input = screen.getByRole('textbox') as HTMLInputElement;
      (document.activeElement as HTMLElement | null)?.blur?.();

      fireEvent.keyDown(window, { key: 'ArrowDown' });
      expect(document.activeElement).not.toBe(input);
    });
  });
});
