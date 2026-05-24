import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NotificationsSection } from './NotificationsSection';

describe('NotificationsSection', () => {
  it('toggling one notification calls onChange with only that key', () => {
    const onChange = vi.fn();
    render(
      <NotificationsSection
        notifications={{ turnComplete: false, approval: true, sound: true }}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByLabelText(/when otto finishes responding/i));
    expect(onChange).toHaveBeenCalledWith({ turnComplete: true });
  });
});
