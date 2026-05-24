import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StartupSection } from './StartupSection';

describe('StartupSection', () => {
  it('calls onChange when the toggle is clicked', () => {
    const onChange = vi.fn();
    render(<StartupSection startAtLogin={false} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText(/start at login/i));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
