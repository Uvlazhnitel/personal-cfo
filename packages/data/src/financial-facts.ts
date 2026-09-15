import { and, asc, eq } from 'drizzle-orm';
import {
  createAccount,
  createAccountBalanceSnapshot,
  createAccountEntry,
  createCanonicalTransaction,
  createCashReconciliation,
  createCashReconciliationResolution,
  createEconomicFlow,
  createFlowAmbiguity,
  createInvestmentContribution,
  createInvestmentContributionAttribution,
  createPortfolioValuation,
  createPrimarySalaryTrigger,
  createSinkingFund,
  createSinkingFundAllocation,
  createSpendingObservation,
} from '@personal-cfo/domain';
import type {
  Account,
  AccountBalanceSnapshot,
  CanonicalTransaction,
  CashReconciliation,
  CashReconciliationResolution,
  EconomicFlow,
  FlowAmbiguity,
  InvestmentContribution,
  InvestmentContributionAttribution,
  Money,
  PortfolioValuation,
  PrimarySalaryTrigger,
  SinkingFund,
  SinkingFundAllocation,
  SpendingObservation,
} from '@personal-cfo/domain';

import type { Database } from './database.js';
import { DataInvariantError } from './errors.js';
import { decodeSourceJson, encodeSourceJson } from './json-codec.js';
import {
  accountEntries,
  accounts,
  cashReconciliationResolutions,
  cashReconciliations,
  economicFlows,
  evaluationProfiles,
  factPayloads,
  financialTransactions,
  flowAmbiguities,
  flowClassifications,
  ownerInputVersions,
  planningContexts,
  settingsVersions,
  sinkingEvents,
  sinkingFunds,
  transactionVersions,
} from './schema.js';

function canonicalDatabaseInstant(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,6})?(?:\+00(?::?00)?|Z)$/u.exec(
    value,
  );
  if (match === null)
    throw new DataInvariantError(
      'database.invalid_utc_instant',
      'Database instant was not returned in UTC.',
    );
  const fraction = match[3]?.replace(/0+$/u, '') ?? '';
  return `${match[1]}T${match[2]}${fraction === '.' ? '' : fraction}Z`;
}

export type CanonicalFacts = Readonly<{
  accounts: readonly Account[];
  transactions: readonly CanonicalTransaction[];
  accountBalanceSnapshots: readonly AccountBalanceSnapshot[];
  portfolioValuations: readonly PortfolioValuation[];
  investmentContributions: readonly InvestmentContribution[];
  contributionAttributions: readonly InvestmentContributionAttribution[];
  primarySalaryTriggers: readonly PrimarySalaryTrigger[];
  economicFlows: readonly EconomicFlow[];
  ambiguities: readonly FlowAmbiguity[];
  cashReconciliations: readonly CashReconciliation[];
  cashReconciliationResolutions: readonly CashReconciliationResolution[];
  sinkingFunds: readonly SinkingFund[];
  sinkingFundAllocations: readonly SinkingFundAllocation[];
  spendingObservations: readonly SpendingObservation[];
}>;

export type PersistableEvaluation = Readonly<{
  run: Readonly<{
    asOf: string;
    effectiveDate: string;
    engineVersion: string;
    settingsVersion: string;
    inputWatermark: string;
  }>;
  settingsHistory: readonly Readonly<{ version: string; effectiveFrom: string }>[];
  canonical: CanonicalFacts;
  current: unknown;
  historicalCheckpoints: readonly unknown[];
  ccrPeriod: unknown;
  rollingCcrPeriods: readonly unknown[];
  forwardProjection: unknown;
  recurringPlanId: string;
  currentRecurringContribution: Money;
  lastIssuedStepUpCycleIds: readonly string[] | null;
  forecastPlan: unknown;
}>;

const factTypes = {
  accountBalanceSnapshots: 'account_balance_snapshot',
  portfolioValuations: 'portfolio_valuation',
  investmentContributions: 'investment_contribution',
  contributionAttributions: 'contribution_attribution',
  primarySalaryTriggers: 'primary_salary_trigger',
  spendingObservations: 'spending_observation',
} as const;

function factId(type: keyof typeof factTypes, value: unknown): string {
  const record = value as Readonly<Record<string, unknown>>;
  if (type === 'accountBalanceSnapshots')
    return `${String(record['accountId'])}|${String(record['sourceAsOf'])}`;
  if (type === 'portfolioValuations')
    return `${String(record['accountId'])}|${String(record['sourceAsOf'])}`;
  if (
    type === 'investmentContributions' ||
    type === 'contributionAttributions' ||
    type === 'primarySalaryTriggers'
  )
    return String(record['transactionId']);
  return String(record['economicFlowId']);
}

function effectiveAt(value: unknown): string | null {
  const record = value as Readonly<Record<string, unknown>>;
  const candidate = record['effectiveAt'] ?? record['asOf'];
  return typeof candidate === 'string' ? candidate : null;
}

type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

async function insertFactPayloads(
  db: Database | DatabaseTransaction,
  ownerId: string,
  type: keyof typeof factTypes,
  values: readonly unknown[],
): Promise<void> {
  if (values.length === 0) return;
  await db
    .insert(factPayloads)
    .values(
      values.map((value) => ({
        ownerId,
        factType: factTypes[type],
        factId: factId(type, value),
        effectiveAt: effectiveAt(value),
        payload: encodeSourceJson(value),
      })),
    )
    .onConflictDoNothing();
}

export async function saveFinancialEngineSource(
  db: Database,
  ownerId: string,
  input: PersistableEvaluation,
  now: string,
): Promise<Readonly<{ changed: boolean; inputVersion: bigint }>> {
  return db.transaction(async (tx) => {
    let changed = false;
    const mark = (count: number) => {
      if (count > 0) changed = true;
    };

    for (const account of input.canonical.accounts) {
      const inserted = await tx
        .insert(accounts)
        .values({
          id: account.id,
          ownerId,
          kind: account.subtype,
          valueSource: account.valueSource,
          currency: account.currency,
          payload: encodeSourceJson(account),
        })
        .onConflictDoNothing()
        .returning({ id: accounts.id });
      mark(inserted.length);
    }
    for (const transaction of input.canonical.transactions) {
      const identity = await tx
        .insert(financialTransactions)
        .values({ id: transaction.id, ownerId, createdAt: transaction.effectiveAt })
        .onConflictDoNothing()
        .returning({ id: financialTransactions.id });
      mark(identity.length);
      const version = await tx
        .insert(transactionVersions)
        .values({
          ownerId,
          transactionId: transaction.id,
          revision: 1,
          kind: transaction.kind,
          bookingStatus: transaction.bookingStatus,
          effectiveAt: transaction.effectiveAt,
          payload: encodeSourceJson(transaction),
          isCurrent: true,
          supersededAt: null,
        })
        .onConflictDoNothing()
        .returning({ id: transactionVersions.transactionId });
      mark(version.length);
      if (version.length > 0) {
        await tx.insert(accountEntries).values(
          transaction.entries.map((entry) => ({
            ownerId,
            transactionId: transaction.id,
            transactionRevision: 1,
            entryId: entry.id,
            accountId: entry.accountId,
            amountMinor: entry.amount.amountMinor,
            currency: entry.amount.currency,
            role: entry.role,
          })),
        );
      }
    }
    for (const flow of input.canonical.economicFlows) {
      const base = await tx
        .insert(economicFlows)
        .values({
          id: flow.id,
          ownerId,
          transactionId: flow.transactionId,
          effectiveAt: flow.effectiveAt,
          amountMinor: flow.amount.amountMinor,
          currency: flow.amount.currency,
        })
        .onConflictDoNothing()
        .returning({ id: economicFlows.id });
      mark(base.length);
      const classification = await tx
        .insert(flowClassifications)
        .values({
          ownerId,
          flowId: flow.id,
          revision: 1,
          kind: flow.kind,
          source: 'canonical_import',
          reason: null,
          payload: encodeSourceJson(flow),
          decidedAt: flow.effectiveAt,
          isCurrent: true,
        })
        .onConflictDoNothing()
        .returning({ id: flowClassifications.flowId });
      mark(classification.length);
    }
    for (const ambiguity of input.canonical.ambiguities) {
      const inserted = await tx
        .insert(flowAmbiguities)
        .values({
          id: ambiguity.transactionId,
          ownerId,
          transactionId: ambiguity.transactionId,
          kind: ambiguity.kind,
          materiality: ambiguity.materiality,
          status: 'unresolved',
          evidence: encodeSourceJson(ambiguity),
          effectiveAt: ambiguity.effectiveAt,
          resolvedAt: null,
          resolver: null,
          reason: null,
        })
        .onConflictDoNothing()
        .returning({ id: flowAmbiguities.id });
      mark(inserted.length);
    }
    for (const fund of input.canonical.sinkingFunds) {
      const inserted = await tx
        .insert(sinkingFunds)
        .values({
          id: fund.id,
          ownerId,
          targetMinor: fund.target.amountMinor,
          currency: fund.target.currency,
          dueDate: fund.dueDate,
          priority: fund.priority,
          status: fund.status,
          allocationPolicy: fund.allocationPolicy,
          createdAt: fund.createdAt,
          payload: encodeSourceJson(fund),
        })
        .onConflictDoNothing()
        .returning({ id: sinkingFunds.id });
      mark(inserted.length);
    }
    for (const event of input.canonical.sinkingFundAllocations) {
      const inserted = await tx
        .insert(sinkingEvents)
        .values({
          id: event.id,
          ownerId,
          fundId: event.fundId,
          kind: event.kind,
          amountMinor: event.amount.amountMinor,
          currency: event.amount.currency,
          effectiveAt: event.effectiveAt,
          relatedTransactionId:
            event.kind === 'funded_consumption' ? event.relatedTransactionId : null,
          commandId: null,
          payload: encodeSourceJson(event),
        })
        .onConflictDoNothing()
        .returning({ id: sinkingEvents.id });
      mark(inserted.length);
    }
    for (const reconciliation of input.canonical.cashReconciliations) {
      const inserted = await tx
        .insert(cashReconciliations)
        .values({
          id: reconciliation.id,
          ownerId,
          accountId: reconciliation.accountId,
          adjustmentTransactionId: reconciliation.adjustmentTransactionId,
          calculatedMinor: reconciliation.calculatedBalance.amountMinor,
          countedMinor: reconciliation.countedBalance.amountMinor,
          varianceMinor: reconciliation.variance.amountMinor,
          currency: reconciliation.variance.currency,
          materiality: reconciliation.materiality,
          reconciledAt: reconciliation.reconciledAt,
          payload: encodeSourceJson(reconciliation),
        })
        .onConflictDoNothing()
        .returning({ id: cashReconciliations.id });
      mark(inserted.length);
    }
    for (const resolution of input.canonical.cashReconciliationResolutions) {
      const inserted = await tx
        .insert(cashReconciliationResolutions)
        .values({
          reconciliationId: resolution.reconciliationId,
          ownerId,
          kind: resolution.kind,
          resolutionTransactionId: resolution.resolutionTransactionId,
          resolvedAt: resolution.resolvedAt,
          payload: encodeSourceJson(resolution),
        })
        .onConflictDoNothing()
        .returning({ id: cashReconciliationResolutions.reconciliationId });
      mark(inserted.length);
    }
    await insertFactPayloads(
      tx,
      ownerId,
      'accountBalanceSnapshots',
      input.canonical.accountBalanceSnapshots,
    );
    await insertFactPayloads(
      tx,
      ownerId,
      'portfolioValuations',
      input.canonical.portfolioValuations,
    );
    await insertFactPayloads(
      tx,
      ownerId,
      'investmentContributions',
      input.canonical.investmentContributions,
    );
    await insertFactPayloads(
      tx,
      ownerId,
      'contributionAttributions',
      input.canonical.contributionAttributions,
    );
    await insertFactPayloads(
      tx,
      ownerId,
      'primarySalaryTriggers',
      input.canonical.primarySalaryTriggers,
    );
    await insertFactPayloads(
      tx,
      ownerId,
      'spendingObservations',
      input.canonical.spendingObservations,
    );

    for (const setting of input.settingsHistory) {
      const inserted = await tx
        .insert(settingsVersions)
        .values({
          ownerId,
          version: setting.version,
          effectiveFrom: setting.effectiveFrom,
          payload: encodeSourceJson(setting),
          isCurrent: setting.version === input.run.settingsVersion,
        })
        .onConflictDoNothing()
        .returning({ id: settingsVersions.version });
      mark(inserted.length);
    }
    if (input.canonical.accounts.length === 0)
      throw new Error('A persisted evaluation requires at least one account.');
    await tx
      .insert(planningContexts)
      .values({
        ownerId,
        kind: 'current',
        checkpointKey: 'current',
        effectiveAt: input.run.asOf,
        payload: encodeSourceJson(input.current),
      })
      .onConflictDoUpdate({
        target: [planningContexts.ownerId, planningContexts.kind, planningContexts.checkpointKey],
        set: { effectiveAt: input.run.asOf, payload: encodeSourceJson(input.current) },
      });
    for (const checkpoint of input.historicalCheckpoints) {
      const record = checkpoint as Readonly<Record<string, unknown>>;
      const key =
        record['kind'] === 'cash_drag_day'
          ? `cash:${String(record['date'])}`
          : `cycle:${String(record['payCycleId'])}`;
      await tx
        .insert(planningContexts)
        .values({
          ownerId,
          kind: String(record['kind']),
          checkpointKey: key,
          effectiveAt: null,
          payload: encodeSourceJson(checkpoint),
        })
        .onConflictDoUpdate({
          target: [planningContexts.ownerId, planningContexts.kind, planningContexts.checkpointKey],
          set: { payload: encodeSourceJson(checkpoint) },
        });
    }
    const profilePayload = encodeSourceJson({
      sourceInputWatermark: input.run.inputWatermark,
      ccrPeriod: input.ccrPeriod,
      rollingCcrPeriods: input.rollingCcrPeriods,
      forwardProjection: input.forwardProjection,
      recurringPlanId: input.recurringPlanId,
      currentRecurringContribution: input.currentRecurringContribution,
      lastIssuedStepUpCycleIds: input.lastIssuedStepUpCycleIds,
      forecastPlan: input.forecastPlan,
    });
    await tx
      .insert(evaluationProfiles)
      .values({
        ownerId,
        asOf: input.run.asOf,
        effectiveDate: input.run.effectiveDate,
        engineVersion: input.run.engineVersion,
        settingsVersion: input.run.settingsVersion,
        payload: profilePayload,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: evaluationProfiles.ownerId,
        set: {
          asOf: input.run.asOf,
          effectiveDate: input.run.effectiveDate,
          engineVersion: input.run.engineVersion,
          settingsVersion: input.run.settingsVersion,
          payload: profilePayload,
          updatedAt: now,
        },
      });
    if (changed) {
      await tx
        .update(ownerInputVersions)
        .set({ version: input.canonical.transactions.length === 0 ? 1n : 1n, updatedAt: now })
        .where(and(eq(ownerInputVersions.ownerId, ownerId), eq(ownerInputVersions.version, 0n)));
    }
    const versionRow = await tx.query.ownerInputVersions.findFirst({
      where: eq(ownerInputVersions.ownerId, ownerId),
    });
    if (versionRow === undefined) throw new Error('Owner input version is missing.');
    return Object.freeze({ changed, inputVersion: versionRow.version });
  });
}

async function loadFacts<T>(
  db: Database,
  ownerId: string,
  type: string,
  constructor: (value: T) => T,
): Promise<readonly T[]> {
  const rows = await db
    .select()
    .from(factPayloads)
    .where(and(eq(factPayloads.ownerId, ownerId), eq(factPayloads.factType, type)))
    .orderBy(asc(factPayloads.effectiveAt), asc(factPayloads.factId));
  return Object.freeze(rows.map((row) => constructor(decodeSourceJson(row.payload) as T)));
}

export async function loadCanonicalFacts(db: Database, ownerId: string): Promise<CanonicalFacts> {
  const accountRows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.ownerId, ownerId))
    .orderBy(asc(accounts.id));
  const accountsValue = Object.freeze(
    accountRows.map((row) => createAccount(decodeSourceJson(row.payload) as Account)),
  );
  const versions = await db
    .select()
    .from(transactionVersions)
    .where(and(eq(transactionVersions.ownerId, ownerId), eq(transactionVersions.isCurrent, true)))
    .orderBy(asc(transactionVersions.effectiveAt), asc(transactionVersions.transactionId));
  const entryRows = await db
    .select()
    .from(accountEntries)
    .where(eq(accountEntries.ownerId, ownerId))
    .orderBy(asc(accountEntries.transactionId), asc(accountEntries.entryId));
  const transactions = Object.freeze(
    versions.map((row) => {
      const payload = decodeSourceJson(row.payload) as CanonicalTransaction;
      const entries = entryRows
        .filter(
          (entry) =>
            entry.transactionId === row.transactionId && entry.transactionRevision === row.revision,
        )
        .map((entry) =>
          createAccountEntry({
            id: entry.entryId as never,
            transactionId: entry.transactionId as never,
            accountId: entry.accountId as never,
            amount: { amountMinor: entry.amountMinor, currency: entry.currency as never },
            role: entry.role as never,
          }),
        );
      return createCanonicalTransaction({ ...payload, entries });
    }),
  );
  const flowRows = await db
    .select({
      payload: flowClassifications.payload,
      effectiveAt: economicFlows.effectiveAt,
      id: economicFlows.id,
    })
    .from(economicFlows)
    .innerJoin(
      flowClassifications,
      and(
        eq(flowClassifications.ownerId, economicFlows.ownerId),
        eq(flowClassifications.flowId, economicFlows.id),
        eq(flowClassifications.isCurrent, true),
      ),
    )
    .where(eq(economicFlows.ownerId, ownerId))
    .orderBy(asc(economicFlows.effectiveAt), asc(economicFlows.id));
  const ambiguityRows = await db
    .select()
    .from(flowAmbiguities)
    .where(and(eq(flowAmbiguities.ownerId, ownerId), eq(flowAmbiguities.status, 'unresolved')))
    .orderBy(asc(flowAmbiguities.effectiveAt), asc(flowAmbiguities.id));
  const fundRows = await db
    .select()
    .from(sinkingFunds)
    .where(eq(sinkingFunds.ownerId, ownerId))
    .orderBy(asc(sinkingFunds.createdAt), asc(sinkingFunds.id));
  const eventRows = await db
    .select()
    .from(sinkingEvents)
    .where(eq(sinkingEvents.ownerId, ownerId))
    .orderBy(asc(sinkingEvents.effectiveAt), asc(sinkingEvents.id));
  const reconciliationRows = await db
    .select()
    .from(cashReconciliations)
    .where(eq(cashReconciliations.ownerId, ownerId))
    .orderBy(asc(cashReconciliations.reconciledAt), asc(cashReconciliations.id));
  const resolutionRows = await db
    .select()
    .from(cashReconciliationResolutions)
    .where(eq(cashReconciliationResolutions.ownerId, ownerId))
    .orderBy(
      asc(cashReconciliationResolutions.resolvedAt),
      asc(cashReconciliationResolutions.reconciliationId),
    );
  return Object.freeze({
    accounts: accountsValue,
    transactions,
    accountBalanceSnapshots: await loadFacts(
      db,
      ownerId,
      factTypes.accountBalanceSnapshots,
      createAccountBalanceSnapshot,
    ),
    portfolioValuations: await loadFacts(
      db,
      ownerId,
      factTypes.portfolioValuations,
      createPortfolioValuation,
    ),
    investmentContributions: await loadFacts(
      db,
      ownerId,
      factTypes.investmentContributions,
      createInvestmentContribution,
    ),
    contributionAttributions: await loadFacts(
      db,
      ownerId,
      factTypes.contributionAttributions,
      createInvestmentContributionAttribution,
    ),
    primarySalaryTriggers: await loadFacts(
      db,
      ownerId,
      factTypes.primarySalaryTriggers,
      createPrimarySalaryTrigger,
    ),
    economicFlows: Object.freeze(
      flowRows.map((row) => createEconomicFlow(decodeSourceJson(row.payload) as EconomicFlow)),
    ),
    ambiguities: Object.freeze(
      ambiguityRows.map((row) =>
        createFlowAmbiguity(decodeSourceJson(row.evidence) as FlowAmbiguity),
      ),
    ),
    cashReconciliations: Object.freeze(
      reconciliationRows.map((row) =>
        createCashReconciliation(decodeSourceJson(row.payload) as CashReconciliation),
      ),
    ),
    cashReconciliationResolutions: Object.freeze(
      resolutionRows.map((row) =>
        createCashReconciliationResolution(
          decodeSourceJson(row.payload) as CashReconciliationResolution,
        ),
      ),
    ),
    sinkingFunds: Object.freeze(
      fundRows.map((row) => createSinkingFund(decodeSourceJson(row.payload) as SinkingFund)),
    ),
    sinkingFundAllocations: Object.freeze(
      eventRows.map((row) =>
        createSinkingFundAllocation(decodeSourceJson(row.payload) as SinkingFundAllocation),
      ),
    ),
    spendingObservations: await loadFacts(
      db,
      ownerId,
      factTypes.spendingObservations,
      createSpendingObservation,
    ),
  });
}

export async function loadEvaluationParts(
  db: Database,
  ownerId: string,
): Promise<
  Readonly<{
    profile: Readonly<Record<string, unknown>>;
    settingsHistory: readonly unknown[];
    current: unknown;
    historicalCheckpoints: readonly unknown[];
    inputVersion: bigint;
  }>
> {
  const profile = await db.query.evaluationProfiles.findFirst({
    where: eq(evaluationProfiles.ownerId, ownerId),
  });
  const version = await db.query.ownerInputVersions.findFirst({
    where: eq(ownerInputVersions.ownerId, ownerId),
  });
  if (profile === undefined || version === undefined)
    throw new Error('Persistent evaluation profile is incomplete.');
  const contextRows = await db
    .select()
    .from(planningContexts)
    .where(eq(planningContexts.ownerId, ownerId))
    .orderBy(asc(planningContexts.kind), asc(planningContexts.checkpointKey));
  const settings = await db
    .select()
    .from(settingsVersions)
    .where(eq(settingsVersions.ownerId, ownerId))
    .orderBy(asc(settingsVersions.effectiveFrom), asc(settingsVersions.version));
  const current = contextRows.find((row) => row.kind === 'current');
  if (current === undefined) throw new Error('Current planning context is missing.');
  return Object.freeze({
    profile: Object.freeze({
      asOf: canonicalDatabaseInstant(profile.asOf),
      effectiveDate: profile.effectiveDate,
      engineVersion: profile.engineVersion,
      settingsVersion: profile.settingsVersion,
      ...(decodeSourceJson(profile.payload) as Record<string, unknown>),
    }),
    settingsHistory: Object.freeze(settings.map((row) => decodeSourceJson(row.payload))),
    current: decodeSourceJson(current.payload),
    historicalCheckpoints: Object.freeze(
      contextRows
        .filter((row) => row.kind !== 'current')
        .map((row) => decodeSourceJson(row.payload)),
    ),
    inputVersion: version.version,
  });
}
