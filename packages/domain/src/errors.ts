export class DomainValidationError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DomainValidationError';
  }
}

export class CurrencyMismatchError extends Error {
  public constructor(
    public readonly leftCurrency: string,
    public readonly rightCurrency: string,
  ) {
    super(`Currency mismatch: ${leftCurrency} and ${rightCurrency}`);
    this.name = 'CurrencyMismatchError';
  }
}

export class MoneyOverflowError extends DomainValidationError {
  public constructor() {
    super('money.out_of_range', 'Money minor units must fit in a signed PostgreSQL BIGINT.');
    this.name = 'MoneyOverflowError';
  }
}
