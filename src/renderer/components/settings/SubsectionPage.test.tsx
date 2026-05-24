import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SubsectionPage } from './SubsectionPage';

describe('SubsectionPage', () => {
  it('always renders the title as a heading', () => {
    render(
      <SubsectionPage title="Notifications">
        <div>body</div>
      </SubsectionPage>
    );
    expect(screen.getByRole('heading', { name: 'Notifications' })).toBeTruthy();
  });

  it('renders the description when provided', () => {
    render(
      <SubsectionPage title="Notifications" description="When Otto alerts you.">
        <div />
      </SubsectionPage>
    );
    expect(screen.getByText('When Otto alerts you.')).toBeTruthy();
  });

  it('does NOT render a description node when omitted', () => {
    const { container } = render(
      <SubsectionPage title="Notifications">
        <div />
      </SubsectionPage>
    );
    expect(container.querySelector('p')).toBeNull();
  });

  it('renders children', () => {
    render(
      <SubsectionPage title="Notifications">
        <div>body content</div>
      </SubsectionPage>
    );
    expect(screen.getByText('body content')).toBeTruthy();
  });
});
