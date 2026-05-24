import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SessionHistorySection } from './SessionHistorySection';

describe('SessionHistorySection', () => {
  it('renders the auto-delete number and reveals confirm on danger click', () => {
    const onReset = vi.fn().mockResolvedValue(undefined);
    render(
      <SessionHistorySection
        autoDeleteDays={30}
        onAutoDeleteDaysChange={() => {}}
        onResetAllSessions={onReset}
      />
    );
    fireEvent.click(screen.getByText(/delete all sessions/i));
    expect(screen.getByText(/permanently delete every saved session/i)).toBeTruthy();
  });
});
