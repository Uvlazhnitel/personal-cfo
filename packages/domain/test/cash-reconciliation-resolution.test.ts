import { describe, expect, it } from 'vitest';

import {
  createCashReconciliationResolution,
  parseCashReconciliationId,
  parseInstant,
  parseTransactionId,
} from '../src/index.js';

const RECONCILIATION_ID = parseCashReconciliationId('01890f3e-7b2c-7001-8abc-000000000001');
const TRANSACTION_ID = parseTransactionId('01890f3e-7b2c-7002-8abc-000000000002');

describe('cash-reconciliation resolution fact', () => {
  it('retains immutable resolution provenance', () => {
    const resolution = createCashReconciliationResolution({
      reconciliationId: RECONCILIATION_ID,
      resolvedAt: parseInstant('2026-09-14T08:00:00Z'),
      resolutionTransactionId: TRANSACTION_ID,
    });
    expect(resolution).toEqual({
      reconciliationId: RECONCILIATION_ID,
      resolvedAt: '2026-09-14T08:00:00Z',
      resolutionTransactionId: TRANSACTION_ID,
    });
    expect(Object.isFrozen(resolution)).toBe(true);
  });
});
