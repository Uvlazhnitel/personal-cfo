import type { Instant } from './instant.js';

export interface Clock {
  now(): Instant;
}
