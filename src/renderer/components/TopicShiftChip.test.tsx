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
});
