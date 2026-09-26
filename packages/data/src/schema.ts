import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const instant = (name: string) =>
  timestamp(name, { mode: 'string', withTimezone: true, precision: 6 });
const money = (name: string) => bigint(name, { mode: 'bigint' });

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  loginName: text('login_name').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  locale: text('locale').notNull().default('en'),
  timeZone: text('time_zone').notNull().default('Europe/Riga'),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    csrfHash: text('csrf_hash').notNull(),
    createdAt: instant('created_at').notNull(),
    expiresAt: instant('expires_at').notNull(),
    lastUsedAt: instant('last_used_at').notNull(),
    revokedAt: instant('revoked_at'),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_uq').on(table.tokenHash),
    index('sessions_owner_idx').on(table.ownerId),
  ],
);

export const loginAttempts = pgTable('login_attempts', {
  loginKey: text('login_key').primaryKey(),
  failureCount: integer('failure_count').notNull().default(0),
  windowStartedAt: instant('window_started_at').notNull(),
  blockedUntil: instant('blocked_until'),
  updatedAt: instant('updated_at').notNull(),
});

export const commandRecords = pgTable(
  'command_records',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status').notNull(),
    result: jsonb('result'),
    createdAt: instant('created_at').notNull(),
    completedAt: instant('completed_at'),
  },
  (table) => [
    uniqueIndex('command_owner_kind_key_uq').on(table.ownerId, table.kind, table.idempotencyKey),
    check('command_status_ck', sql`${table.status} in ('processing','completed','failed')`),
  ],
);

export const ownerInputVersions = pgTable('owner_input_versions', {
  ownerId: uuid('owner_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  version: bigint('version', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),
  updatedAt: instant('updated_at').notNull(),
});

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    commandId: uuid('command_id'),
    eventKind: text('event_kind').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    occurredAt: instant('occurred_at').notNull(),
  },
  (table) => [index('audit_owner_time_idx').on(table.ownerId, table.occurredAt)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind').notNull(),
    valueSource: text('value_source').notNull(),
    currency: text('currency').notNull(),
    payload: jsonb('payload').notNull(),
  },
  (table) => [uniqueIndex('accounts_owner_id_uq').on(table.ownerId, table.id)],
);

export const financialTransactions = pgTable(
  'financial_transactions',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [uniqueIndex('transactions_owner_id_uq').on(table.ownerId, table.id)],
);

export const transactionVersions = pgTable(
  'transaction_versions',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => financialTransactions.id),
    revision: integer('revision').notNull(),
    kind: text('kind').notNull(),
    bookingStatus: text('booking_status').notNull(),
    effectiveAt: instant('effective_at').notNull(),
    payload: jsonb('payload').notNull(),
    isCurrent: boolean('is_current').notNull().default(true),
    supersededAt: instant('superseded_at'),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.transactionId, table.revision] }),
    uniqueIndex('transaction_one_current_uq')
      .on(table.ownerId, table.transactionId)
      .where(sql`${table.isCurrent}`),
    index('transaction_effective_idx').on(table.ownerId, table.effectiveAt),
  ],
);

export const accountEntries = pgTable(
  'account_entries',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => financialTransactions.id),
    transactionRevision: integer('transaction_revision').notNull(),
    entryId: uuid('entry_id').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    amountMinor: money('amount_minor').notNull(),
    currency: text('currency').notNull(),
    role: text('role').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.ownerId, table.transactionId, table.transactionRevision, table.entryId],
    }),
    index('entries_account_idx').on(table.ownerId, table.accountId),
  ],
);

export const economicFlows = pgTable(
  'economic_flows',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => financialTransactions.id),
    effectiveAt: instant('effective_at').notNull(),
    amountMinor: money('amount_minor').notNull(),
    currency: text('currency').notNull(),
  },
  (table) => [uniqueIndex('economic_flows_owner_id_uq').on(table.ownerId, table.id)],
);

export const flowClassifications = pgTable(
  'flow_classifications',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    flowId: uuid('flow_id')
      .notNull()
      .references(() => economicFlows.id),
    revision: integer('revision').notNull(),
    kind: text('kind').notNull(),
    source: text('source').notNull(),
    reason: text('reason'),
    payload: jsonb('payload').notNull(),
    decidedAt: instant('decided_at').notNull(),
    isCurrent: boolean('is_current').notNull().default(true),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.flowId, table.revision] }),
    uniqueIndex('flow_classification_current_uq')
      .on(table.ownerId, table.flowId)
      .where(sql`${table.isCurrent}`),
  ],
);

export const flowAmbiguities = pgTable(
  'flow_ambiguities',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => financialTransactions.id),
    kind: text('kind').notNull(),
    materiality: text('materiality').notNull(),
    status: text('status').notNull().default('unresolved'),
    evidence: jsonb('evidence').notNull().default({}),
    effectiveAt: instant('effective_at').notNull(),
    resolvedAt: instant('resolved_at'),
    resolver: text('resolver'),
    reason: text('reason'),
  },
  (table) => [
    uniqueIndex('ambiguity_owner_id_uq').on(table.ownerId, table.id),
    check(
      'ambiguity_status_ck',
      sql`${table.status} in ('unresolved','confirmed_transfer','rejected_transfer')`,
    ),
  ],
);

export const factPayloads = pgTable(
  'fact_payloads',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    factType: text('fact_type').notNull(),
    factId: text('fact_id').notNull(),
    effectiveAt: instant('effective_at'),
    payload: jsonb('payload').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.factType, table.factId] }),
    index('fact_type_idx').on(table.ownerId, table.factType),
  ],
);

export const accountBalanceSnapshots = pgTable(
  'account_balance_snapshots',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    accountId: uuid('account_id').notNull(),
    sourceAsOf: instant('source_as_of').notNull(),
    receivedAt: instant('received_at').notNull(),
    staleAt: instant('stale_at').notNull(),
    reportabilityStatus: text('reportability_status').notNull(),
    originalAmountMinor: money('original_amount_minor').notNull(),
    originalCurrency: text('original_currency').notNull(),
    reportingAmountMinor: money('reporting_amount_minor'),
    reportingCurrency: text('reporting_currency'),
    fxRateId: uuid('fx_rate_id'),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.accountId, table.sourceAsOf] }),
    index('balance_snapshots_owner_time_idx').on(table.ownerId, table.sourceAsOf),
    check(
      'balance_snapshot_reportability_ck',
      sql`(${table.reportabilityStatus} = 'available' and ${table.reportingAmountMinor} is not null and ${table.reportingCurrency} is not null) or (${table.reportabilityStatus} = 'missing_fx' and ${table.reportingAmountMinor} is null and ${table.reportingCurrency} is null and ${table.fxRateId} is null)`,
    ),
  ],
);

export const portfolioValuations = pgTable(
  'portfolio_valuations',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    accountId: uuid('account_id').notNull(),
    sourceAsOf: instant('source_as_of').notNull(),
    receivedAt: instant('received_at').notNull(),
    staleAt: instant('stale_at').notNull(),
    reportabilityStatus: text('reportability_status').notNull(),
    originalAmountMinor: money('original_amount_minor').notNull(),
    originalCurrency: text('original_currency').notNull(),
    reportingAmountMinor: money('reporting_amount_minor'),
    reportingCurrency: text('reporting_currency'),
    fxRateId: uuid('fx_rate_id'),
    brokerageCashTreatment: text('brokerage_cash_treatment').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.accountId, table.sourceAsOf] }),
    index('portfolio_valuations_owner_time_idx').on(table.ownerId, table.sourceAsOf),
    check(
      'portfolio_valuation_reportability_ck',
      sql`(${table.reportabilityStatus} = 'available' and ${table.reportingAmountMinor} is not null and ${table.reportingCurrency} is not null) or (${table.reportabilityStatus} = 'missing_fx' and ${table.reportingAmountMinor} is null and ${table.reportingCurrency} is null and ${table.fxRateId} is null)`,
    ),
    check(
      'portfolio_valuation_cash_treatment_ck',
      sql`${table.brokerageCashTreatment} in ('included_in_market_value','separate_account')`,
    ),
  ],
);

export const investmentContributions = pgTable(
  'investment_contributions',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    transactionId: uuid('transaction_id').notNull(),
    investmentAccountId: uuid('investment_account_id').notNull(),
    principalMinor: money('principal_minor').notNull(),
    currency: text('currency').notNull(),
    effectiveAt: instant('effective_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.transactionId] }),
    index('investment_contributions_owner_time_idx').on(table.ownerId, table.effectiveAt),
    check('investment_contribution_positive_ck', sql`${table.principalMinor} > 0`),
  ],
);

export const contributionAttributions = pgTable(
  'contribution_attributions',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    transactionId: uuid('transaction_id').notNull(),
    kind: text('kind').notNull(),
    planId: uuid('plan_id'),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.transactionId] }),
    check(
      'contribution_attribution_shape_ck',
      sql`(${table.kind} = 'recurring_plan' and ${table.planId} is not null) or (${table.kind} = 'ad_hoc' and ${table.planId} is null)`,
    ),
  ],
);

export const primarySalaryTriggers = pgTable(
  'primary_salary_triggers',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    transactionId: uuid('transaction_id').notNull(),
    effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.transactionId] }),
    index('primary_salary_triggers_owner_date_idx').on(table.ownerId, table.effectiveDate),
  ],
);

export const spendingObservations = pgTable(
  'spending_observations',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    economicFlowId: uuid('economic_flow_id').notNull(),
    economicDate: date('economic_date', { mode: 'string' }).notNull(),
    categoryId: uuid('category_id').notNull(),
    necessity: text('necessity').notNull(),
    cadence: text('cadence').notNull(),
    irregular: boolean('irregular').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.economicFlowId] }),
    index('spending_observations_owner_date_idx').on(table.ownerId, table.economicDate),
    check(
      'spending_observation_necessity_ck',
      sql`${table.necessity} in ('essential','discretionary')`,
    ),
    check('spending_observation_cadence_ck', sql`${table.cadence} in ('recurring','variable')`),
  ],
);

export const sinkingFunds = pgTable(
  'sinking_funds',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    targetMinor: money('target_minor').notNull(),
    currency: text('currency').notNull(),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    priority: integer('priority').notNull(),
    status: text('status').notNull(),
    allocationPolicy: text('allocation_policy').notNull(),
    createdAt: instant('created_at').notNull(),
    payload: jsonb('payload').notNull(),
  },
  (table) => [uniqueIndex('sinking_funds_owner_id_uq').on(table.ownerId, table.id)],
);

export const sinkingEvents = pgTable(
  'sinking_events',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    fundId: uuid('fund_id')
      .notNull()
      .references(() => sinkingFunds.id),
    kind: text('kind').notNull(),
    amountMinor: money('amount_minor').notNull(),
    currency: text('currency').notNull(),
    effectiveAt: instant('effective_at').notNull(),
    relatedTransactionId: uuid('related_transaction_id'),
    commandId: uuid('command_id'),
    payload: jsonb('payload').notNull(),
  },
  (table) => [
    uniqueIndex('sinking_events_owner_id_uq').on(table.ownerId, table.id),
    index('sinking_events_fund_time_idx').on(table.ownerId, table.fundId, table.effectiveAt),
  ],
);

export const cashReconciliations = pgTable(
  'cash_reconciliations',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    adjustmentTransactionId: uuid('adjustment_transaction_id')
      .notNull()
      .references(() => financialTransactions.id),
    calculatedMinor: money('calculated_minor').notNull(),
    countedMinor: money('counted_minor').notNull(),
    varianceMinor: money('variance_minor').notNull(),
    currency: text('currency').notNull(),
    materiality: text('materiality').notNull(),
    reconciledAt: instant('reconciled_at').notNull(),
    payload: jsonb('payload').notNull(),
  },
  (table) => [uniqueIndex('cash_reconciliations_owner_id_uq').on(table.ownerId, table.id)],
);

export const cashReconciliationResolutions = pgTable(
  'cash_reconciliation_resolutions',
  {
    reconciliationId: uuid('reconciliation_id')
      .primaryKey()
      .references(() => cashReconciliations.id),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind').notNull(),
    resolutionTransactionId: uuid('resolution_transaction_id')
      .notNull()
      .references(() => financialTransactions.id),
    resolvedAt: instant('resolved_at').notNull(),
    payload: jsonb('payload').notNull(),
  },
  (table) => [
    check(
      'reconciliation_resolution_kind_ck',
      sql`${table.kind} in ('reclassified_adjustment','reversed_adjustment')`,
    ),
  ],
);

export const settingsVersions = pgTable(
  'settings_versions',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    version: text('version').notNull(),
    effectiveFrom: instant('effective_from').notNull(),
    payload: jsonb('payload').notNull(),
    isCurrent: boolean('is_current').notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.version] }),
    uniqueIndex('settings_current_uq')
      .on(table.ownerId)
      .where(sql`${table.isCurrent}`),
  ],
);

export const planningContexts = pgTable(
  'planning_contexts',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind').notNull(),
    checkpointKey: text('checkpoint_key').notNull(),
    effectiveAt: instant('effective_at'),
    payload: jsonb('payload').notNull(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.kind, table.checkpointKey] })],
);

export const evaluationProfiles = pgTable('evaluation_profiles', {
  ownerId: uuid('owner_id')
    .primaryKey()
    .references(() => users.id),
  asOf: instant('as_of').notNull(),
  effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
  engineVersion: text('engine_version').notNull(),
  settingsVersion: text('settings_version').notNull(),
  payload: jsonb('payload').notNull(),
  updatedAt: instant('updated_at').notNull(),
});

export const recalculationRecords = pgTable(
  'recalculation_records',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    inputVersion: bigint('input_version', { mode: 'bigint' }).notNull(),
    cause: text('cause').notNull(),
    earliestAffectedAt: instant('earliest_affected_at'),
    status: text('status').notNull(),
    jobId: text('job_id'),
    createdAt: instant('created_at').notNull(),
    completedAt: instant('completed_at'),
    failureCategory: text('failure_category'),
    failureMessage: text('failure_message'),
  },
  (table) => [
    uniqueIndex('recalculation_owner_version_cause_uq').on(
      table.ownerId,
      table.inputVersion,
      table.cause,
    ),
    index('recalculation_owner_time_idx').on(table.ownerId, table.createdAt),
    check(
      'recalculation_status_ck',
      sql`${table.status} in ('queued','running','completed','failed','superseded')`,
    ),
  ],
);

export const telegramOwnerLinks = pgTable(
  'telegram_owner_links',
  {
    sourceKey: text('source_key').notNull(),
    telegramUserId: bigint('telegram_user_id', { mode: 'bigint' }).notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceKey, table.telegramUserId] }),
    uniqueIndex('telegram_owner_source_owner_uq').on(table.sourceKey, table.ownerId),
  ],
);

export const telegramPollState = pgTable('telegram_poll_state', {
  sourceKey: text('source_key').primaryKey(),
  nextOffset: bigint('next_offset', { mode: 'bigint' }),
  lastPolledAt: instant('last_polled_at'),
  lastErrorCategory: text('last_error_category'),
  updatedAt: instant('updated_at').notNull(),
});

export const telegramUpdates = pgTable(
  'telegram_updates',
  {
    sourceKey: text('source_key').notNull(),
    updateId: bigint('update_id', { mode: 'bigint' }).notNull(),
    ownerId: uuid('owner_id').references(() => users.id),
    chatId: bigint('chat_id', { mode: 'bigint' }),
    senderId: bigint('sender_id', { mode: 'bigint' }),
    messageId: bigint('message_id', { mode: 'bigint' }),
    replyToMessageId: bigint('reply_to_message_id', { mode: 'bigint' }),
    updateType: text('update_type').notNull(),
    messageDate: instant('message_date'),
    messageText: text('message_text'),
    textHash: text('text_hash'),
    locale: text('locale'),
    status: text('status').notNull(),
    parserOutcome: text('parser_outcome'),
    proposalKind: text('proposal_kind'),
    commandId: uuid('command_id').references(() => commandRecords.id),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    safeErrorCategory: text('safe_error_category'),
    attemptCount: integer('attempt_count').notNull().default(0),
    receivedAt: instant('received_at').notNull(),
    processingStartedAt: instant('processing_started_at'),
    nextProcessingAttemptAt: instant('next_processing_attempt_at'),
    processedAt: instant('processed_at'),
  },
  (table) => [
    primaryKey({ columns: [table.sourceKey, table.updateId] }),
    uniqueIndex('telegram_message_identity_uq')
      .on(table.sourceKey, table.chatId, table.messageId)
      .where(sql`${table.messageId} is not null`),
    index('telegram_updates_claim_idx').on(
      table.sourceKey,
      table.status,
      table.nextProcessingAttemptAt,
      table.processingStartedAt,
      table.updateId,
    ),
    index('telegram_updates_owner_idx').on(table.ownerId, table.receivedAt),
    check(
      'telegram_update_status_ck',
      sql`${table.status} in ('received','processing','retryable','awaiting_clarification','completed','rejected','unsupported','failed','expired')`,
    ),
    check(
      'telegram_update_retry_at_ck',
      sql`(${table.status} = 'retryable' and ${table.nextProcessingAttemptAt} is not null) or (${table.status} <> 'retryable' and ${table.nextProcessingAttemptAt} is null)`,
    ),
  ],
);

export const telegramPendingClarifications = pgTable(
  'telegram_pending_clarifications',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    sourceKey: text('source_key').notNull(),
    chatId: bigint('chat_id', { mode: 'bigint' }).notNull(),
    senderId: bigint('sender_id', { mode: 'bigint' }).notNull(),
    originUpdateId: bigint('origin_update_id', { mode: 'bigint' }).notNull(),
    originMessageId: bigint('origin_message_id', { mode: 'bigint' }).notNull(),
    proposalKind: text('proposal_kind').notNull(),
    missingField: text('missing_field').notNull(),
    knownFields: jsonb('known_fields'),
    locale: text('locale').notNull(),
    invalidAttempts: integer('invalid_attempts').notNull().default(0),
    status: text('status').notNull(),
    createdAt: instant('created_at').notNull(),
    expiresAt: instant('expires_at').notNull(),
    resolvedAt: instant('resolved_at'),
    resolvedByUpdateId: bigint('resolved_by_update_id', { mode: 'bigint' }),
  },
  (table) => [
    uniqueIndex('telegram_one_active_clarification_uq')
      .on(table.ownerId, table.sourceKey, table.chatId)
      .where(sql`${table.status} = 'active'`),
    index('telegram_clarification_expiry_idx').on(table.status, table.expiresAt),
    check(
      'telegram_clarification_status_ck',
      sql`${table.status} in ('active','resolved','cancelled','expired','superseded')`,
    ),
  ],
);

export const telegramDeliveries = pgTable(
  'telegram_deliveries',
  {
    id: uuid('id').primaryKey(),
    sourceKey: text('source_key').notNull(),
    ownerId: uuid('owner_id').references(() => users.id),
    updateId: bigint('update_id', { mode: 'bigint' }).notNull(),
    chatId: bigint('chat_id', { mode: 'bigint' }).notNull(),
    replyToMessageId: bigint('reply_to_message_id', { mode: 'bigint' }),
    purpose: text('purpose').notNull(),
    responseText: text('response_text'),
    status: text('status').notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    botMessageId: bigint('bot_message_id', { mode: 'bigint' }),
    safeErrorCategory: text('safe_error_category'),
    nextAttemptAt: instant('next_attempt_at'),
    createdAt: instant('created_at').notNull(),
    completedAt: instant('completed_at'),
  },
  (table) => [
    uniqueIndex('telegram_delivery_update_purpose_uq').on(
      table.sourceKey,
      table.updateId,
      table.purpose,
    ),
    index('telegram_delivery_pending_idx').on(table.sourceKey, table.status, table.nextAttemptAt),
    check(
      'telegram_delivery_status_ck',
      sql`${table.status} in ('pending','sending','retryable','sent','failed','uncertain')`,
    ),
  ],
);

export const telegramMessageLinks = pgTable(
  'telegram_message_links',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    sourceKey: text('source_key').notNull(),
    chatId: bigint('chat_id', { mode: 'bigint' }).notNull(),
    userMessageId: bigint('user_message_id', { mode: 'bigint' }).notNull(),
    botMessageId: bigint('bot_message_id', { mode: 'bigint' }),
    updateId: bigint('update_id', { mode: 'bigint' }).notNull(),
    commandId: uuid('command_id')
      .notNull()
      .references(() => commandRecords.id),
    proposalKind: text('proposal_kind').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    status: text('status').notNull(),
    supersededBy: uuid('superseded_by'),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('telegram_link_user_message_uq').on(
      table.sourceKey,
      table.chatId,
      table.userMessageId,
    ),
    uniqueIndex('telegram_link_bot_message_uq')
      .on(table.sourceKey, table.chatId, table.botMessageId)
      .where(sql`${table.botMessageId} is not null`),
    index('telegram_link_owner_time_idx').on(table.ownerId, table.createdAt),
    check('telegram_link_status_ck', sql`${table.status} in ('current','superseded','cancelled')`),
  ],
);

export const telegramIntegrationStatus = pgTable('telegram_integration_status', {
  name: text('name').primaryKey(),
  enabled: boolean('enabled').notNull(),
  sourceKey: text('source_key'),
  status: text('status').notNull(),
  lastProcessedUpdateId: bigint('last_processed_update_id', { mode: 'bigint' }),
  lastProcessedAt: instant('last_processed_at'),
  lastErrorCategory: text('last_error_category'),
  updatedAt: instant('updated_at').notNull(),
});

export const engineRuns = pgTable(
  'engine_runs',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    inputVersion: bigint('input_version', { mode: 'bigint' }).notNull(),
    asOf: instant('as_of').notNull(),
    effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
    engineVersion: text('engine_version').notNull(),
    settingsVersion: text('settings_version').notNull(),
    inputWatermark: text('input_watermark').notNull(),
    trigger: text('trigger').notNull(),
    earliestAffectedAt: instant('earliest_affected_at'),
    startedAt: instant('started_at').notNull(),
    completedAt: instant('completed_at'),
    status: text('status').notNull(),
    failureCategory: text('failure_category'),
    failureMessage: text('failure_message'),
    resultPayload: jsonb('result_payload'),
  },
  (table) => [
    uniqueIndex('engine_run_identity_uq').on(
      table.ownerId,
      table.inputVersion,
      table.engineVersion,
      table.settingsVersion,
      table.asOf,
    ),
    index('engine_run_latest_idx').on(table.ownerId, table.completedAt),
    check('engine_run_status_ck', sql`${table.status} in ('running','completed','failed')`),
  ],
);

export const metricSnapshots = pgTable(
  'metric_snapshots',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    engineRunId: uuid('engine_run_id')
      .notNull()
      .references(() => engineRuns.id),
    metricKind: text('metric_kind').notNull(),
    periodKey: text('period_key').notNull().default('current'),
    status: text('status').notNull(),
    payload: jsonb('payload').notNull(),
    asOf: instant('as_of').notNull(),
    engineVersion: text('engine_version').notNull(),
    settingsVersion: text('settings_version').notNull(),
    inputWatermark: text('input_watermark').notNull(),
    createdAt: instant('created_at').notNull(),
    isAuthoritative: boolean('is_authoritative').notNull().default(true),
    supersededBy: uuid('superseded_by'),
  },
  (table) => [
    uniqueIndex('metric_authoritative_uq')
      .on(table.ownerId, table.metricKind, table.periodKey)
      .where(sql`${table.isAuthoritative}`),
    index('metric_run_idx').on(table.engineRunId),
  ],
);

export const derivedPayCycles = pgTable(
  'derived_pay_cycles',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    engineRunId: uuid('engine_run_id')
      .notNull()
      .references(() => engineRuns.id),
    cycleId: uuid('cycle_id').notNull(),
    openingSalaryTransactionId: uuid('opening_salary_transaction_id').notNull(),
    closingSalaryTransactionId: uuid('closing_salary_transaction_id'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endExclusive: instant('end_exclusive'),
    status: text('status').notNull(),
    payload: jsonb('payload').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.engineRunId, table.cycleId] }),
    index('pay_cycles_owner_idx').on(table.ownerId, table.startDate),
  ],
);

export const sinkingRequirements = pgTable(
  'sinking_requirements',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    engineRunId: uuid('engine_run_id')
      .notNull()
      .references(() => engineRuns.id),
    fundId: uuid('fund_id')
      .notNull()
      .references(() => sinkingFunds.id),
    cycleId: uuid('cycle_id'),
    requiredMinor: money('required_minor').notNull(),
    satisfiedMinor: money('satisfied_minor').notNull(),
    outstandingMinor: money('outstanding_minor').notNull(),
    reservedMinor: money('reserved_minor').notNull(),
    protectedMinor: money('protected_minor').notNull(),
    currency: text('currency').notNull(),
    payload: jsonb('payload').notNull(),
    isAuthoritative: boolean('is_authoritative').notNull().default(true),
    supersededBy: uuid('superseded_by'),
  },
  (table) => [
    uniqueIndex('sinking_requirement_authoritative_uq')
      .on(table.ownerId, table.fundId)
      .where(sql`${table.isAuthoritative}`),
  ],
);

export const exactRateExamples = pgTable('exact_rate_examples', {
  id: uuid('id').primaryKey(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  value: numeric('value', { mode: 'string' }).notNull(),
});

export const sharesightSyncStates = pgTable(
  'sharesight_sync_states',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    providerPortfolioId: text('provider_portfolio_id').notNull(),
    investmentAccountId: uuid('investment_account_id')
      .notNull()
      .references(() => accounts.id),
    connectionId: text('connection_id').notNull(),
    leaseId: uuid('lease_id'),
    leaseExpiresAt: instant('lease_expires_at'),
    activeRunId: uuid('active_run_id'),
    lastSuccessfulSyncAt: instant('last_successful_sync_at'),
    lastFailureCategory: text('last_failure_category'),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.providerPortfolioId] }),
    uniqueIndex('sharesight_connection_id_uq').on(table.connectionId),
    check(
      'sharesight_sync_lease_shape_ck',
      sql`(${table.leaseId} is null and ${table.leaseExpiresAt} is null) or (${table.leaseId} is not null and ${table.leaseExpiresAt} is not null)`,
    ),
  ],
);

export const sharesightSyncRuns = pgTable(
  'sharesight_sync_runs',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    providerPortfolioId: text('provider_portfolio_id').notNull(),
    status: text('status').notNull(),
    scanFrom: date('scan_from', { mode: 'string' }),
    scanTo: date('scan_to', { mode: 'string' }),
    continuation: jsonb('continuation'),
    counts: jsonb('counts').notNull().default({}),
    sourceFreshness: text('source_freshness').notNull().default('unconfirmed'),
    startedAt: instant('started_at').notNull(),
    completedAt: instant('completed_at'),
    failureCategory: text('failure_category'),
  },
  (table) => [
    index('sharesight_sync_runs_owner_started_idx').on(table.ownerId, table.startedAt),
    check(
      'sharesight_sync_run_status_ck',
      sql`${table.status} in ('running','completed','failed')`,
    ),
    check(
      'sharesight_sync_run_completion_ck',
      sql`(${table.status} = 'running' and ${table.completedAt} is null) or (${table.status} <> 'running' and ${table.completedAt} is not null)`,
    ),
  ],
);

export const sharesightRawReceipts = pgTable(
  'sharesight_raw_receipts',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => sharesightSyncRuns.id),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    providerPortfolioId: text('provider_portfolio_id').notNull(),
    capability: text('capability').notNull(),
    requestKey: text('request_key').notNull(),
    requestFrom: date('request_from', { mode: 'string' }),
    requestTo: date('request_to', { mode: 'string' }),
    receivedAt: instant('received_at').notNull(),
    payloadSha256: text('payload_sha256').notNull(),
    payloadCiphertext: text('payload_ciphertext'),
    payloadIv: text('payload_iv'),
    payloadAuthTag: text('payload_auth_tag'),
    payloadExpiresAt: instant('payload_expires_at').notNull(),
    status: text('status').notNull(),
    normalizationVersion: text('normalization_version').notNull(),
    sourceIds: jsonb('source_ids').notNull().default([]),
    revisionIds: jsonb('revision_ids').notNull().default([]),
    failureCategory: text('failure_category'),
    processedAt: instant('processed_at'),
  },
  (table) => [
    index('sharesight_receipt_run_request_idx').on(table.runId, table.requestKey),
    index('sharesight_receipt_pending_idx').on(table.ownerId, table.status, table.receivedAt),
    index('sharesight_receipt_expiry_idx').on(table.payloadExpiresAt),
    check(
      'sharesight_receipt_status_ck',
      sql`${table.status} in ('received','normalized','quarantined','failed')`,
    ),
    check(
      'sharesight_receipt_ciphertext_shape_ck',
      sql`(${table.payloadCiphertext} is null and ${table.payloadIv} is null and ${table.payloadAuthTag} is null) or (${table.payloadCiphertext} is not null and ${table.payloadIv} is not null and ${table.payloadAuthTag} is not null)`,
    ),
  ],
);

export const sharesightSourceRevisions = pgTable(
  'sharesight_source_revisions',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    sourceId: text('source_id').notNull(),
    revisionSha256: text('revision_sha256').notNull(),
    recordKind: text('record_kind').notNull(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => sharesightRawReceipts.id),
    firstSeenAt: instant('first_seen_at').notNull(),
    lastSeenAt: instant('last_seen_at').notNull(),
    isCurrent: boolean('is_current').notNull().default(true),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.sourceId, table.revisionSha256] }),
    uniqueIndex('sharesight_source_current_uq')
      .on(table.ownerId, table.sourceId)
      .where(sql`${table.isCurrent}`),
    index('sharesight_source_receipt_idx').on(table.receiptId),
  ],
);

export const portfolioProviderBindings = pgTable(
  'portfolio_provider_bindings',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    investmentAccountId: uuid('investment_account_id')
      .notNull()
      .references(() => accounts.id),
    provider: text('provider').notNull(),
    connectionId: text('connection_id').notNull(),
    providerInstanceId: text('provider_instance_id'),
    providerPortfolioId: text('provider_portfolio_id'),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.investmentAccountId] }),
    uniqueIndex('portfolio_provider_connection_uq').on(table.provider, table.connectionId),
    check(
      'portfolio_provider_binding_provider_ck',
      sql`${table.provider} in ('sharesight','portfolio-manager')`,
    ),
    check(
      'portfolio_provider_identity_shape_ck',
      sql`(${table.providerInstanceId} is null and ${table.providerPortfolioId} is null) or (${table.providerInstanceId} is not null and ${table.providerPortfolioId} is not null)`,
    ),
  ],
);

export const portfolioManagerSyncStates = pgTable(
  'portfolio_manager_sync_states',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    connectionId: text('connection_id').notNull(),
    investmentAccountId: uuid('investment_account_id')
      .notNull()
      .references(() => accounts.id),
    checkpoint: text('checkpoint'),
    leaseId: uuid('lease_id'),
    leaseExpiresAt: instant('lease_expires_at'),
    activeRunId: uuid('active_run_id'),
    lastSuccessfulSyncAt: instant('last_successful_sync_at'),
    lastFailureCategory: text('last_failure_category'),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.connectionId] }),
    uniqueIndex('portfolio_manager_connection_id_uq').on(table.connectionId),
    check(
      'portfolio_manager_sync_lease_shape_ck',
      sql`(${table.leaseId} is null and ${table.leaseExpiresAt} is null) or (${table.leaseId} is not null and ${table.leaseExpiresAt} is not null)`,
    ),
  ],
);

export const portfolioManagerSyncRuns = pgTable(
  'portfolio_manager_sync_runs',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    connectionId: text('connection_id').notNull(),
    status: text('status').notNull(),
    startingCursor: text('starting_cursor'),
    continuationCursor: text('continuation_cursor'),
    counts: jsonb('counts').notNull().default({}),
    sourceCompleteness: text('source_completeness').notNull().default('unavailable'),
    startedAt: instant('started_at').notNull(),
    completedAt: instant('completed_at'),
    failureCategory: text('failure_category'),
  },
  (table) => [
    index('portfolio_manager_runs_owner_started_idx').on(table.ownerId, table.startedAt),
    check(
      'portfolio_manager_run_status_ck',
      sql`${table.status} in ('running','completed','failed')`,
    ),
    check(
      'portfolio_manager_run_completion_ck',
      sql`(${table.status} = 'running' and ${table.completedAt} is null) or (${table.status} <> 'running' and ${table.completedAt} is not null)`,
    ),
    check(
      'portfolio_manager_run_completeness_ck',
      sql`${table.sourceCompleteness} in ('complete','partial','unavailable')`,
    ),
  ],
);

export const portfolioManagerRawReceipts = pgTable(
  'portfolio_manager_raw_receipts',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => portfolioManagerSyncRuns.id),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    connectionId: text('connection_id').notNull(),
    endpoint: text('endpoint').notNull(),
    requestKey: text('request_key').notNull(),
    requestCursor: text('request_cursor'),
    responseCursor: text('response_cursor'),
    receivedAt: instant('received_at').notNull(),
    payloadSha256: text('payload_sha256').notNull(),
    payloadCiphertext: text('payload_ciphertext'),
    payloadIv: text('payload_iv'),
    payloadAuthTag: text('payload_auth_tag'),
    payloadExpiresAt: instant('payload_expires_at').notNull(),
    status: text('status').notNull(),
    normalizationVersion: text('normalization_version').notNull(),
    sourceIds: jsonb('source_ids').notNull().default([]),
    revisionIds: jsonb('revision_ids').notNull().default([]),
    failureCategory: text('failure_category'),
    processedAt: instant('processed_at'),
  },
  (table) => [
    index('portfolio_manager_receipt_run_request_idx').on(table.runId, table.requestKey),
    index('portfolio_manager_receipt_pending_idx').on(
      table.ownerId,
      table.connectionId,
      table.status,
      table.receivedAt,
    ),
    index('portfolio_manager_receipt_expiry_idx').on(table.payloadExpiresAt),
    check(
      'portfolio_manager_receipt_endpoint_ck',
      sql`${table.endpoint} in ('capabilities','snapshot','capital_flows')`,
    ),
    check(
      'portfolio_manager_receipt_status_ck',
      sql`${table.status} in ('received','normalized','quarantined','failed')`,
    ),
    check(
      'portfolio_manager_receipt_ciphertext_shape_ck',
      sql`(${table.payloadCiphertext} is null and ${table.payloadIv} is null and ${table.payloadAuthTag} is null) or (${table.payloadCiphertext} is not null and ${table.payloadIv} is not null and ${table.payloadAuthTag} is not null)`,
    ),
  ],
);

export const portfolioManagerSourceRevisions = pgTable(
  'portfolio_manager_source_revisions',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    connectionId: text('connection_id').notNull(),
    sourceId: text('source_id').notNull(),
    revisionSha256: text('revision_sha256').notNull(),
    recordKind: text('record_kind').notNull(),
    providerRevisionId: text('provider_revision_id'),
    providerStatus: text('provider_status'),
    changedAt: instant('changed_at'),
    replacesRevisionId: text('replaces_revision_id'),
    replacementRevisionIds: jsonb('replacement_revision_ids').notNull().default([]),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => portfolioManagerRawReceipts.id),
    firstSeenAt: instant('first_seen_at').notNull(),
    lastSeenAt: instant('last_seen_at').notNull(),
    isCurrent: boolean('is_current').notNull().default(true),
  },
  (table) => [
    primaryKey({
      columns: [table.ownerId, table.connectionId, table.sourceId, table.revisionSha256],
    }),
    uniqueIndex('portfolio_manager_source_current_uq')
      .on(table.ownerId, table.connectionId, table.sourceId)
      .where(sql`${table.isCurrent}`),
    index('portfolio_manager_source_receipt_idx').on(table.receiptId),
    check(
      'portfolio_manager_source_status_ck',
      sql`${table.providerStatus} is null or ${table.providerStatus} in ('ACTIVE','REPLACED','VOIDED')`,
    ),
  ],
);

export const enableBankingConnections = pgTable(
  'enable_banking_connections',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    generation: uuid('generation').notNull(),
    status: text('status').notNull(),
    applicationIdHash: text('application_id_hash').notNull(),
    sessionIdCiphertext: text('session_id_ciphertext'),
    sessionIdIv: text('session_id_iv'),
    sessionIdAuthTag: text('session_id_auth_tag'),
    sessionGeneration: uuid('session_generation'),
    consentExpiresAt: instant('consent_expires_at'),
    activeRunId: uuid('active_run_id'),
    leaseId: uuid('lease_id'),
    leaseExpiresAt: instant('lease_expires_at'),
    lastFailureCategory: text('last_failure_category'),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('enable_banking_connection_owner_uq').on(table.ownerId),
    uniqueIndex('enable_banking_connection_generation_uq').on(table.generation),
    check(
      'enable_banking_connection_status_ck',
      sql`${table.status} in ('disconnected','connecting','active','reauth_required','error','revoked')`,
    ),
    check(
      'enable_banking_session_ciphertext_shape_ck',
      sql`(${table.sessionIdCiphertext} is null and ${table.sessionIdIv} is null and ${table.sessionIdAuthTag} is null and ${table.sessionGeneration} is null and ${table.consentExpiresAt} is null) or (${table.sessionIdCiphertext} is not null and ${table.sessionIdIv} is not null and ${table.sessionIdAuthTag} is not null and ${table.sessionGeneration} is not null and ${table.consentExpiresAt} is not null)`,
    ),
    check(
      'enable_banking_connection_lease_shape_ck',
      sql`(${table.activeRunId} is null and ${table.leaseId} is null and ${table.leaseExpiresAt} is null) or (${table.activeRunId} is not null and ${table.leaseId} is not null and ${table.leaseExpiresAt} is not null)`,
    ),
  ],
);

export const enableBankingRuns = pgTable(
  'enable_banking_runs',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => enableBankingConnections.id),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    strategy: text('strategy'),
    sessionGeneration: uuid('session_generation'),
    providerAccountId: uuid('provider_account_id'),
    continuationCiphertext: text('continuation_ciphertext'),
    continuationIv: text('continuation_iv'),
    continuationAuthTag: text('continuation_auth_tag'),
    continuationHash: text('continuation_hash'),
    counts: jsonb('counts').notNull().default({}),
    coverageFrom: date('coverage_from'),
    coverageThrough: date('coverage_through'),
    startedAt: instant('started_at').notNull(),
    completedAt: instant('completed_at'),
    failureCategory: text('failure_category'),
  },
  (table) => [
    index('enable_banking_runs_owner_started_idx').on(table.ownerId, table.startedAt),
    check(
      'enable_banking_run_kind_ck',
      sql`${table.kind} in ('authorization','diagnostic_fetch','sync','disconnect')`,
    ),
    check(
      'enable_banking_run_status_ck',
      sql`${table.status} in ('pending','running','completed','failed','indeterminate')`,
    ),
    check(
      'enable_banking_run_continuation_shape_ck',
      sql`(${table.continuationCiphertext} is null and ${table.continuationIv} is null and ${table.continuationAuthTag} is null and ${table.continuationHash} is null) or (${table.continuationCiphertext} is not null and ${table.continuationIv} is not null and ${table.continuationAuthTag} is not null and ${table.continuationHash} is not null)`,
    ),
  ],
);

export const enableBankingAuthorizationAttempts = pgTable(
  'enable_banking_authorization_attempts',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => enableBankingConnections.id),
    runId: uuid('run_id')
      .notNull()
      .references(() => enableBankingRuns.id),
    stateHash: text('state_hash').notNull(),
    status: text('status').notNull(),
    expiresAt: instant('expires_at').notNull(),
    claimedAt: instant('claimed_at'),
    completedAt: instant('completed_at'),
    failureCategory: text('failure_category'),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('enable_banking_authorization_state_uq').on(table.stateHash),
    index('enable_banking_authorization_owner_status_idx').on(table.ownerId, table.status),
    check(
      'enable_banking_authorization_status_ck',
      sql`${table.status} in ('pending','exchanging','completed','cancelled','failed','expired','indeterminate')`,
    ),
  ],
);

export const enableBankingProviderAccounts = pgTable(
  'enable_banking_provider_accounts',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => enableBankingConnections.id),
    stableAccountKey: text('stable_account_key').notNull(),
    identificationHashCiphertext: text('identification_hash_ciphertext').notNull(),
    identificationHashIv: text('identification_hash_iv').notNull(),
    identificationHashAuthTag: text('identification_hash_auth_tag').notNull(),
    accountUidCiphertext: text('account_uid_ciphertext'),
    accountUidIv: text('account_uid_iv'),
    accountUidAuthTag: text('account_uid_auth_tag'),
    displayHintCiphertext: text('display_hint_ciphertext'),
    displayHintIv: text('display_hint_iv'),
    displayHintAuthTag: text('display_hint_auth_tag'),
    sessionGeneration: uuid('session_generation'),
    currency: text('currency').notNull(),
    canonicalAccountId: uuid('canonical_account_id').references(() => accounts.id),
    identityVerifiedAt: instant('identity_verified_at'),
    transactionIdentityVerifiedAt: instant('transaction_identity_verified_at'),
    ownerActivatedAt: instant('owner_activated_at'),
    observedAt: instant('observed_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('enable_banking_provider_account_identity_uq').on(
      table.ownerId,
      table.stableAccountKey,
    ),
    uniqueIndex('enable_banking_provider_account_binding_uq')
      .on(table.ownerId, table.canonicalAccountId)
      .where(sql`${table.canonicalAccountId} is not null`),
    index('enable_banking_provider_account_connection_idx').on(table.connectionId),
    check(
      'enable_banking_display_hint_shape_ck',
      sql`(${table.displayHintCiphertext} is null and ${table.displayHintIv} is null and ${table.displayHintAuthTag} is null) or (${table.displayHintCiphertext} is not null and ${table.displayHintIv} is not null and ${table.displayHintAuthTag} is not null)`,
    ),
    check(
      'enable_banking_account_uid_shape_ck',
      sql`(${table.accountUidCiphertext} is null and ${table.accountUidIv} is null and ${table.accountUidAuthTag} is null and ${table.sessionGeneration} is null) or (${table.accountUidCiphertext} is not null and ${table.accountUidIv} is not null and ${table.accountUidAuthTag} is not null and ${table.sessionGeneration} is not null)`,
    ),
  ],
);

export const enableBankingRawReceipts = pgTable(
  'enable_banking_raw_receipts',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => enableBankingRuns.id),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => enableBankingConnections.id),
    endpoint: text('endpoint').notNull(),
    method: text('method').notNull(),
    requestKey: text('request_key').notNull(),
    requestCursorHash: text('request_cursor_hash'),
    httpStatus: integer('http_status').notNull(),
    receivedAt: instant('received_at').notNull(),
    payloadSha256: text('payload_sha256').notNull(),
    payloadCiphertext: text('payload_ciphertext'),
    payloadIv: text('payload_iv'),
    payloadAuthTag: text('payload_auth_tag'),
    payloadExpiresAt: instant('payload_expires_at').notNull(),
    status: text('status').notNull(),
    normalizationVersion: text('normalization_version').notNull(),
    sourceIds: jsonb('source_ids').notNull().default([]),
    revisionIds: jsonb('revision_ids').notNull().default([]),
    failureCategory: text('failure_category'),
    processedAt: instant('processed_at'),
  },
  (table) => [
    index('enable_banking_receipt_run_idx').on(table.runId, table.receivedAt),
    index('enable_banking_receipt_pending_idx').on(
      table.ownerId,
      table.connectionId,
      table.status,
      table.receivedAt,
    ),
    index('enable_banking_receipt_expiry_idx').on(table.payloadExpiresAt),
    check(
      'enable_banking_receipt_endpoint_ck',
      sql`${table.endpoint} in ('aspsps','authorization','session_exchange','session','account_details','balances','transactions','disconnect')`,
    ),
    check('enable_banking_receipt_method_ck', sql`${table.method} in ('GET','POST','DELETE')`),
    check(
      'enable_banking_receipt_status_ck',
      sql`${table.status} in ('received','normalized','quarantined','failed')`,
    ),
    check(
      'enable_banking_receipt_ciphertext_shape_ck',
      sql`(${table.payloadCiphertext} is null and ${table.payloadIv} is null and ${table.payloadAuthTag} is null) or (${table.payloadCiphertext} is not null and ${table.payloadIv} is not null and ${table.payloadAuthTag} is not null)`,
    ),
  ],
);

export const enableBankingSourceRevisions = pgTable(
  'enable_banking_source_revisions',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => enableBankingConnections.id),
    providerAccountId: uuid('provider_account_id')
      .notNull()
      .references(() => enableBankingProviderAccounts.id),
    sourceKey: text('source_key').notNull(),
    revisionSha256: text('revision_sha256').notNull(),
    recordKind: text('record_kind').notNull(),
    providerStatus: text('provider_status'),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => enableBankingRawReceipts.id),
    firstSeenAt: instant('first_seen_at').notNull(),
    lastSeenAt: instant('last_seen_at').notNull(),
    isCurrent: boolean('is_current').notNull().default(true),
  },
  (table) => [
    primaryKey({
      columns: [table.ownerId, table.connectionId, table.sourceKey, table.revisionSha256],
    }),
    uniqueIndex('enable_banking_source_current_uq')
      .on(table.ownerId, table.connectionId, table.sourceKey)
      .where(sql`${table.isCurrent}`),
    index('enable_banking_source_receipt_idx').on(table.receiptId),
    check(
      'enable_banking_source_kind_ck',
      sql`${table.recordKind} in ('account','balance','transaction')`,
    ),
  ],
);

export const enableBankingSyncStates = pgTable(
  'enable_banking_sync_states',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => enableBankingConnections.id),
    providerAccountId: uuid('provider_account_id')
      .primaryKey()
      .references(() => enableBankingProviderAccounts.id),
    sessionGeneration: uuid('session_generation').notNull(),
    initialScanComplete: boolean('initial_scan_complete').notNull().default(false),
    lastStrategy: text('last_strategy'),
    lastCompletedAt: instant('last_completed_at'),
    nextScheduledAt: instant('next_scheduled_at'),
  },
  (table) => [
    uniqueIndex('enable_banking_sync_state_owner_connection_uq').on(
      table.ownerId,
      table.connectionId,
    ),
    check(
      'enable_banking_sync_state_strategy_ck',
      sql`${table.lastStrategy} is null or ${table.lastStrategy} in ('longest','default')`,
    ),
  ],
);

export const enableBankingTransactionObservations = pgTable(
  'enable_banking_transaction_observations',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => enableBankingConnections.id),
    providerAccountId: uuid('provider_account_id')
      .notNull()
      .references(() => enableBankingProviderAccounts.id),
    sourceKey: text('source_key'),
    revisionSha256: text('revision_sha256').notNull(),
    providerStatus: text('provider_status').notNull(),
    direction: text('direction').notNull(),
    amountMinor: money('amount_minor').notNull(),
    currency: text('currency').notNull(),
    bookingDate: date('booking_date'),
    valueDate: date('value_date'),
    transactionDate: date('transaction_date'),
    bankCodeHash: text('bank_code_hash'),
    counterpartyHash: text('counterparty_hash'),
    referenceHash: text('reference_hash'),
    canonicalization: text('canonicalization').notNull(),
    ambiguityKind: text('ambiguity_kind').notNull(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => enableBankingRawReceipts.id),
    observedAt: instant('observed_at').notNull(),
    isCurrent: boolean('is_current').notNull().default(true),
  },
  (table) => [
    uniqueIndex('enable_banking_transaction_observation_revision_uq').on(
      table.ownerId,
      table.connectionId,
      table.revisionSha256,
    ),
    uniqueIndex('enable_banking_transaction_observation_current_uq')
      .on(table.ownerId, table.connectionId, table.sourceKey)
      .where(sql`${table.isCurrent} and ${table.sourceKey} is not null`),
    index('enable_banking_transaction_observation_account_date_idx').on(
      table.ownerId,
      table.providerAccountId,
      table.bookingDate,
    ),
    check(
      'enable_banking_transaction_observation_status_ck',
      sql`${table.providerStatus} in ('booked','cancelled','hold','other','pending','rejected','scheduled')`,
    ),
    check(
      'enable_banking_transaction_observation_direction_ck',
      sql`${table.direction} in ('credit','debit')`,
    ),
    check(
      'enable_banking_transaction_observation_canonicalization_ck',
      sql`${table.canonicalization} in ('eligible_booked','pending_projection_only','terminal_observation_only','quarantined_unstable_identity')`,
    ),
    check(
      'enable_banking_transaction_observation_ambiguity_ck',
      sql`${table.ambiguityKind} in ('unclassified_external_flow','unresolved_transfer')`,
    ),
  ],
);

export const enableBankingBalanceObservations = pgTable(
  'enable_banking_balance_observations',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => enableBankingConnections.id),
    providerAccountId: uuid('provider_account_id')
      .notNull()
      .references(() => enableBankingProviderAccounts.id),
    revisionSha256: text('revision_sha256').notNull(),
    balanceKind: text('balance_kind').notNull(),
    amountMinor: money('amount_minor').notNull(),
    currency: text('currency').notNull(),
    sourceAsOf: instant('source_as_of').notNull(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => enableBankingRawReceipts.id),
    observedAt: instant('observed_at').notNull(),
  },
  (table) => [
    uniqueIndex('enable_banking_balance_observation_revision_uq').on(
      table.ownerId,
      table.connectionId,
      table.revisionSha256,
    ),
    index('enable_banking_balance_observation_account_time_idx').on(
      table.ownerId,
      table.providerAccountId,
      table.sourceAsOf,
    ),
  ],
);

export const enableBankingHistoryCoverage = pgTable(
  'enable_banking_history_coverage',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => enableBankingConnections.id),
    providerAccountId: uuid('provider_account_id')
      .notNull()
      .references(() => enableBankingProviderAccounts.id),
    sessionGeneration: uuid('session_generation').notNull(),
    coveredFrom: date('covered_from').notNull(),
    coveredThrough: date('covered_through').notNull(),
    completedAt: instant('completed_at').notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => enableBankingRuns.id),
  },
  (table) => [
    uniqueIndex('enable_banking_history_coverage_run_uq').on(table.runId),
    index('enable_banking_history_coverage_account_idx').on(
      table.ownerId,
      table.providerAccountId,
      table.coveredFrom,
      table.coveredThrough,
    ),
    check(
      'enable_banking_history_coverage_order_ck',
      sql`${table.coveredFrom} <= ${table.coveredThrough}`,
    ),
  ],
);

export const enableBankingCanonicalImports = pgTable(
  'enable_banking_canonical_imports',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => enableBankingConnections.id),
    sourceKey: text('source_key').notNull(),
    revisionSha256: text('revision_sha256').notNull(),
    canonicalTransactionId: uuid('canonical_transaction_id')
      .notNull()
      .references(() => financialTransactions.id),
    commandId: uuid('command_id')
      .notNull()
      .references(() => commandRecords.id),
    disposition: text('disposition').notNull(),
    supersedesImportId: uuid('supersedes_import_id'),
    effectiveAt: instant('effective_at').notNull(),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('enable_banking_canonical_import_revision_uq').on(
      table.ownerId,
      table.connectionId,
      table.sourceKey,
      table.revisionSha256,
    ),
    index('enable_banking_canonical_import_transaction_idx').on(
      table.ownerId,
      table.canonicalTransactionId,
    ),
    check(
      'enable_banking_canonical_import_disposition_ck',
      sql`${table.disposition} in ('imported','corrected','cancelled')`,
    ),
  ],
);

export const enableBankingObservationMatches = pgTable(
  'enable_banking_observation_matches',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => enableBankingConnections.id),
    leftObservationId: uuid('left_observation_id')
      .notNull()
      .references(() => enableBankingTransactionObservations.id),
    rightObservationId: uuid('right_observation_id')
      .notNull()
      .references(() => enableBankingTransactionObservations.id),
    kind: text('kind').notNull(),
    state: text('state').notNull(),
    reason: text('reason').notNull(),
    createdAt: instant('created_at').notNull(),
    resolvedAt: instant('resolved_at'),
  },
  (table) => [
    uniqueIndex('enable_banking_observation_match_pair_uq').on(
      table.ownerId,
      table.leftObservationId,
      table.rightObservationId,
      table.kind,
    ),
    check(
      'enable_banking_observation_match_kind_ck',
      sql`${table.kind} in ('pending_booked','bank_to_cash','investment_transfer','internal_transfer','refund','reimbursement')`,
    ),
    check(
      'enable_banking_observation_match_state_ck',
      sql`${table.state} in ('candidate','confirmed','rejected')`,
    ),
  ],
);

export const enableBankingBalanceReconciliations = pgTable(
  'enable_banking_balance_reconciliations',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => enableBankingConnections.id),
    providerAccountId: uuid('provider_account_id')
      .notNull()
      .references(() => enableBankingProviderAccounts.id),
    canonicalAccountId: uuid('canonical_account_id')
      .notNull()
      .references(() => accounts.id),
    runId: uuid('run_id')
      .notNull()
      .references(() => enableBankingRuns.id),
    sourceAsOf: instant('source_as_of'),
    providerBalanceMinor: money('provider_balance_minor'),
    canonicalBalanceMinor: money('canonical_balance_minor'),
    differenceMinor: money('difference_minor'),
    currency: text('currency').notNull(),
    materialityThresholdMinor: money('materiality_threshold_minor').notNull(),
    status: text('status').notNull(),
    createdAt: instant('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('enable_banking_balance_reconciliation_run_uq').on(table.runId),
    index('enable_banking_balance_reconciliation_account_time_idx').on(
      table.ownerId,
      table.canonicalAccountId,
      table.createdAt,
    ),
    check(
      'enable_banking_balance_reconciliation_status_ck',
      sql`${table.status} in ('reconciled','provider_stale','incomplete_history','unresolved_pending','material_mismatch','unavailable')`,
    ),
  ],
);
