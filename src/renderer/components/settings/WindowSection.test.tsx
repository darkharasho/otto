import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WindowSection } from './WindowSection';

describe('WindowSection', () => {
  it('calls onPositionChange when a new position radio is clicked', () => {
    const onPositionChange = vi.fn();
    render(
      <WindowSection
        windowPosition="bottom-center"
        hideOnBlur={true}
        onPositionChange={onPositionChange}
        onHideOnBlurChange={() => {}}
      />
    );
    fireEvent.click(screen.getByText(/top center/i));
    expect(onPositionChange).toHaveBeenCalledWith('top-center');
  });

  it('calls onHideOnBlurChange when the hide-on-blur toggle is clicked', () => {
    const onHideOnBlurChange = vi.fn();
    render(
      <WindowSection
        windowPosition="bottom-center"
        hideOnBlur={false}
        onPositionChange={() => {}}
        onHideOnBlurChange={onHideOnBlurChange}
      />
    );
    fireEvent.click(screen.getByLabelText(/hide when clicked away/i));
    expect(onHideOnBlurChange).toHaveBeenCalledWith(true);
  });
});
