import { and, eq, isNotNull, lte, sql } from 'drizzle-orm';
import {
  createAccountEntry,
  createCanonicalTransaction,
  createFlowAmbiguity,
  EUR,
  parseInstant,
} from '@personal-cfo/domain';

import type { CommandMutationResult } from './commands.js';
import type { Database } from './database.js';
import { DataConflictError, DataInvariantError } from './errors.js';
import type { EnableBankingSyncLease } from './enable-banking.js';
import { decodeSourceJson, encodeSourceJson } from './json-codec.js';
import type { DatabaseTransaction } from './owner-lock.js';
import {
  accountBalanceSnapshots,
  accountEntries,
  accounts,
  enableBankingBalanceReconciliations,
  enableBankingCanonicalImports,
  enableBankingConnections,
  enableBankingHistoryCoverage,
  enableBankingObservationMatches,
  enableBankingProviderAccounts,
  enableBankingRawReceipts,
  enableBankingRuns,
  enableBankingSourceRevisions,
  enableBankingSyncStates,
  enableBankingTransactionObservations,
  financialTransactions,
  flowAmbiguities,
  settingsVersions,
  transactionVersions,
} from './schema.js';
import { generateUuidV7 } from './uuid-v7.js';

export type EnableBankingActivationReadiness = Readonly<{
  allowed: boolean;
  unmet: readonly (
    | 'deployment_disabled'
    | 'owner_not_activated'
    | 'account_identity_unverified'
    | 'transaction_identity_unverified'
    | 'history_coverage_unavailable'
  )[];
}>;

export type EnableBankingCanonicalObservation = Readonly<{
  sourceKey: string;
  revisionSha256: string;
  providerStatus: string;
  amountMinor: bigint;
  currency: string;
  effectiveAt: string;
  ambiguityKind: 'unclassified_external_flow' | 'unresolved_transfer';
  materiality: 'material' | 'non_material';
}>;

function earliest(left: string | null, right: string): string {
  return left === null || right < left ? right : left;
}

export async function loadEnableBankingActivationReadiness(
  db: Database,
  ownerId: string,
  deploymentEnabled: boolean,
): Promise<EnableBankingActivationReadiness> {
  const account = await db.query.enableBankingProviderAccounts.findFirst({
    where: and(
      eq(enableBankingProviderAccounts.ownerId, ownerId),
      isNotNull(enableBankingProviderAccounts.canonicalAccountId),
    ),
  });
  const unmet: EnableBankingActivationReadiness['unmet'][number][] = [];
  if (!deploymentEnabled) unmet.push('deployment_disabled');
  if (account?.ownerActivatedAt === null || account === undefined)
    unmet.push('owner_not_activated');
  if (account?.identityVerifiedAt === null || account === undefined)
    unmet.push('account_identity_unverified');
  if (account?.transactionIdentityVerifiedAt === null || account === undefined)
    unmet.push('transaction_identity_unverified');
  const coverage =
    account === undefined || account.sessionGeneration === null
      ? undefined
      : await db.query.enableBankingHistoryCoverage.findFirst({
          where: and(
            eq(enableBankingHistoryCoverage.ownerId, ownerId),
            eq(enableBankingHistoryCoverage.providerAccountId, account.id),
            eq(enableBankingHistoryCoverage.sessionGeneration, account.sessionGeneration),
          ),
          orderBy: (table, { desc }) => [desc(table.completedAt)],
        });
  if (coverage === undefined) unmet.push('history_coverage_unavailable');
  return Object.freeze({ allowed: unmet.length === 0, unmet: Object.freeze(unmet) });
}

export async function activateEnableBankingCanonicalImport(
  db: Database,
  ownerId: string,
  providerAccountId: string,
  now: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const account = await tx.query.enableBankingProviderAccounts.findFirst({
      where: and(
        eq(enableBankingProviderAccounts.id, providerAccountId),
        eq(enableBankingProviderAccounts.ownerId, ownerId),
        isNotNull(enableBankingProviderAccounts.canonicalAccountId),
      ),
    });
    if (
      account === undefined ||
      account.currency !== 'EUR' ||
      account.sessionGeneration === null ||
      account.identityVerifiedAt === null ||
      account.transactionIdentityVerifiedAt === null
    ) {
      throw new DataInvariantError(
        'enable_banking.activation_prerequisites_missing',
        'Enable Banking canonical activation prerequisites are incomplete.',
      );
    }
    const coverage = await tx.query.enableBankingHistoryCoverage.findFirst({
      where: and(
        eq(enableBankingHistoryCoverage.ownerId, ownerId),
        eq(enableBankingHistoryCoverage.providerAccountId, providerAccountId),
        eq(enableBankingHistoryCoverage.sessionGeneration, account.sessionGeneration),
      ),
    });
    if (coverage === undefined) {
      throw new DataInvariantError(
        'enable_banking.activation_coverage_missing',
        'Enable Banking canonical activation requires closed history coverage.',
      );
    }
    await tx
      .update(enableBankingProviderAccounts)
      .set({ ownerActivatedAt: now, updatedAt: now })
      .where(eq(enableBankingProviderAccounts.id, providerAccountId));
  });
}

export async function loadEffectiveMaterialityThresholdMinor(
  db: Database,
  ownerId: string,
): Promise<bigint> {
  const row = await db.query.settingsVersions.findFirst({
    where: and(eq(settingsVersions.ownerId, ownerId), eq(settingsVersions.isCurrent, true)),
  });
  if (row === undefined) {
    throw new DataInvariantError(
      'enable_banking.missing_materiality',
      'Effective financial settings are unavailable.',
    );
  }
  const payload = decodeSourceJson(row.payload) as Record<string, unknown>;
  const spending = payload['spendingBaseline'];
  const threshold =
    typeof spending === 'object' && spending !== null
      ? (spending as Record<string, unknown>)['materialityThreshold']
      : null;
  const minor =
    typeof threshold === 'object' && threshold !== null
      ? (threshold as Record<string, unknown>)['amountMinor']
      : null;
  if (typeof minor !== 'bigint' || minor < 0n) {
    throw new DataInvariantError(
      'enable_banking.missing_materiality',
      'Effective financial settings do not expose a valid materiality threshold.',
    );
  }
  return minor;
}

export async function completeEnableBankingSync(
  db: Database,
  lease: EnableBankingSyncLease,
  input: Readonly<{
    counts: Record<string, number>;
    coverageFrom: string | null;
    coverageThrough: string | null;
    now: string;
  }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const released = await tx
      .update(enableBankingConnections)
      .set({
        activeRunId: null,
        leaseId: null,
        leaseExpiresAt: null,
        updatedAt: input.now,
        lastFailureCategory: null,
      })
      .where(
        and(
          eq(enableBankingConnections.id, lease.connectionId),
          eq(enableBankingConnections.activeRunId, lease.runId),
          eq(enableBankingConnections.leaseId, lease.leaseId),
        ),
      )
      .returning({ id: enableBankingConnections.id });
    if (released.length !== 1) {
      throw new DataConflictError(
        'enable_banking.lease_lost',
        'Enable Banking sync lease was lost before completion.',
      );
    }
    if ((input.coverageFrom === null) !== (input.coverageThrough === null)) {
      throw new DataInvariantError(
        'enable_banking.invalid_coverage',
        'Enable Banking coverage endpoints must both be present or absent.',
      );
    }
    const priorCoverage = await tx.query.enableBankingHistoryCoverage.findFirst({
      where: and(
        eq(enableBankingHistoryCoverage.ownerId, lease.ownerId),
        eq(enableBankingHistoryCoverage.providerAccountId, lease.providerAccountId),
        eq(enableBankingHistoryCoverage.sessionGeneration, lease.sessionGeneration),
      ),
    });
    const replayProof = await tx.execute(sql<{ proven: boolean }>`
      select exists (
        select 1
          from ${enableBankingSourceRevisions} revision
          join ${enableBankingRawReceipts} receipt
            on receipt.id = revision.receipt_id
         where revision.owner_id = ${lease.ownerId}
           and revision.connection_id = ${lease.connectionId}
           and revision.provider_account_id = ${lease.providerAccountId}
           and revision.record_kind = 'transaction'
           and revision.provider_status = 'booked'
           and receipt.run_id = ${lease.runId}
           and revision.first_seen_at < revision.last_seen_at
      ) as proven
    `);
    const bookedReplayObserved = replayProof.rows[0]?.['proven'] === true;
    if (input.coverageFrom !== null && input.coverageThrough !== null) {
      await tx
        .insert(enableBankingHistoryCoverage)
        .values({
          id: generateUuidV7('enable-banking-coverage'),
          ownerId: lease.ownerId,
          connectionId: lease.connectionId,
          providerAccountId: lease.providerAccountId,
          sessionGeneration: lease.sessionGeneration,
          coveredFrom: input.coverageFrom,
          coveredThrough: input.coverageThrough,
          completedAt: input.now,
          runId: lease.runId,
        })
        .onConflictDoNothing();
    }
    await tx
      .insert(enableBankingSyncStates)
      .values({
        ownerId: lease.ownerId,
        connectionId: lease.connectionId,
        providerAccountId: lease.providerAccountId,
        sessionGeneration: lease.sessionGeneration,
        initialScanComplete: lease.strategy === 'longest',
        lastStrategy: lease.strategy,
        lastCompletedAt: input.now,
      })
      .onConflictDoUpdate({
        target: enableBankingSyncStates.providerAccountId,
        set: {
          sessionGeneration: lease.sessionGeneration,
          initialScanComplete: true,
          lastStrategy: lease.strategy,
          lastCompletedAt: input.now,
        },
      });
    await tx
      .update(enableBankingProviderAccounts)
      .set({
        identityVerifiedAt: input.now,
        ...(bookedReplayObserved && priorCoverage !== undefined
          ? { transactionIdentityVerifiedAt: input.now }
          : {}),
        updatedAt: input.now,
      })
      .where(eq(enableBankingProviderAccounts.id, lease.providerAccountId));
    await tx
      .update(enableBankingRuns)
      .set({
        status: 'completed',
        counts: input.counts,
        coverageFrom: input.coverageFrom,
        coverageThrough: input.coverageThrough,
        continuationCiphertext: null,
        continuationIv: null,
        continuationAuthTag: null,
        continuationHash: null,
        completedAt: input.now,
        failureCategory: null,
      })
      .where(eq(enableBankingRuns.id, lease.runId));
  });
}

export async function loadEnableBankingRunBookedDateRange(
  db: Database,
  lease: EnableBankingSyncLease,
): Promise<Readonly<{ from: string; through: string }> | null> {
  const result = await db.execute(sql<{ from_date: string | null; through_date: string | null }>`
    select
      min(coalesce(observation.booking_date, observation.value_date, observation.transaction_date))::text as from_date,
      max(coalesce(observation.booking_date, observation.value_date, observation.transaction_date))::text as through_date
      from ${enableBankingSourceRevisions} revision
      join ${enableBankingRawReceipts} receipt
        on receipt.id = revision.receipt_id
      join ${enableBankingTransactionObservations} observation
        on observation.owner_id = revision.owner_id
       and observation.connection_id = revision.connection_id
       and observation.provider_account_id = revision.provider_account_id
       and observation.source_key = revision.source_key
       and observation.revision_sha256 = revision.revision_sha256
     where revision.owner_id = ${lease.ownerId}
       and revision.connection_id = ${lease.connectionId}
       and revision.provider_account_id = ${lease.providerAccountId}
       and revision.record_kind = 'transaction'
       and revision.provider_status = 'booked'
       and receipt.run_id = ${lease.runId}
  `);
  const from = result.rows[0]?.['from_date'];
  const through = result.rows[0]?.['through_date'];
  return typeof from !== 'string' || typeof through !== 'string'
    ? null
    : Object.freeze({ from, through });
}

export async function appendEnableBankingCanonicalBatch(
  tx: DatabaseTransaction,
  input: Readonly<{
    ownerId: string;
    connectionId: string;
    canonicalAccountId: string;
    commandId: string;
    observations: readonly EnableBankingCanonicalObservation[];
    balance: Readonly<{
      sourceAsOf: string;
      receivedAt: string;
      staleAt: string;
      amountMinor: bigint;
      historyComplete: boolean;
      unresolvedPending: boolean;
      providerStale: boolean;
      materialityThresholdMinor: bigint;
      runId: string;
      providerAccountId: string;
    }> | null;
    now: string;
  }>,
): Promise<CommandMutationResult> {
  const account = await tx.query.accounts.findFirst({
    where: and(
      eq(accounts.id, input.canonicalAccountId),
      eq(accounts.ownerId, input.ownerId),
      eq(accounts.kind, 'bank'),
      eq(accounts.valueSource, 'balance_snapshot'),
      eq(accounts.currency, 'EUR'),
    ),
  });
  const accountPayload =
    account === undefined ? null : (decodeSourceJson(account.payload) as Record<string, unknown>);
  if (account === undefined || accountPayload?.['includeInNetWorth'] !== true) {
    throw new DataInvariantError(
      'enable_banking.invalid_canonical_account',
      'Canonical import requires the bound owner EUR bank account.',
    );
  }
  let mutations = 0;
  let earliestAffectedAt: string | null = null;
  const transactionIds: string[] = [];
  let persistedReconciliationStatus:
    | 'reconciled'
    | 'provider_stale'
    | 'incomplete_history'
    | 'unresolved_pending'
    | 'material_mismatch'
    | 'unavailable' = 'unavailable';
  for (const observation of input.observations) {
    const already = await tx.query.enableBankingCanonicalImports.findFirst({
      where: and(
        eq(enableBankingCanonicalImports.ownerId, input.ownerId),
        eq(enableBankingCanonicalImports.connectionId, input.connectionId),
        eq(enableBankingCanonicalImports.sourceKey, observation.sourceKey),
        eq(enableBankingCanonicalImports.revisionSha256, observation.revisionSha256),
      ),
    });
    if (already !== undefined) continue;
    const previous = await tx.query.enableBankingCanonicalImports.findFirst({
      where: and(
        eq(enableBankingCanonicalImports.ownerId, input.ownerId),
        eq(enableBankingCanonicalImports.connectionId, input.connectionId),
        eq(enableBankingCanonicalImports.sourceKey, observation.sourceKey),
      ),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    });
    let correctionTransactionId: string | null = null;
    const previousHasActiveEffect = previous !== undefined && previous.disposition !== 'cancelled';
    if (previousHasActiveEffect) {
      const previousVersion = await tx.query.transactionVersions.findFirst({
        where: and(
          eq(transactionVersions.ownerId, input.ownerId),
          eq(transactionVersions.transactionId, previous.canonicalTransactionId),
          eq(transactionVersions.isCurrent, true),
        ),
      });
      const previousEntry = await tx.query.accountEntries.findFirst({
        where: and(
          eq(accountEntries.ownerId, input.ownerId),
          eq(accountEntries.transactionId, previous.canonicalTransactionId),
          eq(accountEntries.transactionRevision, previousVersion?.revision ?? 0),
          eq(accountEntries.accountId, input.canonicalAccountId),
        ),
      });
      if (previousVersion === undefined || previousEntry === undefined) {
        throw new DataInvariantError(
          'enable_banking.invalid_import_lineage',
          'Existing Enable Banking canonical import is incomplete.',
        );
      }
      const correctionId = generateUuidV7('enable-banking-correction');
      correctionTransactionId = correctionId;
      const correction = createCanonicalTransaction({
        id: correctionId as never,
        effectiveAt: parseInstant(new Date(previous.effectiveAt).toISOString()),
        bookingStatus: 'booked',
        kind: 'external_flow',
        entries: [
          createAccountEntry({
            id: generateUuidV7('enable-banking-correction-entry') as never,
            transactionId: correctionId as never,
            accountId: input.canonicalAccountId as never,
            amount: { amountMinor: -previousEntry.amountMinor, currency: EUR },
            role: 'external_flow',
          }),
        ],
      });
      await tx.insert(financialTransactions).values({
        id: correction.id,
        ownerId: input.ownerId,
        createdAt: input.now,
      });
      await tx.insert(transactionVersions).values({
        ownerId: input.ownerId,
        transactionId: correction.id,
        revision: 1,
        kind: correction.kind,
        bookingStatus: correction.bookingStatus,
        effectiveAt: correction.effectiveAt,
        payload: encodeSourceJson(correction),
        isCurrent: true,
        supersededAt: null,
      });
      await tx.insert(accountEntries).values({
        ownerId: input.ownerId,
        transactionId: correction.id,
        transactionRevision: 1,
        entryId: correction.entries[0]!.id,
        accountId: input.canonicalAccountId,
        amountMinor: correction.entries[0]!.amount.amountMinor,
        currency: 'EUR',
        role: 'external_flow',
      });
      await tx
        .update(flowAmbiguities)
        .set({
          status: 'rejected_transfer',
          resolvedAt: input.now,
          resolver: 'provider_revision',
          reason: 'Superseded by an immutable Enable Banking correction.',
        })
        .where(
          and(
            eq(flowAmbiguities.ownerId, input.ownerId),
            eq(flowAmbiguities.transactionId, previous.canonicalTransactionId),
            eq(flowAmbiguities.status, 'unresolved'),
          ),
        );
      earliestAffectedAt = earliest(earliestAffectedAt, previous.effectiveAt);
      mutations += 1;
    }
    if (observation.providerStatus !== 'booked') {
      if (previous !== undefined) {
        await tx.insert(enableBankingCanonicalImports).values({
          id: generateUuidV7('enable-banking-import'),
          ownerId: input.ownerId,
          connectionId: input.connectionId,
          sourceKey: observation.sourceKey,
          revisionSha256: observation.revisionSha256,
          canonicalTransactionId: correctionTransactionId ?? previous.canonicalTransactionId,
          commandId: input.commandId,
          disposition: 'cancelled',
          supersedesImportId: previous.id,
          effectiveAt: previous.effectiveAt,
          createdAt: input.now,
        });
      }
      continue;
    }
    const transactionId = generateUuidV7('enable-banking-transaction');
    const transaction = createCanonicalTransaction({
      id: transactionId as never,
      effectiveAt: observation.effectiveAt as never,
      bookingStatus: 'booked',
      kind: 'external_flow',
      entries: [
        createAccountEntry({
          id: generateUuidV7('enable-banking-entry') as never,
          transactionId: transactionId as never,
          accountId: input.canonicalAccountId as never,
          amount: { amountMinor: observation.amountMinor, currency: EUR },
          role: 'external_flow',
        }),
      ],
    });
    await tx.insert(financialTransactions).values({
      id: transaction.id,
      ownerId: input.ownerId,
      createdAt: input.now,
    });
    await tx.insert(transactionVersions).values({
      ownerId: input.ownerId,
      transactionId: transaction.id,
      revision: 1,
      kind: transaction.kind,
      bookingStatus: transaction.bookingStatus,
      effectiveAt: transaction.effectiveAt,
      payload: encodeSourceJson(transaction),
      isCurrent: true,
      supersededAt: null,
    });
    await tx.insert(accountEntries).values({
      ownerId: input.ownerId,
      transactionId: transaction.id,
      transactionRevision: 1,
      entryId: transaction.entries[0]!.id,
      accountId: input.canonicalAccountId,
      amountMinor: transaction.entries[0]!.amount.amountMinor,
      currency: 'EUR',
      role: 'external_flow',
    });
    const ambiguity = createFlowAmbiguity({
      transactionId: transaction.id,
      effectiveAt: transaction.effectiveAt,
      kind: observation.ambiguityKind,
      materiality: observation.materiality,
    });
    await tx.insert(flowAmbiguities).values({
      id: transaction.id,
      ownerId: input.ownerId,
      transactionId: transaction.id,
      kind: ambiguity.kind,
      materiality: ambiguity.materiality,
      status: 'unresolved',
      evidence: encodeSourceJson({
        provider: 'enable-banking',
        sourceKey: observation.sourceKey,
        revisionSha256: observation.revisionSha256,
      }),
      effectiveAt: transaction.effectiveAt,
      resolvedAt: null,
      resolver: null,
      reason: null,
    });
    await tx.insert(enableBankingCanonicalImports).values({
      id: generateUuidV7('enable-banking-import'),
      ownerId: input.ownerId,
      connectionId: input.connectionId,
      sourceKey: observation.sourceKey,
      revisionSha256: observation.revisionSha256,
      canonicalTransactionId: transaction.id,
      commandId: input.commandId,
      disposition: previous === undefined ? 'imported' : 'corrected',
      supersedesImportId: previous?.id ?? null,
      effectiveAt: transaction.effectiveAt,
      createdAt: input.now,
    });
    transactionIds.push(transaction.id);
    mutations += 1;
    earliestAffectedAt = earliest(earliestAffectedAt, transaction.effectiveAt);
  }
  if (input.balance !== null) {
    const ledger = await tx.execute(sql<{ balance: bigint | string }>`
      select coalesce(sum(e.amount_minor), 0)::bigint as balance
        from account_entries e
        join transaction_versions v
          on v.owner_id = e.owner_id
         and v.transaction_id = e.transaction_id
         and v.revision = e.transaction_revision
       where e.owner_id = ${input.ownerId}
         and e.account_id = ${input.canonicalAccountId}
         and v.is_current = true
         and v.booking_status = 'booked'
         and v.effective_at <= ${input.balance.sourceAsOf}::timestamptz
    `);
    const canonicalBalanceMinor = BigInt(
      (ledger.rows[0]?.['balance'] as bigint | string | undefined) ?? 0,
    );
    const differenceMinor = input.balance.amountMinor - canonicalBalanceMinor;
    const absoluteDifference = differenceMinor < 0n ? -differenceMinor : differenceMinor;
    const reconciliationStatus = input.balance.providerStale
      ? 'provider_stale'
      : !input.balance.historyComplete
        ? 'incomplete_history'
        : input.balance.unresolvedPending
          ? 'unresolved_pending'
          : absoluteDifference > input.balance.materialityThresholdMinor
            ? 'material_mismatch'
            : 'reconciled';
    persistedReconciliationStatus = reconciliationStatus;
    const existing = await tx.query.accountBalanceSnapshots.findFirst({
      where: and(
        eq(accountBalanceSnapshots.ownerId, input.ownerId),
        eq(accountBalanceSnapshots.accountId, input.canonicalAccountId),
        eq(accountBalanceSnapshots.sourceAsOf, input.balance.sourceAsOf),
      ),
    });
    if (existing === undefined) {
      await tx.insert(accountBalanceSnapshots).values({
        ownerId: input.ownerId,
        accountId: input.canonicalAccountId,
        sourceAsOf: input.balance.sourceAsOf,
        receivedAt: input.balance.receivedAt,
        staleAt: input.balance.staleAt,
        reportabilityStatus: 'available',
        originalAmountMinor: input.balance.amountMinor,
        originalCurrency: 'EUR',
        reportingAmountMinor: input.balance.amountMinor,
        reportingCurrency: 'EUR',
        fxRateId: null,
      });
      mutations += 1;
    }
    await tx
      .insert(enableBankingBalanceReconciliations)
      .values({
        id: generateUuidV7('enable-banking-reconciliation'),
        ownerId: input.ownerId,
        connectionId: input.connectionId,
        providerAccountId: input.balance.providerAccountId,
        canonicalAccountId: input.canonicalAccountId,
        runId: input.balance.runId,
        sourceAsOf: input.balance.sourceAsOf,
        providerBalanceMinor: input.balance.amountMinor,
        canonicalBalanceMinor,
        differenceMinor,
        currency: 'EUR',
        materialityThresholdMinor: input.balance.materialityThresholdMinor,
        status: reconciliationStatus,
        createdAt: input.now,
      })
      .onConflictDoNothing();
  }
  return Object.freeze({
    mutated: mutations > 0,
    entityType: 'enable_banking_sync',
    entityId: input.connectionId,
    earliestAffectedAt,
    result: Object.freeze({
      transactionIds: Object.freeze(transactionIds),
      mutationCount: mutations,
      reconciliationStatus: persistedReconciliationStatus,
    }),
  });
}

export async function loadCanonicalLedgerBalanceAt(
  db: Database,
  ownerId: string,
  accountId: string,
  at: string,
): Promise<bigint> {
  const result = await db.execute(sql<{ balance: bigint | string }>`
    select coalesce(sum(e.amount_minor), 0)::bigint as balance
      from account_entries e
      join transaction_versions v
        on v.owner_id = e.owner_id
       and v.transaction_id = e.transaction_id
       and v.revision = e.transaction_revision
     where e.owner_id = ${ownerId}
       and e.account_id = ${accountId}
       and v.is_current = true
       and v.booking_status = 'booked'
       and v.effective_at <= ${at}::timestamptz
  `);
  return BigInt((result.rows[0]?.['balance'] as bigint | string | undefined) ?? 0);
}

export async function listEnableBankingSyncOwners(db: Database): Promise<readonly string[]> {
  const rows = await db
    .select({ ownerId: enableBankingConnections.ownerId })
    .from(enableBankingConnections)
    .innerJoin(
      enableBankingProviderAccounts,
      and(
        eq(enableBankingProviderAccounts.connectionId, enableBankingConnections.id),
        isNotNull(enableBankingProviderAccounts.canonicalAccountId),
      ),
    )
    .where(eq(enableBankingConnections.status, 'active'))
    .orderBy(enableBankingConnections.ownerId);
  return Object.freeze([...new Set(rows.map((row) => row.ownerId))]);
}

export async function listEnableBankingSyncTargets(
  db: Database,
): Promise<readonly Readonly<{ ownerId: string; connectionGeneration: string }>[]> {
  const rows = await db
    .select({
      ownerId: enableBankingConnections.ownerId,
      connectionGeneration: enableBankingConnections.generation,
    })
    .from(enableBankingConnections)
    .innerJoin(
      enableBankingProviderAccounts,
      and(
        eq(enableBankingProviderAccounts.connectionId, enableBankingConnections.id),
        isNotNull(enableBankingProviderAccounts.canonicalAccountId),
      ),
    )
    .where(eq(enableBankingConnections.status, 'active'))
    .orderBy(enableBankingConnections.ownerId);
  return Object.freeze(
    rows
      .map((row) => Object.freeze(row))
      .filter(
        (row, index, all) =>
          all.findIndex(
            (candidate) =>
              candidate.ownerId === row.ownerId &&
              candidate.connectionGeneration === row.connectionGeneration,
          ) === index,
      ),
  );
}

export async function loadCurrentEnableBankingObservations(
  db: Database,
  ownerId: string,
  connectionId: string,
): Promise<readonly (typeof enableBankingTransactionObservations.$inferSelect)[]> {
  return db.query.enableBankingTransactionObservations.findMany({
    where: and(
      eq(enableBankingTransactionObservations.ownerId, ownerId),
      eq(enableBankingTransactionObservations.connectionId, connectionId),
      eq(enableBankingTransactionObservations.isCurrent, true),
      isNotNull(enableBankingTransactionObservations.sourceKey),
    ),
    orderBy: (table, { asc }) => [asc(table.bookingDate), asc(table.revisionSha256)],
  });
}

export async function recordEnableBankingObservationMatch(
  db: Database,
  input: Readonly<{
    ownerId: string;
    connectionId: string;
    leftObservationId: string;
    rightObservationId: string;
    kind:
      | 'pending_booked'
      | 'bank_to_cash'
      | 'investment_transfer'
      | 'internal_transfer'
      | 'refund'
      | 'reimbursement';
    state: 'candidate' | 'confirmed' | 'rejected';
    reason: string;
    now: string;
  }>,
): Promise<void> {
  if (input.leftObservationId === input.rightObservationId) {
    throw new DataInvariantError(
      'enable_banking.invalid_observation_match',
      'An observation cannot match itself.',
    );
  }
  await db
    .insert(enableBankingObservationMatches)
    .values({
      id: generateUuidV7('enable-banking-match'),
      ownerId: input.ownerId,
      connectionId: input.connectionId,
      leftObservationId: input.leftObservationId,
      rightObservationId: input.rightObservationId,
      kind: input.kind,
      state: input.state,
      reason: input.reason,
      createdAt: input.now,
      resolvedAt: input.state === 'candidate' ? null : input.now,
    })
    .onConflictDoNothing();
}

export async function loadEnableBankingObservationIdByRevision(
  db: Database,
  ownerId: string,
  connectionId: string,
  revisionSha256: string,
): Promise<string | null> {
  const row = await db.query.enableBankingTransactionObservations.findFirst({
    where: and(
      eq(enableBankingTransactionObservations.ownerId, ownerId),
      eq(enableBankingTransactionObservations.connectionId, connectionId),
      eq(enableBankingTransactionObservations.revisionSha256, revisionSha256),
    ),
  });
  return row?.id ?? null;
}

export async function loadLatestEnableBankingReconciliation(
  db: Database | DatabaseTransaction,
  ownerId: string,
  at: string,
): Promise<typeof enableBankingBalanceReconciliations.$inferSelect | null> {
  return (
    (await db.query.enableBankingBalanceReconciliations.findFirst({
      where: and(
        eq(enableBankingBalanceReconciliations.ownerId, ownerId),
        lte(enableBankingBalanceReconciliations.createdAt, at),
      ),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    })) ?? null
  );
}

export type EnableBankingCoverageInterval = Readonly<{
  coveredFrom: string;
  coveredThrough: string;
}>;

function nextUtcDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export async function loadMergedEnableBankingCoverage(
  db: Database | DatabaseTransaction,
  ownerId: string,
  at: string,
): Promise<readonly EnableBankingCoverageInterval[]> {
  const rows = await db.query.enableBankingHistoryCoverage.findMany({
    where: and(
      eq(enableBankingHistoryCoverage.ownerId, ownerId),
      lte(enableBankingHistoryCoverage.completedAt, at),
    ),
    orderBy: (table, { asc }) => [asc(table.coveredFrom), asc(table.coveredThrough)],
  });
  const merged: { coveredFrom: string; coveredThrough: string }[] = [];
  for (const row of rows) {
    const previous = merged.at(-1);
    if (previous === undefined || row.coveredFrom > nextUtcDate(previous.coveredThrough)) {
      merged.push({ coveredFrom: row.coveredFrom, coveredThrough: row.coveredThrough });
      continue;
    }
    if (row.coveredThrough > previous.coveredThrough) {
      previous.coveredThrough = row.coveredThrough;
    }
  }
  return Object.freeze(merged.map((interval) => Object.freeze(interval)));
}
