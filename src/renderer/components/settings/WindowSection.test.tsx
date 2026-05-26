import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WindowSection } from './WindowSection';

describe('WindowSection', () => {
  it('calls onPositionChange when a new position radio is clicked', () => {
    const onPositionChange = vi.fn();
    render(
      <WindowSection
        windowPosition="bottom-center"
        displayTarget="cursor"
        hideOnBlur={true}
        onPositionChange={onPositionChange}
        onDisplayTargetChange={() => {}}
        onHideOnBlurChange={() => {}}
      />
    );
    fireEvent.click(screen.getByText(/top center/i));
    expect(onPositionChange).toHaveBeenCalledWith('top-center');
  });

  it('calls onDisplayTargetChange when a new display radio is clicked', () => {
    const onDisplayTargetChange = vi.fn();
    render(
      <WindowSection
        windowPosition="bottom-center"
        displayTarget="cursor"
        hideOnBlur={false}
        onPositionChange={() => {}}
        onDisplayTargetChange={onDisplayTargetChange}
        onHideOnBlurChange={() => {}}
      />
    );
    fireEvent.click(screen.getByText(/primary display/i));
    expect(onDisplayTargetChange).toHaveBeenCalledWith('primary');
  });

  it('calls onHideOnBlurChange when the hide-on-blur toggle is clicked', () => {
    const onHideOnBlurChange = vi.fn();
    render(
      <WindowSection
        windowPosition="bottom-center"
        displayTarget="cursor"
        hideOnBlur={false}
        onPositionChange={() => {}}
        onDisplayTargetChange={() => {}}
        onHideOnBlurChange={onHideOnBlurChange}
      />
    );
    fireEvent.click(screen.getByLabelText(/hide when clicked away/i));
    expect(onHideOnBlurChange).toHaveBeenCalledWith(true);
  });
});
