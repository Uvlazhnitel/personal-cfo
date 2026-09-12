import { parseStringEnum } from './validation.js';

export const BOOKING_STATUSES = ['pending', 'booked', 'reversed'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export function parseBookingStatus(value: unknown): BookingStatus {
  return parseStringEnum(value, BOOKING_STATUSES, 'BookingStatus');
}
