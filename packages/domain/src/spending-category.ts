import type { SpendingCategoryId } from './domain-id.js';
import { parseSpendingCategoryId } from './domain-id.js';
import type { SpendingNecessity } from './spending.js';

export const STANDARD_SPENDING_CATEGORY_CODES = [
  'housing',
  'groceries',
  'restaurants',
  'delivery',
  'transport',
  'taxi',
  'subscriptions',
  'sport',
  'health',
  'entertainment',
  'shopping',
  'travel',
  'education',
  'other',
] as const;

export type StandardSpendingCategoryCode = (typeof STANDARD_SPENDING_CATEGORY_CODES)[number];

export type StandardSpendingCategory = Readonly<{
  id: SpendingCategoryId;
  code: StandardSpendingCategoryCode;
  necessity: SpendingNecessity;
}>;

// The IDs used by the Stage 3/4 fixture remain stable for overlapping categories.
const category = (
  code: StandardSpendingCategoryCode,
  fixtureIndex: number,
  necessity: SpendingNecessity,
): StandardSpendingCategory =>
  Object.freeze({
    id: parseSpendingCategoryId(
      `018f0000-0000-7000-8000-${(400_000 + fixtureIndex).toString(16).padStart(12, '0')}`,
    ),
    code,
    necessity,
  });

export const STANDARD_SPENDING_CATEGORIES: Readonly<
  Record<StandardSpendingCategoryCode, StandardSpendingCategory>
> = Object.freeze({
  housing: category('housing', 1, 'essential'),
  groceries: category('groceries', 6, 'essential'),
  restaurants: category('restaurants', 7, 'discretionary'),
  delivery: category('delivery', 13, 'discretionary'),
  transport: category('transport', 4, 'essential'),
  taxi: category('taxi', 14, 'discretionary'),
  subscriptions: category('subscriptions', 5, 'discretionary'),
  sport: category('sport', 15, 'discretionary'),
  health: category('health', 16, 'essential'),
  entertainment: category('entertainment', 17, 'discretionary'),
  shopping: category('shopping', 18, 'discretionary'),
  travel: category('travel', 11, 'discretionary'),
  education: category('education', 19, 'essential'),
  other: category('other', 20, 'discretionary'),
});
