import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettingsShell } from './SettingsShell';

const SIDEBAR = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
];

describe('SettingsShell', () => {
  it('renders all top tabs and the provided sidebar entries', () => {
    render(
      <SettingsShell
        activeTab="general"
        onTabChange={() => {}}
        sidebar={SIDEBAR}
        activeSub="a"
        onSubChange={() => {}}
      >
        <div>content</div>
      </SettingsShell>
    );
    for (const label of ['General', 'Behavior', 'Memory', 'About']) {
      expect(screen.getByRole('tab', { name: label })).toBeTruthy();
    }
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Beta' })).toBeTruthy();
    expect(screen.getByText('content')).toBeTruthy();
  });

  it('marks the active tab via aria-selected', () => {
    render(
      <SettingsShell
        activeTab="behavior"
        onTabChange={() => {}}
        sidebar={SIDEBAR}
        activeSub="a"
        onSubChange={() => {}}
      >
        <div />
      </SettingsShell>
    );
    expect(screen.getByRole('tab', { name: 'Behavior' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'General' }).getAttribute('aria-selected')).toBe('false');
  });

  it('marks the active sidebar entry via aria-current', () => {
    render(
      <SettingsShell
        activeTab="general"
        onTabChange={() => {}}
        sidebar={SIDEBAR}
        activeSub="b"
        onSubChange={() => {}}
      >
        <div />
      </SettingsShell>
    );
    expect(screen.getByRole('button', { name: 'Beta' }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('button', { name: 'Alpha' }).getAttribute('aria-current')).toBe('false');
  });

  it('clicking a tab fires onTabChange with the new tab id', () => {
    const onTabChange = vi.fn();
    render(
      <SettingsShell
        activeTab="general"
        onTabChange={onTabChange}
        sidebar={SIDEBAR}
        activeSub="a"
        onSubChange={() => {}}
      >
        <div />
      </SettingsShell>
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Memory' }));
    expect(onTabChange).toHaveBeenCalledWith('memory');
  });

  it('clicking a sidebar entry fires onSubChange with the new sub id', () => {
    const onSubChange = vi.fn();
    render(
      <SettingsShell
        activeTab="general"
        onTabChange={() => {}}
        sidebar={SIDEBAR}
        activeSub="a"
        onSubChange={onSubChange}
      >
        <div />
      </SettingsShell>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Beta' }));
    expect(onSubChange).toHaveBeenCalledWith('b');
  });
});
