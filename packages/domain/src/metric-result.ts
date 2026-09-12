import type { Completeness } from './completeness.js';
import { parseCompleteness } from './completeness.js';
import { DomainValidationError } from './errors.js';
import type { Instant } from './instant.js';
import { parseInstant } from './instant.js';
import { expectNonEmptyString } from './validation.js';

export type ExplanationComponent = Readonly<{
  ruleId: string;
  inputKey: string;
  value: string;
}>;

export type DataWarning = Readonly<{
  code: string;
  context: Readonly<Record<string, string>>;
}>;

type MetricResultBase = Readonly<{
  asOf: Instant;
  engineVersion: string;
  settingsVersion: string;
  inputWatermark: string;
  explanation: readonly ExplanationComponent[];
  warnings: readonly DataWarning[];
}>;

export type CompleteMetricResult<T> = MetricResultBase &
  Readonly<{
    status: 'complete';
    value: T;
  }>;

export type PartialMetricResult<T> = MetricResultBase &
  Readonly<{
    status: 'partial';
    value: T | null;
  }>;

export type UnavailableMetricResult = MetricResultBase &
  Readonly<{
    status: 'unavailable';
    value: null;
  }>;

export type MetricResult<T> =
  CompleteMetricResult<T> | PartialMetricResult<T> | UnavailableMetricResult;

export type MetricResultDraft<T> = Readonly<{
  value: T | null;
  status: Completeness;
  asOf: Instant;
  engineVersion: string;
  settingsVersion: string;
  inputWatermark: string;
  explanation: readonly ExplanationComponent[];
  warnings: readonly DataWarning[];
}>;

function copyExplanation(
  components: readonly ExplanationComponent[],
): readonly ExplanationComponent[] {
  return Object.freeze(
    components.map((component) =>
      Object.freeze({
        ruleId: expectNonEmptyString(component.ruleId, 'ExplanationComponent.ruleId'),
        inputKey: expectNonEmptyString(component.inputKey, 'ExplanationComponent.inputKey'),
        value: expectNonEmptyString(component.value, 'ExplanationComponent.value'),
      }),
    ),
  );
}

function copyWarningContext(
  context: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const copy: Record<string, string> = {};

  for (const [key, value] of Object.entries(context)) {
    const validatedKey = expectNonEmptyString(key, 'DataWarning.context key');
    copy[validatedKey] = expectNonEmptyString(value, `DataWarning.context.${key}`);
  }

  return Object.freeze(copy);
}

function copyWarnings(warnings: readonly DataWarning[]): readonly DataWarning[] {
  return Object.freeze(
    warnings.map((warning) =>
      Object.freeze({
        code: expectNonEmptyString(warning.code, 'DataWarning.code'),
        context: copyWarningContext(warning.context),
      }),
    ),
  );
}

function metricResultBase<T>(draft: MetricResultDraft<T>): MetricResultBase {
  return {
    asOf: parseInstant(draft.asOf),
    engineVersion: expectNonEmptyString(draft.engineVersion, 'MetricResult.engineVersion'),
    settingsVersion: expectNonEmptyString(draft.settingsVersion, 'MetricResult.settingsVersion'),
    inputWatermark: expectNonEmptyString(draft.inputWatermark, 'MetricResult.inputWatermark'),
    explanation: copyExplanation(draft.explanation),
    warnings: copyWarnings(draft.warnings),
  };
}

export function createMetricResult<T>(draft: MetricResultDraft<T>): MetricResult<T> {
  const status = parseCompleteness(draft.status);
  const base = metricResultBase(draft);

  switch (status) {
    case 'complete':
      if (draft.value === null) {
        throw new DomainValidationError(
          'metric.complete_without_value',
          'A complete metric result must contain a value.',
        );
      }
      return Object.freeze({ ...base, status, value: draft.value });
    case 'partial':
      return Object.freeze({ ...base, status, value: draft.value });
    case 'unavailable':
      if (draft.value !== null) {
        throw new DomainValidationError(
          'metric.unavailable_with_value',
          'An unavailable metric result cannot contain an authoritative value.',
        );
      }
      return Object.freeze({ ...base, status, value: null });
  }
}
