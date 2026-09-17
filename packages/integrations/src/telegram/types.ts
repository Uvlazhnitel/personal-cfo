import type { StandardSpendingCategoryCode } from '@personal-cfo/domain';

export type TelegramLocale = 'en' | 'ru';

export type TelegramMessage = Readonly<{
  updateId: bigint;
  chatId: bigint;
  senderId: bigint;
  messageId: bigint;
  sentAt: string;
  text: string;
  textHash: string;
  locale: TelegramLocale;
  localeDetected: boolean;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  senderIsBot: boolean;
  forwarded: boolean;
  replyToMessageId: bigint | null;
}>;

export type CashExpenseProposal = Readonly<{
  kind: 'cash_expense';
  amountMinor: bigint;
  economicDate: string;
  effectiveAt: string;
  category: StandardSpendingCategoryCode;
  locale: TelegramLocale;
}>;

export type CashIncomeProposal = Readonly<{
  kind: 'cash_income';
  amountMinor: bigint;
  economicDate: string;
  effectiveAt: string;
  source: 'side_hustle' | 'other';
  locale: TelegramLocale;
}>;

export type CashCountProposal = Readonly<{
  kind: 'cash_count';
  countedMinor: bigint;
  economicDate: string;
  effectiveAt: string;
  locale: TelegramLocale;
}>;

export type FutureExpenseProposal = Readonly<{
  kind: 'future_expense';
  label: string;
  targetMinor: bigint;
  dueDate: string;
  locale: TelegramLocale;
}>;

export type CorrectionPatch =
  | Readonly<{ field: 'amount'; amountMinor: bigint }>
  | Readonly<{ field: 'date'; economicDate: string; effectiveAt: string }>
  | Readonly<{ field: 'category'; category: StandardSpendingCategoryCode }>
  | Readonly<{ field: 'income_source'; source: 'side_hustle' | 'other' }>
  | Readonly<{ field: 'cancel' }>;

export type CorrectionProposal = Readonly<{
  kind: 'correction';
  replyToMessageId: bigint;
  patch: CorrectionPatch;
  locale: TelegramLocale;
}>;

export type TelegramFinancialProposal =
  | CashExpenseProposal
  | CashIncomeProposal
  | CashCountProposal
  | FutureExpenseProposal
  | CorrectionProposal;

export type ClarificationField = 'amount' | 'intent' | 'income_source' | 'due_date';

export type TelegramProposalDraft = Readonly<{
  kind: 'cash_income' | 'future_expense' | 'unknown';
  amountMinor?: string;
  label?: string;
  dueDate?: string;
  economicDate?: string;
  effectiveAt?: string;
  locale: TelegramLocale;
}>;

export type TelegramParseResult =
  | Readonly<{ confidence: 'high'; proposal: TelegramFinancialProposal }>
  | Readonly<{
      confidence: 'needs_clarification';
      missingField: ClarificationField;
      question: string;
      draft: TelegramProposalDraft;
    }>
  | Readonly<{
      confidence: 'unsupported';
      reason: string;
      response: string;
      locale: TelegramLocale;
    }>;

export interface AmbiguousTransactionClassifier {
  classify(input: Readonly<{ textHash: string }>): Promise<null>;
}

export class DisabledAmbiguousTransactionClassifier implements AmbiguousTransactionClassifier {
  classify(): Promise<null> {
    return Promise.resolve(null);
  }
}
