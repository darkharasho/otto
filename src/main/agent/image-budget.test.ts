import { describe, it, expect, beforeEach } from 'vitest';
import {
  IMAGE_BUDGET,
  noteImagesSent,
  imagesSent,
  overImageBudget,
  clearImageBudget,
} from './image-budget';

beforeEach(() => {
  clearImageBudget('s1');
  clearImageBudget('s2');
});

describe('image budget', () => {
  it('accumulates per session independently', () => {
    noteImagesSent('s1', 3);
    noteImagesSent('s1', 2);
    noteImagesSent('s2', 1);
    expect(imagesSent('s1')).toBe(5);
    expect(imagesSent('s2')).toBe(1);
  });

  it('trips at the budget, not before', () => {
    noteImagesSent('s1', IMAGE_BUDGET - 1);
    expect(overImageBudget('s1')).toBe(false);
    noteImagesSent('s1', 1);
    expect(overImageBudget('s1')).toBe(true);
  });

  it('ignores non-positive counts and clears on demand', () => {
    noteImagesSent('s1', 0);
    noteImagesSent('s1', -5);
    expect(imagesSent('s1')).toBe(0);
    noteImagesSent('s1', IMAGE_BUDGET);
    clearImageBudget('s1');
    expect(overImageBudget('s1')).toBe(false);
  });
});
