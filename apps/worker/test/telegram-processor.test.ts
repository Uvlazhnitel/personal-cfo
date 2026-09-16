import { describe, expect, it } from 'vitest';

import { DataConflictError, DataInvariantError } from '@personal-cfo/data';

import { classifyTelegramProcessingFailure } from '../src/telegram/processor.js';

describe('Telegram processing failure classification', () => {
  it('keeps deterministic data failures terminal', () => {
    expect(
      classifyTelegramProcessingFailure(
        new DataInvariantError('cash_account.not_unique', 'Ambiguous cash account.'),
      ),
    ).toEqual({ kind: 'terminal', category: 'cash_account.not_unique' });
    expect(
      classifyTelegramProcessingFailure(
        new DataConflictError('command.payload_conflict', 'Conflicting command.'),
      ),
    ).toEqual({ kind: 'terminal', category: 'command.payload_conflict' });
  });

  it('classifies unexpected runtime failures as retryable and redacts their details', () => {
    expect(classifyTelegramProcessingFailure(new Error('secret connection details'))).toEqual({
      kind: 'retryable',
      category: 'telegram_processing_failed',
    });
  });
});
