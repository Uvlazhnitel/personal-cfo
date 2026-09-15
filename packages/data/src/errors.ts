export class DataInvariantError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DataInvariantError';
    this.code = code;
  }
}

export class DataConflictError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'DataConflictError';
    this.code = code;
  }
}
