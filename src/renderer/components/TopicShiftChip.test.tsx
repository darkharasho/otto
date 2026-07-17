import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TopicShiftChip } from './TopicShiftChip';

describe('TopicShiftChip', () => {
  it('renders the suggestion text and both action buttons', () => {
    render(<TopicShiftChip onStartNew={() => {}} onKeepGoing={() => {}} />);
    expect(screen.getByText(/new topic/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start new/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /keep going/i })).toBeInTheDocument();
  });

  it('calls onStartNew when the Start new button is clicked', async () => {
    const onStartNew = vi.fn();
    const onKeepGoing = vi.fn();
    render(<TopicShiftChip onStartNew={onStartNew} onKeepGoing={onKeepGoing} />);
    await userEvent.click(screen.getByRole('button', { name: /start new/i }));
    expect(onStartNew).toHaveBeenCalledTimes(1);
    expect(onKeepGoing).not.toHaveBeenCalled();
  });

  it('calls onKeepGoing when the Keep going button is clicked', async () => {
    const onStartNew = vi.fn();
    const onKeepGoing = vi.fn();
    render(<TopicShiftChip onStartNew={onStartNew} onKeepGoing={onKeepGoing} />);
    await userEvent.click(screen.getByRole('button', { name: /keep going/i }));
    expect(onKeepGoing).toHaveBeenCalledTimes(1);
    expect(onStartNew).not.toHaveBeenCalled();
  });

  it('calls onKeepGoing when Escape is pressed', () => {
    const onStartNew = vi.fn();
    const onKeepGoing = vi.fn();
    render(<TopicShiftChip onStartNew={onStartNew} onKeepGoing={onKeepGoing} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onKeepGoing).toHaveBeenCalledTimes(1);
    expect(onStartNew).not.toHaveBeenCalled();
  });

  it('focuses the Keep going button by default so a stray Enter is safe', () => {
    render(<TopicShiftChip onStartNew={() => {}} onKeepGoing={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /keep going/i }));
  });

  it('moves focus with Left/Right arrows', () => {
    render(<TopicShiftChip onStartNew={() => {}} onKeepGoing={() => {}} />);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /start new/i }));
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /keep going/i }));
  });

  it('activates the focused button with Enter', async () => {
    const onStartNew = vi.fn();
    const onKeepGoing = vi.fn();
    render(<TopicShiftChip onStartNew={onStartNew} onKeepGoing={onKeepGoing} />);
    // Move focus to Start new, then Enter should activate it natively.
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await userEvent.keyboard('{Enter}');
    expect(onStartNew).toHaveBeenCalledTimes(1);
    expect(onKeepGoing).not.toHaveBeenCalled();
  });

  it('starts a new conversation on Cmd/Ctrl+Enter regardless of focus', () => {
    const onStartNew = vi.fn();
    const onKeepGoing = vi.fn();
    render(<TopicShiftChip onStartNew={onStartNew} onKeepGoing={onKeepGoing} />);
    // Focus is on Keep going, but the chord overrides.
    fireEvent.keyDown(window, { key: 'Enter', metaKey: true });
    expect(onStartNew).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true });
    expect(onStartNew).toHaveBeenCalledTimes(2);
    expect(onKeepGoing).not.toHaveBeenCalled();
  });
});
