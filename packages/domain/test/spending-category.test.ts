import { describe, expect, it } from 'vitest';

import { STANDARD_SPENDING_CATEGORIES, STANDARD_SPENDING_CATEGORY_CODES } from '../src/index.js';

describe('standard spending categories', () => {
  it('covers the FRD taxonomy with unique stable IDs', () => {
    expect(Object.keys(STANDARD_SPENDING_CATEGORIES)).toEqual(STANDARD_SPENDING_CATEGORY_CODES);
    expect(
      new Set(Object.values(STANDARD_SPENDING_CATEGORIES).map((category) => category.id)).size,
    ).toBe(STANDARD_SPENDING_CATEGORY_CODES.length);
  });

  it('preserves Stage 4 fixture IDs for equivalent categories', () => {
    expect(STANDARD_SPENDING_CATEGORIES.housing.id).toBe('018f0000-0000-7000-8000-000000061a81');
    expect(STANDARD_SPENDING_CATEGORIES.transport.id).toBe('018f0000-0000-7000-8000-000000061a84');
    expect(STANDARD_SPENDING_CATEGORIES.groceries.id).toBe('018f0000-0000-7000-8000-000000061a86');
    expect(STANDARD_SPENDING_CATEGORIES.restaurants.id).toBe(
      '018f0000-0000-7000-8000-000000061a87',
    );
    expect(STANDARD_SPENDING_CATEGORIES.travel.id).toBe('018f0000-0000-7000-8000-000000061a8b');
  });
});
