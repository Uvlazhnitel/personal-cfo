import { randomBytes } from 'node:crypto';

import { parseDomainId } from '@personal-cfo/domain';
import type { DomainId } from '@personal-cfo/domain';

export type UuidV7Source = Readonly<{
  nowMilliseconds: () => number;
  randomBytes: (size: number) => Uint8Array;
}>;

const defaultSource: UuidV7Source = Object.freeze({
  nowMilliseconds: () => Date.now(),
  randomBytes: (size) => randomBytes(size),
});

export function generateUuidV7<Entity extends string>(
  entity: Entity,
  source: UuidV7Source = defaultSource,
): DomainId<Entity> {
  const timestamp = source.nowMilliseconds();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffffffffffff) {
    throw new RangeError('UUIDv7 timestamp must be a non-negative 48-bit integer.');
  }
  const bytes = Uint8Array.from(source.randomBytes(16));
  if (bytes.length !== 16) throw new RangeError('UUIDv7 entropy source must return 16 bytes.');
  let remaining = BigInt(timestamp);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((item) => item.toString(16).padStart(2, '0')).join('');
  return parseDomainId(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    entity,
  );
}
