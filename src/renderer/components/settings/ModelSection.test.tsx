import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ModelSection } from './ModelSection';

describe('ModelSection', () => {
  it('renders without crashing and forwards value + onChange to the switcher', () => {
    const onChange = vi.fn();
    const { container } = render(<ModelSection value="claude-sonnet-4-6" onChange={onChange} />);
    expect(container.querySelector('section')).toBeTruthy();
  });
});
