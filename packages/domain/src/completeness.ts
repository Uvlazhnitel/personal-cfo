import { parseStringEnum } from './validation.js';

export const COMPLETENESS_STATUSES = ['complete', 'partial', 'unavailable'] as const;
export type Completeness = (typeof COMPLETENESS_STATUSES)[number];

export function parseCompleteness(value: unknown): Completeness {
  return parseStringEnum(value, COMPLETENESS_STATUSES, 'Completeness');
}
