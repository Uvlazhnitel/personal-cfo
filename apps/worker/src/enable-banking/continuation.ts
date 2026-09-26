import { DataInvariantError } from '@personal-cfo/data';

export type EnableBankingContinuationState = Readonly<{
  cursorHash: string | null;
  emptyObservations: number;
}>;

export const INITIAL_ENABLE_BANKING_CONTINUATION_STATE: EnableBankingContinuationState =
  Object.freeze({ cursorHash: null, emptyObservations: 0 });

export function assessEnableBankingContinuation(
  state: EnableBankingContinuationState,
  input: Readonly<{
    requestCursorHash: string | null;
    responseCursorHash: string | null;
    transactionCount: number;
  }>,
): Readonly<{
  state: EnableBankingContinuationState;
  waitMilliseconds: number;
}> {
  if (input.responseCursorHash === null) {
    return Object.freeze({
      state: INITIAL_ENABLE_BANKING_CONTINUATION_STATE,
      waitMilliseconds: 0,
    });
  }
  const repeatsRequest = input.responseCursorHash === input.requestCursorHash;
  if (repeatsRequest && input.transactionCount > 0) {
    throw new DataInvariantError(
      'enable_banking.non_advancing_continuation',
      'Enable Banking continuation key repeated with transaction data.',
    );
  }
  if (input.transactionCount > 0) {
    return Object.freeze({
      state: Object.freeze({ cursorHash: input.responseCursorHash, emptyObservations: 0 }),
      waitMilliseconds: 0,
    });
  }
  const emptyObservations =
    state.cursorHash === input.responseCursorHash ? state.emptyObservations + 1 : 1;
  if (repeatsRequest && emptyObservations >= 3) {
    throw new DataInvariantError(
      'enable_banking.non_advancing_continuation',
      'Enable Banking empty continuation key did not advance after bounded polling.',
    );
  }
  return Object.freeze({
    state: Object.freeze({ cursorHash: input.responseCursorHash, emptyObservations }),
    waitMilliseconds: emptyObservations === 1 ? 1_000 : 2_000,
  });
}
