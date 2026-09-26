import { describe, expect, it } from 'vitest';

import {
  INITIAL_ENABLE_BANKING_CONTINUATION_STATE,
  assessEnableBankingContinuation,
} from '../src/enable-banking/continuation.js';

describe('Enable Banking continuation polling', () => {
  it('bounds repeated empty continuation polling and resets when the cursor advances', () => {
    const first = assessEnableBankingContinuation(INITIAL_ENABLE_BANKING_CONTINUATION_STATE, {
      requestCursorHash: null,
      responseCursorHash: 'cursor-one',
      transactionCount: 0,
    });
    expect(first.waitMilliseconds).toBe(1_000);
    const second = assessEnableBankingContinuation(first.state, {
      requestCursorHash: 'cursor-one',
      responseCursorHash: 'cursor-one',
      transactionCount: 0,
    });
    expect(second.waitMilliseconds).toBe(2_000);
    expect(() =>
      assessEnableBankingContinuation(second.state, {
        requestCursorHash: 'cursor-one',
        responseCursorHash: 'cursor-one',
        transactionCount: 0,
      }),
    ).toThrow('bounded polling');

    const advanced = assessEnableBankingContinuation(second.state, {
      requestCursorHash: 'cursor-one',
      responseCursorHash: 'cursor-two',
      transactionCount: 0,
    });
    expect(advanced).toMatchObject({ waitMilliseconds: 1_000 });
    expect(advanced.state).toEqual({ cursorHash: 'cursor-two', emptyObservations: 1 });
  });

  it('rejects a repeated cursor carrying transactions', () => {
    expect(() =>
      assessEnableBankingContinuation(INITIAL_ENABLE_BANKING_CONTINUATION_STATE, {
        requestCursorHash: 'cursor-one',
        responseCursorHash: 'cursor-one',
        transactionCount: 1,
      }),
    ).toThrow('repeated with transaction data');
  });
});
