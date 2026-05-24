import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AutonomySection } from './AutonomySection';

describe('AutonomySection', () => {
  it('calls onChange when a new mode is selected', () => {
    const onChange = vi.fn();
    render(<AutonomySection mode="balanced" onChange={onChange} />);
    fireEvent.click(screen.getByText(/^strict$/i));
    expect(onChange).toHaveBeenCalledWith('strict');
  });
});
