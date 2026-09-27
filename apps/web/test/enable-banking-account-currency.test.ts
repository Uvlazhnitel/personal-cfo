import { describe, expect, it } from 'vitest';

import { resolveEnableBankingAccountCurrency } from '../src/server/enable-banking.js';

describe('Enable Banking account currency evidence', () => {
  it('uses unanimous EUR balance evidence when Swedbank reports account currency XXX', () => {
    expect(resolveEnableBankingAccountCurrency('XXX', ['EUR', 'EUR'])).toBe('EUR');
  });

  it.each([
    ['XXX', []],
    ['XXX', ['EUR', 'USD']],
    ['XXX', ['USD']],
    ['USD', ['EUR']],
  ])('does not override ambiguous or known account currency %s from %j', (account, balances) => {
    expect(resolveEnableBankingAccountCurrency(account, balances)).toBe(account);
  });
});
