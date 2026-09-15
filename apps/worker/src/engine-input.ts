import { loadCanonicalFacts, loadEvaluationParts } from '@personal-cfo/data';
import type { Database } from '@personal-cfo/data';
import type { FinancialEngineInput } from '@personal-cfo/financial-engine';

export async function assembleFinancialEngineInput(
  db: Database,
  ownerId: string,
): Promise<FinancialEngineInput> {
  const [canonical, parts] = await Promise.all([
    loadCanonicalFacts(db, ownerId),
    loadEvaluationParts(db, ownerId),
  ]);
  const profile = parts.profile;
  const inputWatermark =
    parts.inputVersion === 1n && typeof profile['sourceInputWatermark'] === 'string'
      ? profile['sourceInputWatermark']
      : `owner:${ownerId}:v${parts.inputVersion.toString()}`;
  return Object.freeze({
    run: Object.freeze({
      asOf: profile['asOf'],
      effectiveDate: profile['effectiveDate'],
      engineVersion: profile['engineVersion'],
      settingsVersion: profile['settingsVersion'],
      inputWatermark,
    }),
    settingsHistory: parts.settingsHistory,
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
}
