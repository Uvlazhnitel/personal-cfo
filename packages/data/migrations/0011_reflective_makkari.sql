CREATE TABLE "enable_banking_balance_observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"revision_sha256" text NOT NULL,
	"balance_kind" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"source_as_of" timestamp(6) with time zone NOT NULL,
	"receipt_id" uuid NOT NULL,
	"observed_at" timestamp(6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enable_banking_balance_reconciliations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"canonical_account_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source_as_of" timestamp(6) with time zone,
	"provider_balance_minor" bigint,
	"canonical_balance_minor" bigint,
	"difference_minor" bigint,
	"currency" text NOT NULL,
	"materiality_threshold_minor" bigint NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp(6) with time zone NOT NULL,
	CONSTRAINT "enable_banking_balance_reconciliation_status_ck" CHECK ("enable_banking_balance_reconciliations"."status" in ('reconciled','provider_stale','incomplete_history','unresolved_pending','material_mismatch','unavailable'))
);
--> statement-breakpoint
CREATE TABLE "enable_banking_canonical_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"revision_sha256" text NOT NULL,
	"canonical_transaction_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"disposition" text NOT NULL,
	"supersedes_import_id" uuid,
	"effective_at" timestamp(6) with time zone NOT NULL,
	"created_at" timestamp(6) with time zone NOT NULL,
	CONSTRAINT "enable_banking_canonical_import_disposition_ck" CHECK ("enable_banking_canonical_imports"."disposition" in ('imported','corrected','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "enable_banking_history_coverage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"session_generation" uuid NOT NULL,
	"covered_from" date NOT NULL,
	"covered_through" date NOT NULL,
	"completed_at" timestamp(6) with time zone NOT NULL,
	"run_id" uuid NOT NULL,
	CONSTRAINT "enable_banking_history_coverage_order_ck" CHECK ("enable_banking_history_coverage"."covered_from" <= "enable_banking_history_coverage"."covered_through")
);
--> statement-breakpoint
CREATE TABLE "enable_banking_observation_matches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"left_observation_id" uuid NOT NULL,
	"right_observation_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp(6) with time zone NOT NULL,
	"resolved_at" timestamp(6) with time zone,
	CONSTRAINT "enable_banking_observation_match_kind_ck" CHECK ("enable_banking_observation_matches"."kind" in ('pending_booked','bank_to_cash','investment_transfer','internal_transfer','refund','reimbursement')),
	CONSTRAINT "enable_banking_observation_match_state_ck" CHECK ("enable_banking_observation_matches"."state" in ('candidate','confirmed','rejected'))
);
--> statement-breakpoint
CREATE TABLE "enable_banking_sync_states" (
	"owner_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_account_id" uuid PRIMARY KEY NOT NULL,
	"session_generation" uuid NOT NULL,
	"initial_scan_complete" boolean DEFAULT false NOT NULL,
	"last_strategy" text,
	"last_completed_at" timestamp(6) with time zone,
	"next_scheduled_at" timestamp(6) with time zone,
	CONSTRAINT "enable_banking_sync_state_strategy_ck" CHECK ("enable_banking_sync_states"."last_strategy" is null or "enable_banking_sync_states"."last_strategy" in ('longest','default'))
);
--> statement-breakpoint
CREATE TABLE "enable_banking_transaction_observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"source_key" text,
	"revision_sha256" text NOT NULL,
	"provider_status" text NOT NULL,
	"direction" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"booking_date" date,
	"value_date" date,
	"transaction_date" date,
	"bank_code_hash" text,
	"counterparty_hash" text,
	"reference_hash" text,
	"canonicalization" text NOT NULL,
	"ambiguity_kind" text NOT NULL,
	"receipt_id" uuid NOT NULL,
	"observed_at" timestamp(6) with time zone NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	CONSTRAINT "enable_banking_transaction_observation_status_ck" CHECK ("enable_banking_transaction_observations"."provider_status" in ('booked','cancelled','hold','other','pending','rejected','scheduled')),
	CONSTRAINT "enable_banking_transaction_observation_direction_ck" CHECK ("enable_banking_transaction_observations"."direction" in ('credit','debit')),
	CONSTRAINT "enable_banking_transaction_observation_canonicalization_ck" CHECK ("enable_banking_transaction_observations"."canonicalization" in ('eligible_booked','pending_projection_only','terminal_observation_only','quarantined_unstable_identity')),
	CONSTRAINT "enable_banking_transaction_observation_ambiguity_ck" CHECK ("enable_banking_transaction_observations"."ambiguity_kind" in ('unclassified_external_flow','unresolved_transfer'))
);
--> statement-breakpoint
ALTER TABLE "enable_banking_runs" DROP CONSTRAINT "enable_banking_run_kind_ck";--> statement-breakpoint
ALTER TABLE "enable_banking_provider_accounts" ADD COLUMN "identity_verified_at" timestamp(6) with time zone;--> statement-breakpoint
ALTER TABLE "enable_banking_provider_accounts" ADD COLUMN "transaction_identity_verified_at" timestamp(6) with time zone;--> statement-breakpoint
ALTER TABLE "enable_banking_provider_accounts" ADD COLUMN "owner_activated_at" timestamp(6) with time zone;--> statement-breakpoint
ALTER TABLE "enable_banking_balance_observations" ADD CONSTRAINT "enable_banking_balance_observations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_balance_observations" ADD CONSTRAINT "enable_banking_balance_observations_connection_id_enable_banking_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."enable_banking_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_balance_observations" ADD CONSTRAINT "enable_banking_balance_observations_provider_account_id_enable_banking_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."enable_banking_provider_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_balance_observations" ADD CONSTRAINT "enable_banking_balance_observations_receipt_id_enable_banking_raw_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."enable_banking_raw_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_balance_reconciliations" ADD CONSTRAINT "enable_banking_balance_reconciliations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_balance_reconciliations" ADD CONSTRAINT "enable_banking_balance_reconciliations_connection_id_enable_banking_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."enable_banking_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_balance_reconciliations" ADD CONSTRAINT "enable_banking_balance_reconciliations_provider_account_id_enable_banking_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."enable_banking_provider_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_balance_reconciliations" ADD CONSTRAINT "enable_banking_balance_reconciliations_canonical_account_id_accounts_id_fk" FOREIGN KEY ("canonical_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_balance_reconciliations" ADD CONSTRAINT "enable_banking_balance_reconciliations_run_id_enable_banking_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."enable_banking_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_canonical_imports" ADD CONSTRAINT "enable_banking_canonical_imports_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_canonical_imports" ADD CONSTRAINT "enable_banking_canonical_imports_connection_id_enable_banking_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."enable_banking_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_canonical_imports" ADD CONSTRAINT "enable_banking_canonical_imports_canonical_transaction_id_financial_transactions_id_fk" FOREIGN KEY ("canonical_transaction_id") REFERENCES "public"."financial_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_canonical_imports" ADD CONSTRAINT "enable_banking_canonical_imports_command_id_command_records_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."command_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_history_coverage" ADD CONSTRAINT "enable_banking_history_coverage_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_history_coverage" ADD CONSTRAINT "enable_banking_history_coverage_connection_id_enable_banking_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."enable_banking_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_history_coverage" ADD CONSTRAINT "enable_banking_history_coverage_provider_account_id_enable_banking_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."enable_banking_provider_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_history_coverage" ADD CONSTRAINT "enable_banking_history_coverage_run_id_enable_banking_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."enable_banking_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_observation_matches" ADD CONSTRAINT "enable_banking_observation_matches_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_observation_matches" ADD CONSTRAINT "enable_banking_observation_matches_connection_id_enable_banking_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."enable_banking_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_observation_matches" ADD CONSTRAINT "enable_banking_observation_matches_left_observation_id_enable_banking_transaction_observations_id_fk" FOREIGN KEY ("left_observation_id") REFERENCES "public"."enable_banking_transaction_observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_observation_matches" ADD CONSTRAINT "enable_banking_observation_matches_right_observation_id_enable_banking_transaction_observations_id_fk" FOREIGN KEY ("right_observation_id") REFERENCES "public"."enable_banking_transaction_observations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_sync_states" ADD CONSTRAINT "enable_banking_sync_states_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_sync_states" ADD CONSTRAINT "enable_banking_sync_states_connection_id_enable_banking_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."enable_banking_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_sync_states" ADD CONSTRAINT "enable_banking_sync_states_provider_account_id_enable_banking_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."enable_banking_provider_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_transaction_observations" ADD CONSTRAINT "enable_banking_transaction_observations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_transaction_observations" ADD CONSTRAINT "enable_banking_transaction_observations_connection_id_enable_banking_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."enable_banking_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_transaction_observations" ADD CONSTRAINT "enable_banking_transaction_observations_provider_account_id_enable_banking_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."enable_banking_provider_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_transaction_observations" ADD CONSTRAINT "enable_banking_transaction_observations_receipt_id_enable_banking_raw_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."enable_banking_raw_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "enable_banking_balance_observation_revision_uq" ON "enable_banking_balance_observations" USING btree ("owner_id","connection_id","revision_sha256");--> statement-breakpoint
CREATE INDEX "enable_banking_balance_observation_account_time_idx" ON "enable_banking_balance_observations" USING btree ("owner_id","provider_account_id","source_as_of");--> statement-breakpoint
CREATE UNIQUE INDEX "enable_banking_balance_reconciliation_run_uq" ON "enable_banking_balance_reconciliations" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "enable_banking_balance_reconciliation_account_time_idx" ON "enable_banking_balance_reconciliations" USING btree ("owner_id","canonical_account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "enable_banking_canonical_import_revision_uq" ON "enable_banking_canonical_imports" USING btree ("owner_id","connection_id","source_key","revision_sha256");--> statement-breakpoint
CREATE INDEX "enable_banking_canonical_import_transaction_idx" ON "enable_banking_canonical_imports" USING btree ("owner_id","canonical_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enable_banking_history_coverage_run_uq" ON "enable_banking_history_coverage" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "enable_banking_history_coverage_account_idx" ON "enable_banking_history_coverage" USING btree ("owner_id","provider_account_id","covered_from","covered_through");--> statement-breakpoint
CREATE UNIQUE INDEX "enable_banking_observation_match_pair_uq" ON "enable_banking_observation_matches" USING btree ("owner_id","left_observation_id","right_observation_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "enable_banking_sync_state_owner_connection_uq" ON "enable_banking_sync_states" USING btree ("owner_id","connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enable_banking_transaction_observation_revision_uq" ON "enable_banking_transaction_observations" USING btree ("owner_id","connection_id","revision_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "enable_banking_transaction_observation_current_uq" ON "enable_banking_transaction_observations" USING btree ("owner_id","connection_id","source_key") WHERE "enable_banking_transaction_observations"."is_current" and "enable_banking_transaction_observations"."source_key" is not null;--> statement-breakpoint
CREATE INDEX "enable_banking_transaction_observation_account_date_idx" ON "enable_banking_transaction_observations" USING btree ("owner_id","provider_account_id","booking_date");--> statement-breakpoint
ALTER TABLE "enable_banking_runs" ADD CONSTRAINT "enable_banking_run_kind_ck" CHECK ("enable_banking_runs"."kind" in ('authorization','diagnostic_fetch','sync','disconnect'));--> statement-breakpoint
SELECT pgboss.create_queue('open-banking.enable-banking.dispatch', '{"policy":"standard","retryLimit":0,"partition":false}'::jsonb);--> statement-breakpoint
SELECT pgboss.create_queue('open-banking.enable-banking.sync.dead', '{"policy":"standard","retryLimit":0,"partition":false}'::jsonb);--> statement-breakpoint
SELECT pgboss.create_queue('open-banking.enable-banking.sync', '{"policy":"standard","retryLimit":3,"retryDelay":30,"retryBackoff":true,"retryDelayMax":900,"deadLetter":"open-banking.enable-banking.sync.dead","partition":false}'::jsonb);
