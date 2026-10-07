import {
  DataInvariantError,
  loadCanonicalFacts,
  loadEvaluationParts,
  loadLatestEnableBankingReconciliation,
  loadLatestEnableBankingReconciliationsByAccount,
  loadMergedEnableBankingCoverage,
} from '@personal-cfo/data';
import type { Database, RecalculationCause } from '@personal-cfo/data';
import {
  EUR,
  compareInstants,
  createExactFraction,
  createMoney,
  parseInstant,
  parseLocalDate,
} from '@personal-cfo/domain';
import type { Instant } from '@personal-cfo/domain';
import {
  calculateCurrentPositions,
  DEFAULT_FORECAST_SETTINGS,
  DEFAULT_INVESTMENT_STEP_SETTINGS,
} from '@personal-cfo/financial-engine';
import type { FinancialEngineInput, FinancialEngineSettings } from '@personal-cfo/financial-engine';

import { deriveRunPlanningContext } from './planning-recurrence.js';

export type FinancialEngineAssemblyRequest = Readonly<{
  ownerId: string;
  expectedInputVersion: bigint;
  asOf: string;
  effectiveDate: string;
  cause: RecalculationCause;
}>;

export type FinancialEngineAssemblyResult =
  | Readonly<{
      status: 'ready';
      expectedInputVersion: bigint;
      loadedInputVersion: bigint;
      input: FinancialEngineInput;
    }>
  | Readonly<{
      status: 'superseded';
      expectedInputVersion: bigint;
      loadedInputVersion: bigint;
    }>;

const RIGA_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Riga',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const V1_POLICY_DEFAULTS = Object.freeze({
  spendingBaseline: Object.freeze({
    baselineWindowMonths: 6,
    minimumCompleteMonths: 3,
    maximumBaselineLookbackMonths: 36,
    variabilityPercentile: createExactFraction(4n, 5n),
    seasonalityMinimumMonths: 24,
    seasonalityCap: createExactFraction(1n, 5n),
    fallbackNormalBaseline: null,
    fallbackEssentialBaseline: null,
  }),
  liquidity: Object.freeze({
    minimumReserveMonths: createExactFraction(1n, 1n),
    comfortReserveMonths: createExactFraction(3n, 1n),
    unknownIncomeHorizonDays: 31,
    obligationHorizonDays: 90,
  }),
  safeToInvest: Object.freeze({ recommendationIncrement: createMoney(1_000n, EUR) }),
  cashDrag: Object.freeze({
    windowDays: 60,
    minimumCompleteDays: 54,
    minimumPositiveExcessDays: 45,
    absoluteExcessThreshold: createMoney(25_000n, EUR),
    relativeComfortThreshold: createExactFraction(1n, 10n),
  }),
  investmentStep: DEFAULT_INVESTMENT_STEP_SETTINGS,
  forecast: DEFAULT_FORECAST_SETTINGS,
});

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : Object.freeze({});
}

function hydrateV1Settings(value: unknown): FinancialEngineSettings {
  const persisted = record(value);
  const spending = record(persisted['spendingBaseline']);
  if (spending['materialityThreshold'] === undefined) {
    throw new DataInvariantError(
      'assembly.missing_materiality_settings',
      'The persisted settings version must define an explicit materiality threshold.',
    );
  }
  return Object.freeze({
    effectiveFrom: persisted['effectiveFrom'] as FinancialEngineSettings['effectiveFrom'],
    version: persisted['version'] as FinancialEngineSettings['version'],
    spendingBaseline: Object.freeze({
      ...V1_POLICY_DEFAULTS.spendingBaseline,
      ...spending,
    }) as FinancialEngineSettings['spendingBaseline'],
    liquidity: Object.freeze({
      ...V1_POLICY_DEFAULTS.liquidity,
      ...record(persisted['liquidity']),
    }),
    safeToInvest: Object.freeze({
      ...V1_POLICY_DEFAULTS.safeToInvest,
      ...record(persisted['safeToInvest']),
    }),
    cashDrag: Object.freeze({
      ...V1_POLICY_DEFAULTS.cashDrag,
      ...record(persisted['cashDrag']),
    }),
    investmentStep: Object.freeze({
      ...V1_POLICY_DEFAULTS.investmentStep,
      ...record(persisted['investmentStep']),
    }),
    forecast: Object.freeze({
      ...V1_POLICY_DEFAULTS.forecast,
      ...record(persisted['forecast']),
    }),
  });
}

function rigaDateOfInstant(value: string): string {
  const parts = RIGA_DATE.formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function effectiveSettingsVersion(
  history: readonly FinancialEngineSettings[],
  effectiveDate: string,
): string {
  const eligible = history
    .filter((settings) => settings.effectiveFrom <= effectiveDate)
    .sort((left, right) =>
      left.effectiveFrom === right.effectiveFrom
        ? left.version.localeCompare(right.version)
        : left.effectiveFrom.localeCompare(right.effectiveFrom),
    );
  const selected = eligible.at(-1);
  if (selected === undefined) {
    throw new DataInvariantError(
      'assembly.missing_effective_settings',
      'No persisted settings version is effective at the requested run boundary.',
    );
  }
  return selected.version;
}

function nextUtcDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function previousUtcDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function nextMonth(value: string): string {
  const date = new Date(`${value}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 7);
}

type BankReconciliationEvidence = Readonly<{
  canonicalAccountId: string;
  sourceAsOf: string | null;
  differenceMinor: bigint | null;
  currency: string;
  status: string;
}>;

export function deriveEvidenceBackedCurrentContext(
  input: Readonly<{
    current: FinancialEngineInput['current'];
    canonical: FinancialEngineInput['canonical'];
    bankCoverage: readonly Readonly<{ coveredFrom: string; coveredThrough: string }>[];
    bankReconciliations: readonly BankReconciliationEvidence[];
    asOf: Instant;
    effectiveDate: string;
    settingsVersion: string;
    engineVersion: string;
    inputWatermark: string;
  }>,
): FinancialEngineInput['current'] {
  const transactions = input.canonical.transactions.filter(
    (transaction) => compareInstants(transaction.effectiveAt, input.asOf) <= 0,
  );
  const positions = calculateCurrentPositions({
    accounts: input.canonical.accounts,
    transactions,
    investmentContributions: input.canonical.investmentContributions,
    accountBalanceSnapshots: input.canonical.accountBalanceSnapshots,
    portfolioValuations: input.canonical.portfolioValuations,
    asOf: input.asOf,
    engineVersion: input.engineVersion,
    settingsVersion: input.settingsVersion,
    inputWatermark: input.inputWatermark,
  });
  const bankAccounts = input.canonical.accounts.filter(
    (account) => account.includeInNetWorth && account.subtype === 'bank',
  );
  const reconciliationByAccount = new Map(
    input.bankReconciliations.map((item) => [item.canonicalAccountId, item]),
  );
  const hasBankEvidence = input.bankCoverage.length > 0 || input.bankReconciliations.length > 0;
  const exactBankReconciliation = bankAccounts.every((account) => {
    const reconciliation = reconciliationByAccount.get(account.id);
    return (
      reconciliation !== undefined &&
      reconciliation.status === 'reconciled' &&
      reconciliation.differenceMinor === 0n &&
      reconciliation.currency === 'EUR'
    );
  });
  const liquidBalance = !hasBankEvidence
    ? input.current.quality.liquidBalance
    : positions.liquidCash.status === 'complete' && exactBankReconciliation
      ? ('complete' as const)
      : positions.liquidCash.status === 'unavailable' ||
          bankAccounts.some((account) => !reconciliationByAccount.has(account.id))
        ? ('unavailable' as const)
        : ('partial' as const);

  const activeFunds = input.canonical.sinkingFunds.filter(
    (fund) => compareInstants(fund.createdAt, input.asOf) <= 0,
  );
  const earliestFund = activeFunds
    .map((fund) => fund.createdAt)
    .sort((left, right) => compareInstants(left, right))[0];
  const reservationHistory =
    (earliestFund === undefined ||
      compareInstants(input.current.reservationCoverage.startInclusive, earliestFund) <= 0) &&
    compareInstants(input.asOf, input.current.reservationCoverage.endExclusive) < 0
      ? ('complete' as const)
      : ('unavailable' as const);

  const flowByTransaction = new Map(
    input.canonical.economicFlows.map((flow) => [flow.transactionId, flow]),
  );
  const observedFlowIds = new Set(
    input.canonical.spendingObservations.map((observation) => observation.economicFlowId),
  );
  const transactionComplete = (transaction: (typeof transactions)[number]): boolean => {
    if (transaction.kind !== 'external_flow') return true;
    const flow = flowByTransaction.get(transaction.id);
    if (flow === undefined) return false;
    return (
      (flow.kind !== 'consumption' && flow.kind !== 'refund' && flow.kind !== 'reimbursement') ||
      observedFlowIds.has(flow.id)
    );
  };
  const targetMonth = input.effectiveDate.slice(0, 7);
  const historyStartDate = rigaDateOfInstant(input.current.historyCoverage.startInclusive);
  const startMonth = historyStartDate.slice(0, 7);
  const monthCoverage: FinancialEngineInput['current']['monthCoverage'][number][] = [];
  for (let month = startMonth; hasBankEvidence && month < targetMonth; month = nextMonth(month)) {
    const monthStart = `${month}-01`;
    const followingMonth = `${nextMonth(month)}-01`;
    const monthEnd = previousUtcDate(followingMonth);
    const fullDecisionCoverage = historyStartDate <= monthStart;
    const fullBankCoverage = input.bankCoverage.some(
      (coverage) => coverage.coveredFrom <= monthStart && coverage.coveredThrough >= monthEnd,
    );
    const monthTransactions = transactions.filter(
      (transaction) => rigaDateOfInstant(transaction.effectiveAt).slice(0, 7) === month,
    );
    const monthAmbiguities = input.canonical.ambiguities.filter(
      (ambiguity) => rigaDateOfInstant(ambiguity.effectiveAt).slice(0, 7) === month,
    );
    const reconciled =
      fullDecisionCoverage &&
      fullBankCoverage &&
      bankAccounts.every((account) => {
        const evidence = reconciliationByAccount.get(account.id);
        return (
          evidence?.status === 'reconciled' &&
          evidence.differenceMinor === 0n &&
          evidence.currency === 'EUR' &&
          evidence.sourceAsOf !== null &&
          rigaDateOfInstant(evidence.sourceAsOf) >= monthEnd
        );
      });
    monthCoverage.push(
      Object.freeze({
        month: month as never,
        reconciled,
        materialAmbiguityFree: monthAmbiguities.every(
          (ambiguity) => ambiguity.materiality !== 'material',
        ),
        fxComplete: monthTransactions.every((transaction) =>
          transaction.entries.every((entry) => entry.amount.currency === 'EUR'),
        ),
        spendingClassificationComplete:
          monthAmbiguities.length === 0 && monthTransactions.every(transactionComplete),
      }),
    );
  }
  const decisionTransactions = transactions.filter(
    (transaction) =>
      compareInstants(transaction.effectiveAt, input.current.historyCoverage.startInclusive) >= 0,
  );
  const derivedMonthCoverage = hasBankEvidence
    ? Object.freeze(monthCoverage)
    : input.current.monthCoverage;
  const spendingClassification = !hasBankEvidence
    ? input.current.quality.spendingClassification
    : monthCoverage.length === 0
      ? ('unavailable' as const)
      : input.canonical.ambiguities.length === 0 && decisionTransactions.every(transactionComplete)
        ? ('complete' as const)
        : ('partial' as const);

  return Object.freeze({
    ...input.current,
    monthCoverage: derivedMonthCoverage,
    quality: Object.freeze({
      ...input.current.quality,
      liquidBalance,
      reservationHistory,
      spendingClassification,
    }),
  });
}

function applyBankCoverage(
  context: FinancialEngineInput['current'],
  coverage: Readonly<{ coveredFrom: string; coveredThrough: string }> | undefined,
): FinancialEngineInput['current'] {
  if (coverage === undefined) return context;
  const bankStart = parseInstant(`${coverage.coveredFrom}T00:00:00.000Z`);
  const bankEnd = parseInstant(`${nextUtcDate(coverage.coveredThrough)}T00:00:00.000Z`);
  const startInclusive =
    context.historyCoverage.startInclusive > bankStart
      ? context.historyCoverage.startInclusive
      : bankStart;
  const endExclusive =
    context.historyCoverage.endExclusive < bankEnd ? context.historyCoverage.endExclusive : bankEnd;
  const fullyCovered =
    bankStart <= context.historyCoverage.startInclusive &&
    bankEnd >= context.historyCoverage.endExclusive;
  return Object.freeze({
    ...context,
    ...(startInclusive < endExclusive
      ? { historyCoverage: Object.freeze({ startInclusive, endExclusive }) }
      : {}),
    quality: fullyCovered
      ? context.quality
      : Object.freeze({ ...context.quality, spendingClassification: 'partial' as const }),
  });
}

function decisionHistoryStart(profile: Readonly<Record<string, unknown>>): Instant | null {
  const value = profile['decisionHistoryBoundary'];
  if (value === undefined) return null;
  const boundary = record(value);
  if (boundary['source'] !== 'owner_confirmed' || typeof boundary['startInclusive'] !== 'string') {
    throw new DataInvariantError(
      'assembly.invalid_decision_history_boundary',
      'The persisted decision history boundary is invalid.',
    );
  }
  return parseInstant(boundary['startInclusive']);
}

function currentAtDecisionBoundary(
  current: FinancialEngineInput['current'],
  startInclusive: Instant,
  endExclusive: Instant,
): FinancialEngineInput['current'] {
  if (startInclusive >= endExclusive) {
    throw new DataInvariantError(
      'assembly.invalid_decision_history_period',
      'Decision history start must be earlier than the run boundary.',
    );
  }
  const historyCoverage = Object.freeze({ startInclusive, endExclusive });
  const reservationCoverage = Object.freeze({
    startInclusive,
    endExclusive: parseInstant(new Date(new Date(endExclusive).getTime() + 1).toISOString()),
  });
  return Object.freeze({
    ...current,
    historyCoverage,
    reservationCoverage,
  });
}

function canonicalAtDecisionBoundary(
  canonical: FinancialEngineInput['canonical'],
  startInclusive: Instant,
): FinancialEngineInput['canonical'] {
  const economicFlows = canonical.economicFlows.filter(
    (item) => compareInstants(item.effectiveAt, startInclusive) >= 0,
  );
  const economicFlowIds = new Set(economicFlows.map((item) => item.id));
  const transactionInstants = new Map(
    canonical.transactions.map((item) => [item.id, item.effectiveAt]),
  );
  return Object.freeze({
    ...canonical,
    economicFlows: Object.freeze(economicFlows),
    ambiguities: Object.freeze(
      canonical.ambiguities.filter(
        (item) => compareInstants(item.effectiveAt, startInclusive) >= 0,
      ),
    ),
    spendingObservations: Object.freeze(
      canonical.spendingObservations.filter((item) => economicFlowIds.has(item.economicFlowId)),
    ),
    primarySalaryTriggers: Object.freeze(
      canonical.primarySalaryTriggers.filter((item) => {
        const effectiveAt = transactionInstants.get(item.transactionId);
        return effectiveAt !== undefined && compareInstants(effectiveAt, startInclusive) >= 0;
      }),
    ),
  });
}

export async function assembleFinancialEngineInput(
  db: Database,
  request: FinancialEngineAssemblyRequest,
): Promise<FinancialEngineAssemblyResult> {
  const asOf = parseInstant(request.asOf);
  const effectiveDate = parseLocalDate(request.effectiveDate);
  if (rigaDateOfInstant(asOf) !== effectiveDate) {
    throw new DataInvariantError(
      'assembly.run_boundary_mismatch',
      'effectiveDate must equal the Europe/Riga date containing asOf.',
    );
  }

  return db.transaction(
    async (tx) => {
      const parts = await loadEvaluationParts(tx, request.ownerId);
      if (parts.inputVersion !== request.expectedInputVersion) {
        return Object.freeze({
          status: 'superseded' as const,
          expectedInputVersion: request.expectedInputVersion,
          loadedInputVersion: parts.inputVersion,
        });
      }
      const loadedCanonical = await loadCanonicalFacts(tx, request.ownerId);
      const bankReconciliation = await loadLatestEnableBankingReconciliation(
        tx,
        request.ownerId,
        asOf,
      );
      const bankReconciliations = await loadLatestEnableBankingReconciliationsByAccount(
        tx,
        request.ownerId,
        asOf,
      );
      const bankCoverage = await loadMergedEnableBankingCoverage(tx, request.ownerId, asOf);
      const settingsHistory = Object.freeze(parts.settingsHistory.map(hydrateV1Settings));
      const settingsVersion = effectiveSettingsVersion(settingsHistory, effectiveDate);
      const effectiveSettings = settingsHistory.find(
        (settings) => settings.version === settingsVersion,
      );
      if (effectiveSettings === undefined) {
        throw new DataInvariantError(
          'assembly.missing_effective_settings',
          'The selected settings version is missing from settings history.',
        );
      }
      const profile = parts.profile;
      const boundaryStart = decisionHistoryStart(profile);
      const sourceWatermark = profile['sourceInputWatermark'];
      const inputWatermark =
        request.cause === 'synthetic_import' &&
        request.expectedInputVersion === 1n &&
        typeof sourceWatermark === 'string'
          ? sourceWatermark
          : `owner:${request.ownerId}:v${request.expectedInputVersion.toString()}`;
      const boundaryCurrent =
        boundaryStart === null
          ? (parts.current as FinancialEngineInput['current'])
          : currentAtDecisionBoundary(
              parts.current as FinancialEngineInput['current'],
              boundaryStart,
              asOf,
            );
      const persistedCurrent = applyBankCoverage(boundaryCurrent, bankCoverage.at(-1));
      const reconciledCurrent =
        bankReconciliation === null || bankReconciliation.status === 'reconciled'
          ? persistedCurrent
          : Object.freeze({
              ...persistedCurrent,
              quality: Object.freeze({
                ...persistedCurrent.quality,
                liquidBalance:
                  bankReconciliation.status === 'unavailable' ? 'unavailable' : 'partial',
              }),
            });
      const canonical =
        boundaryStart === null
          ? loadedCanonical
          : canonicalAtDecisionBoundary(loadedCanonical, boundaryStart);
      const evidenceCurrent = deriveEvidenceBackedCurrentContext({
        current: reconciledCurrent,
        canonical,
        bankCoverage,
        bankReconciliations,
        asOf,
        effectiveDate,
        settingsVersion,
        engineVersion: String(profile['engineVersion']),
        inputWatermark,
      });
      const current = deriveRunPlanningContext(
        evidenceCurrent,
        effectiveDate,
        effectiveSettings.liquidity.unknownIncomeHorizonDays,
      );
      const ccrPeriod =
        boundaryStart === null ? profile['ccrPeriod'] : persistedCurrent.historyCoverage;
      const input = Object.freeze({
        run: Object.freeze({
          asOf,
          effectiveDate,
          engineVersion: profile['engineVersion'],
          settingsVersion,
          inputWatermark,
        }),
        settingsHistory,
        canonical,
        current,
        historicalCheckpoints: parts.historicalCheckpoints,
        ccrPeriod,
        rollingCcrPeriods: profile['rollingCcrPeriods'],
        forwardProjection: profile['forwardProjection'],
        recurringPlanId: profile['recurringPlanId'],
        currentRecurringContribution: profile['currentRecurringContribution'],
        lastIssuedStepUpCycleIds: profile['lastIssuedStepUpCycleIds'],
        forecastPlan: profile['forecastPlan'],
      } as FinancialEngineInput);
      return Object.freeze({
        status: 'ready' as const,
        expectedInputVersion: request.expectedInputVersion,
        loadedInputVersion: parts.inputVersion,
        input,
      });
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
