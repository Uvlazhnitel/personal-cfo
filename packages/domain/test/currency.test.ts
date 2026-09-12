import { describe, expect, it } from 'vitest';

import { EUR, currencyScaleFor, parseCurrencyCode, serializeCurrencyCode } from '../src/index.js';

describe('CurrencyCode', () => {
  it('supports EUR as the reporting currency with two minor digits', () => {
    expect(EUR).toBe('EUR');
    expect(currencyScaleFor(EUR)).toBe(2);
  });

  it('accepts other canonical uppercase three-letter codes without assuming a scale', () => {
    const usd = parseCurrencyCode('USD');

    expect(serializeCurrencyCode(usd)).toBe('USD');
    expect(currencyScaleFor(usd)).toBeUndefined();
  });

  it.each(['', 'eur', 'EU', 'EURO', 'E1R', ' EUR'])('rejects invalid code %j', (value) => {
    expect(() => parseCurrencyCode(value)).toThrowError();
  });
});
