import {
  DataInvariantError,
  loadCanonicalFacts,
  loadEvaluationParts,
  loadLatestEnableBankingReconciliation,
  loadMergedEnableBankingCoverage,
} from '@personal-cfo/data';
import type { Database, RecalculationCause } from '@personal-cfo/data';
import {
  EUR,
  createExactFraction,
  createMoney,
  parseInstant,
  parseLocalDate,
} from '@personal-cfo/domain';
import {
  DEFAULT_FORECAST_SETTINGS,
  DEFAULT_INVESTMENT_STEP_SETTINGS,
} from '@personal-cfo/financial-engine';
import type { FinancialEngineInput, FinancialEngineSettings } from '@personal-cfo/financial-engine';

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
      const canonical = await loadCanonicalFacts(tx, request.ownerId);
      const bankReconciliation = await loadLatestEnableBankingReconciliation(
        tx,
        request.ownerId,
        asOf,
      );
      const bankCoverage = await loadMergedEnableBankingCoverage(tx, request.ownerId, asOf);
      const settingsHistory = Object.freeze(parts.settingsHistory.map(hydrateV1Settings));
      const settingsVersion = effectiveSettingsVersion(settingsHistory, effectiveDate);
      const profile = parts.profile;
      const sourceWatermark = profile['sourceInputWatermark'];
      const inputWatermark =
        request.cause === 'synthetic_import' &&
        request.expectedInputVersion === 1n &&
        typeof sourceWatermark === 'string'
          ? sourceWatermark
          : `owner:${request.ownerId}:v${request.expectedInputVersion.toString()}`;
      const persistedCurrent = applyBankCoverage(
        parts.current as FinancialEngineInput['current'],
        bankCoverage.at(-1),
      );
      const current =
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
        ccrPeriod: profile['ccrPeriod'],
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
