import { and, asc, eq } from 'drizzle-orm';

import type { Database } from './database.js';
import { DataConflictError, DataInvariantError } from './errors.js';
import { canonicalDatabaseInstant } from './financial-facts.js';
import { encodeSourceJson } from './json-codec.js';
import type { CommandMutationResult } from './commands.js';
import {
  accounts,
  evaluationProfiles,
  financialTransactions,
  ownerInputVersions,
  planningContexts,
  settingsVersions,
} from './schema.js';
import { generateUuidV7 } from './uuid-v7.js';

type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export const CURRENT_FINANCIAL_ENGINE_VERSION = 'stage2g.1.0';

export type EvaluationProfileBootstrapInput = Readonly<{
  asOf: string;
  effectiveDate: string;
  reason: string;
}>;

function validLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export async function bootstrapConservativeEvaluationProfile(
  tx: DatabaseTransaction,
  ownerId: string,
  input: EvaluationProfileBootstrapInput,
): Promise<CommandMutationResult> {
  const asOf = canonicalDatabaseInstant(input.asOf);
  if (!validLocalDate(input.effectiveDate)) {
    throw new DataInvariantError(
      'engine_profile.invalid_effective_date',
      'Engine profile effective date must use YYYY-MM-DD.',
    );
  }
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 500) {
    throw new DataInvariantError(
      'engine_profile.invalid_reason',
      'Engine profile bootstrap requires a reason of at most 500 characters.',
    );
  }

  const existingProfile = await tx.query.evaluationProfiles.findFirst({
    where: eq(evaluationProfiles.ownerId, ownerId),
  });
  const existingContext = await tx.query.planningContexts.findFirst({
    where: eq(planningContexts.ownerId, ownerId),
  });
  if (existingProfile !== undefined || existingContext !== undefined) {
    throw new DataConflictError(
      'engine_profile.already_initialized',
      'The owner already has an evaluation profile or planning context.',
    );
  }

  const account = await tx.query.accounts.findFirst({ where: eq(accounts.ownerId, ownerId) });
  const earliestTransaction = await tx.query.financialTransactions.findFirst({
    where: eq(financialTransactions.ownerId, ownerId),
    orderBy: [asc(financialTransactions.createdAt)],
  });
  const currentSettings = await tx.query.settingsVersions.findFirst({
    where: and(eq(settingsVersions.ownerId, ownerId), eq(settingsVersions.isCurrent, true)),
  });
  const currentVersion = await tx.query.ownerInputVersions.findFirst({
    where: eq(ownerInputVersions.ownerId, ownerId),
  });
  if (account === undefined || earliestTransaction === undefined) {
    throw new DataInvariantError(
      'engine_profile.canonical_state_required',
      'Engine profile bootstrap requires an owner-scoped canonical account and transaction.',
    );
  }
  if (currentSettings === undefined) {
    throw new DataInvariantError(
      'engine_profile.current_settings_required',
      'Engine profile bootstrap requires one current settings version.',
    );
  }
  if (currentVersion === undefined) {
    throw new DataInvariantError(
      'command.missing_owner_version',
      'Owner input version is missing.',
    );
  }

  const startInclusive = canonicalDatabaseInstant(earliestTransaction.createdAt);
  if (startInclusive >= asOf) {
    throw new DataInvariantError(
      'engine_profile.invalid_history_window',
      'The bootstrap time must be after the earliest canonical transaction.',
    );
  }

  const recurringPlanId = generateUuidV7('recurring-investment-plan');
  const nextVersion = currentVersion.version + 1n;
  const period = Object.freeze({ startInclusive, endExclusive: asOf });
  const current = Object.freeze({
    monthCoverage: Object.freeze([]),
    scheduledRecurring: Object.freeze([]),
    recurringScheduleComplete: false,
    operationalNeeds: Object.freeze([]),
    futureObligations: Object.freeze([]),
    otherRestrictedCash: Object.freeze([]),
    nextReliableIncomeDate: null,
    expectedPrimaryPaySchedule: Object.freeze({
      dates: Object.freeze([]),
      completeThrough: input.effectiveDate,
    }),
    historyCoverage: period,
    reservationCoverage: period,
    quality: Object.freeze({
      liquidityInputs: Object.freeze({
        operationalNeeds: 'unavailable',
        obligations: 'unavailable',
        restrictedCash: 'unavailable',
      }),
      liquidBalance: 'unavailable',
      spendingClassification: 'unavailable',
      reservationHistory: 'unavailable',
    }),
  });
  const profilePayload = Object.freeze({
    sourceInputWatermark: `owner:${ownerId}:v${nextVersion.toString()}`,
    ccrPeriod: period,
    rollingCcrPeriods: Object.freeze([]),
    forwardProjection: Object.freeze({
      cashFlows: Object.freeze([]),
      protectionDays: Object.freeze([]),
      coverage: Object.freeze({
        expectedPrimarySalary: 'unavailable',
        normalSpending: 'unavailable',
        committedObligations: 'unavailable',
        sinkingProtection: 'unavailable',
      }),
      contributionSchedule: Object.freeze({
        planId: recurringPlanId,
        occurrences: Object.freeze([]),
        completeThrough: input.effectiveDate,
      }),
    }),
    recurringPlanId,
    currentRecurringContribution: Object.freeze({ amountMinor: 0n, currency: 'EUR' }),
    lastIssuedStepUpCycleIds: null,
    forecastPlan: Object.freeze({
      capitalFlows: Object.freeze([]),
      plannedExpenses: Object.freeze([]),
      includedOptionalExpenseIds: Object.freeze([]),
    }),
  });

  await tx.insert(planningContexts).values({
    ownerId,
    kind: 'current',
    checkpointKey: 'current',
    effectiveAt: asOf,
    payload: encodeSourceJson(current),
  });
  await tx.insert(evaluationProfiles).values({
    ownerId,
    asOf,
    effectiveDate: input.effectiveDate,
    engineVersion: CURRENT_FINANCIAL_ENGINE_VERSION,
    settingsVersion: currentSettings.version,
    payload: encodeSourceJson(profilePayload),
    updatedAt: asOf,
  });

  return Object.freeze({
    entityType: 'evaluation_profile',
    entityId: ownerId,
    earliestAffectedAt: startInclusive,
    result: Object.freeze({
      engineVersion: CURRENT_FINANCIAL_ENGINE_VERSION,
      settingsVersion: currentSettings.version,
      recurringPlanId,
      historyStartInclusive: startInclusive,
      conservativeCompleteness: true,
      reason,
    }),
  });
}
