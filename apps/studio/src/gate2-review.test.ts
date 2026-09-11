import { describe, expect, it } from 'vitest';
import { measuredViewport, pendingFindingIds } from './gate2-review.js';

/**
 * The A/B view may only open at a width the evidence measured. A run whose
 * stage captured a subset — a single narrow width, say — must not open at the
 * wide default nobody looked at.
 */
describe('measured viewport', () => {
  it('opens at a measured width when the declared default was never captured', () => {
    expect(measuredViewport([768], null)).toBe(768);
  });

  it('keeps the width the captain chose while the evidence still holds it', () => {
    expect(measuredViewport([390, 768, 1440], 390)).toBe(390);
  });

  it('leaves a width that stopped being measured for the widest one that is', () => {
    expect(measuredViewport([390, 768], 1440)).toBe(768);
  });

  it('offers no width at all when the run measured none', () => {
    expect(measuredViewport([], 1440)).toBeNull();
  });
});

describe('pending findings', () => {
  const issues = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('names every finding the captain has not decided', () => {
    expect(pendingFindingIds(issues, [{ findingId: 'b' }])).toEqual(['a', 'c']);
  });

  it('is empty once the whole set is decided', () => {
    expect(pendingFindingIds(issues, issues.map((issue) => ({ findingId: issue.id })))).toEqual([]);
  });

  it('is empty when the critics found nothing to repair', () => {
    expect(pendingFindingIds([], [])).toEqual([]);
  });
});
