import { EUR } from './currency.js';
import type { FxRateId } from './domain-id.js';
import { parseFxRateId } from './domain-id.js';
import { DomainValidationError } from './errors.js';
import type { Money } from './money.js';
import { createMoney, moneySign } from './money.js';

export type AvailableReportableAmount = Readonly<{
  status: 'available';
  original: Money;
  reporting: Money;
  fxRateId: FxRateId | null;
}>;

export type MissingFxReportableAmount = Readonly<{
  status: 'missing_fx';
  original: Money;
  reporting: null;
  fxRateId: null;
}>;

export type ReportableAmount = AvailableReportableAmount | MissingFxReportableAmount;

export function createNativeReportableAmount(amount: Money): AvailableReportableAmount {
  const original = createMoney(amount.amountMinor, amount.currency);

  if (original.currency !== EUR) {
    throw new DomainValidationError(
      'reportable_amount.non_eur_native',
      'Only EUR can be used without an FX conversion.',
    );
  }

  return Object.freeze({ status: 'available', original, reporting: original, fxRateId: null });
}

export function createConvertedReportableAmount(
  originalAmount: Money,
  reportingAmount: Money,
  fxRateId: FxRateId,
): AvailableReportableAmount {
  const original = createMoney(originalAmount.amountMinor, originalAmount.currency);
  const reporting = createMoney(reportingAmount.amountMinor, reportingAmount.currency);

  if (original.currency === EUR || reporting.currency !== EUR) {
    throw new DomainValidationError(
      'reportable_amount.invalid_conversion',
      'An FX conversion must convert a non-EUR original amount into EUR.',
    );
  }

  if (moneySign(original) !== moneySign(reporting)) {
    throw new DomainValidationError(
      'reportable_amount.invalid_conversion_sign',
      'An FX conversion must preserve the sign of the original amount.',
    );
  }

  return Object.freeze({
    status: 'available',
    original,
    reporting,
    fxRateId: parseFxRateId(fxRateId),
  });
}

export function createMissingFxReportableAmount(originalAmount: Money): MissingFxReportableAmount {
  const original = createMoney(originalAmount.amountMinor, originalAmount.currency);

  if (original.currency === EUR) {
    throw new DomainValidationError(
      'reportable_amount.eur_missing_fx',
      'EUR amounts do not require an FX conversion.',
    );
  }

  return Object.freeze({ status: 'missing_fx', original, reporting: null, fxRateId: null });
}

export function createReportableAmount(amount: ReportableAmount): ReportableAmount {
  if (amount.status === 'missing_fx') {
    return createMissingFxReportableAmount(amount.original);
  }

  if (amount.fxRateId === null) {
    if (
      amount.original.currency !== amount.reporting.currency ||
      amount.original.amountMinor !== amount.reporting.amountMinor
    ) {
      throw new DomainValidationError(
        'reportable_amount.native_mismatch',
        'A native reporting amount must exactly equal its original amount.',
      );
    }
    return createNativeReportableAmount(amount.original);
  }

  return createConvertedReportableAmount(amount.original, amount.reporting, amount.fxRateId);
}
