import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AboutSection } from './AboutSection';

describe('AboutSection', () => {
  it('renders the version string and fires onOpenLogs on click', () => {
    const onOpenLogs = vi.fn();
    render(<AboutSection version="0.2.5" onOpenLogs={onOpenLogs} />);
    expect(screen.getByText(/0\.2\.5/)).toBeTruthy();
    fireEvent.click(screen.getByText(/open logs folder/i));
    expect(onOpenLogs).toHaveBeenCalled();
  });
});
