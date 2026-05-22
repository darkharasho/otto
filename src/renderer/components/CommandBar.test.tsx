import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommandBar } from './CommandBar';

describe('CommandBar', () => {
  it('renders an input with a placeholder', () => {
    render(<CommandBar onSubmit={() => {}} />);
    expect(screen.getByPlaceholderText(/ask otto/i)).toBeInTheDocument();
  });

  it('calls onSubmit with trimmed text on Enter and clears the input', async () => {
    const onSubmit = vi.fn();
    render(<CommandBar onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText(/ask otto/i) as HTMLInputElement;
    await userEvent.type(input, '  hello  {Enter}');
    expect(onSubmit).toHaveBeenCalledWith('hello');
    expect(input.value).toBe('');
  });

  it('does not submit empty input', async () => {
    const onSubmit = vi.fn();
    render(<CommandBar onSubmit={onSubmit} />);
    const input = screen.getByPlaceholderText(/ask otto/i);
    await userEvent.type(input, '{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
