import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { JsonTreeCard } from './JsonTreeCard';

describe('JsonTreeCard', () => {
  it('renders top-level keys', () => {
    render(<JsonTreeCard view={{ kind: 'tree', value: { a: 1, b: 'x' } }} />);
    expect(screen.getByText('"a"')).toBeInTheDocument();
    expect(screen.getByText('"b"')).toBeInTheDocument();
  });
  it('expands nested objects on click', () => {
    render(<JsonTreeCard view={{ kind: 'tree', value: { outer: { inner: 7 } } }} />);
    expect(screen.queryByText('"inner"')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('"outer"'));
    expect(screen.getByText('"inner"')).toBeInTheDocument();
  });
});
