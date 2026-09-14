import { Decimal } from 'decimal.js';

import type { DecimalRate } from '@personal-cfo/domain';

import { FinancialEngineInvariantError } from './errors.js';

export const FORECAST_DECIMAL_PRECISION = 64;

const ForecastDecimal = Decimal.clone({
  precision: FORECAST_DECIMAL_PRECISION,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -1_000,
  toExpPos: 1_000,
});

export function validateAnnualRate(rate: DecimalRate, allowNegative = false): void {
  const value = new ForecastDecimal(rate);
  if (!value.isFinite() || value.lte('-1') || (!allowNegative && value.isNegative())) {
    throw new FinancialEngineInvariantError(
      'forecast.invalid_annual_rate',
      'Forecast annual rates must be finite, above -100%, and non-negative for V1 scenarios.',
    );
  }
}

export function annualToMonthlyFactor(rate: DecimalRate): string {
  validateAnnualRate(rate);
  if (rate === '0') return '0';
  return new ForecastDecimal('1')
    .plus(rate)
    .pow(new ForecastDecimal('1').div('12'))
    .minus('1')
    .toString();
}

export function compareDecimalRates(left: DecimalRate, right: DecimalRate): number {
  return new ForecastDecimal(left).comparedTo(new ForecastDecimal(right));
}

export function multiplyDecimalHalfEven(amountMinor: bigint, factor: string): bigint {
  return BigInt(
    new ForecastDecimal(amountMinor.toString())
      .times(factor)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN)
      .toFixed(0),
  );
}

export function realValueHalfEven(
  nominalMinor: bigint,
  monthlyInflationFactor: string,
  elapsedMonths: number,
): bigint {
  if (monthlyInflationFactor === '0') return nominalMinor;
  const priceIndex = new ForecastDecimal('1')
    .plus(monthlyInflationFactor)
    .pow(elapsedMonths.toString());
  return BigInt(
    new ForecastDecimal(nominalMinor.toString())
      .div(priceIndex)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN)
      .toFixed(0),
  );
}
