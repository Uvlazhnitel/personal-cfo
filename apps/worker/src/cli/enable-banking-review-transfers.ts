import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

import {
  createDatabaseContext,
  decryptProviderPayload,
  deriveProviderSubkey,
  enableBankingRawReceipts,
  enableBankingRuns,
  requireDatabaseUrl,
} from '@personal-cfo/data';
import { and, desc, eq } from 'drizzle-orm';

import { enableBankingConfiguration } from '../enable-banking/config.js';

const details = process.argv.includes('--details');
if (details && (!stdin.isTTY || !stdout.isTTY)) throw new Error('Detail review requires a TTY.');
const configuration = await enableBankingConfiguration();
const database = createDatabaseContext(requireDatabaseUrl(), { maxConnections: 2 });

function receiptAad(row: typeof enableBankingRawReceipts.$inferSelect): string {
  return `enable-banking|receipt-v1|${row.ownerId}|${row.connectionId}|${row.runId}|${row.id}|${row.endpoint}|${row.requestKey}|${row.requestCursorHash ?? '-'}`;
}

type ProviderTransaction = Record<string, unknown>;

try {
  const run = await database.db.query.enableBankingRuns.findFirst({
    where: and(
      eq(enableBankingRuns.ownerId, configuration.ownerId),
      eq(enableBankingRuns.kind, 'diagnostic_fetch'),
      eq(enableBankingRuns.strategy, 'longest'),
      eq(enableBankingRuns.status, 'completed'),
    ),
    orderBy: [desc(enableBankingRuns.completedAt)],
  });
  if (run === undefined) throw new Error('A completed longest-history diagnostic run is required.');
  const receipts = await database.db.query.enableBankingRawReceipts.findMany({
    where: and(
      eq(enableBankingRawReceipts.ownerId, configuration.ownerId),
      eq(enableBankingRawReceipts.runId, run.id),
      eq(enableBankingRawReceipts.endpoint, 'transactions'),
    ),
    orderBy: (table, { asc }) => [asc(table.receivedAt), asc(table.id)],
  });
  const key = deriveProviderSubkey(configuration.dataKey, 'receipt-v1');
  const records = new Map<string, ProviderTransaction>();
  for (const receipt of receipts) {
    if (
      receipt.payloadCiphertext === null ||
      receipt.payloadIv === null ||
      receipt.payloadAuthTag === null
    )
      throw new Error('A required encrypted receipt has expired.');
    const payload = JSON.parse(
      decryptProviderPayload(
        receipt.payloadCiphertext,
        receipt.payloadIv,
        receipt.payloadAuthTag,
        key,
        receiptAad(receipt),
        'Enable Banking',
      ),
    ) as Record<string, unknown>;
    const transactions = payload['transactions'];
    if (!Array.isArray(transactions)) continue;
    for (const item of transactions) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const transaction = item as ProviderTransaction;
      const source = transaction['entry_reference'];
      if (transaction['status'] === 'BOOK' && typeof source === 'string')
        records.set(source, transaction);
    }
  }
  const candidates = [...records.values()].filter((transaction) => {
    const code = transaction['bank_transaction_code'];
    if (typeof code !== 'object' || code === null || Array.isArray(code)) return false;
    const value = (code as Record<string, unknown>)['code'];
    return typeof value === 'string' && /(?:^|-)\b[IR]CDT\b/u.test(value);
  });
  console.info(
    JSON.stringify({
      event: 'enable_banking.transfer_review.summary',
      bookedReviewed: records.size,
      transferCandidates: candidates.length,
      classificationsPersisted: 0,
      confirmedTransfersCreated: 0,
      confirmedPrincipalsCreated: 0,
    }),
  );
  if (details) {
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      for (let index = 0; index < candidates.length; index += 1) {
        const transaction = candidates[index]!;
        console.info(
          JSON.stringify(
            {
              candidate: index + 1,
              total: candidates.length,
              status: transaction['status'],
              direction: transaction['credit_debit_indicator'],
              amount: transaction['transaction_amount'],
              bookingDate: transaction['booking_date'],
              valueDate: transaction['value_date'],
              bankTransactionCode: transaction['bank_transaction_code'],
              counterparty: transaction['creditor_name'] ?? transaction['debtor_name'] ?? null,
              reference: transaction['reference_number'] ?? null,
              remittance: transaction['remittance_information'] ?? null,
            },
            null,
            2,
          ),
        );
        const answer = await prompt.question('Enter for next, q to stop: ');
        if (answer.trim().toLocaleLowerCase('en') === 'q') break;
      }
    } finally {
      prompt.close();
    }
  }
} finally {
  await database.close();
}
