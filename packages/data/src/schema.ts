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
    processedAt: instant('processed_at'),
  },
  (table) => [
    primaryKey({ columns: [table.sourceKey, table.updateId] }),
    uniqueIndex('telegram_message_identity_uq')
      .on(table.sourceKey, table.chatId, table.messageId)
      .where(sql`${table.messageId} is not null`),
    index('telegram_updates_claim_idx').on(table.sourceKey, table.status, table.receivedAt),
    index('telegram_updates_owner_idx').on(table.ownerId, table.receivedAt),
    check(
      'telegram_update_status_ck',
      sql`${table.status} in ('received','processing','awaiting_clarification','completed','rejected','unsupported','failed','expired')`,
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
