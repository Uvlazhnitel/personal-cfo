import { DataInvariantError, loadCanonicalFacts, loadEvaluationParts } from '@personal-cfo/data';
import type { Database, RecalculationCause } from '@personal-cfo/data';
import { parseInstant, parseLocalDate } from '@personal-cfo/domain';
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
      const settingsHistory = parts.settingsHistory as readonly FinancialEngineSettings[];
      const settingsVersion = effectiveSettingsVersion(settingsHistory, effectiveDate);
      const profile = parts.profile;
      const sourceWatermark = profile['sourceInputWatermark'];
      const inputWatermark =
        request.cause === 'synthetic_import' &&
        request.expectedInputVersion === 1n &&
        typeof sourceWatermark === 'string'
          ? sourceWatermark
          : `owner:${request.ownerId}:v${request.expectedInputVersion.toString()}`;
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
        current: parts.current,
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
