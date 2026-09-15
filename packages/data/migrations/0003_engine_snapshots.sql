CREATE TABLE "derived_pay_cycles" (
	"owner_id" uuid NOT NULL,
	"engine_run_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"opening_salary_transaction_id" uuid NOT NULL,
	"closing_salary_transaction_id" uuid,
	"start_date" date NOT NULL,
	"end_exclusive" timestamp(6) with time zone,
	"status" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "derived_pay_cycles_engine_run_id_cycle_id_pk" PRIMARY KEY("engine_run_id","cycle_id")
);
--> statement-breakpoint
CREATE TABLE "engine_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"input_version" bigint NOT NULL,
	"as_of" timestamp(6) with time zone NOT NULL,
	"effective_date" date NOT NULL,
	"engine_version" text NOT NULL,
	"settings_version" text NOT NULL,
	"input_watermark" text NOT NULL,
	"trigger" text NOT NULL,
	"earliest_affected_at" timestamp(6) with time zone,
	"started_at" timestamp(6) with time zone NOT NULL,
	"completed_at" timestamp(6) with time zone,
	"status" text NOT NULL,
	"failure_category" text,
	"failure_message" text,
	"result_payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "metric_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"engine_run_id" uuid NOT NULL,
	"metric_kind" text NOT NULL,
	"period_key" text DEFAULT 'current' NOT NULL,
	"status" text NOT NULL,
	"payload" jsonb NOT NULL,
	"as_of" timestamp(6) with time zone NOT NULL,
	"engine_version" text NOT NULL,
	"settings_version" text NOT NULL,
	"input_watermark" text NOT NULL,
	"created_at" timestamp(6) with time zone NOT NULL,
	"is_authoritative" boolean DEFAULT true NOT NULL,
	"superseded_by" uuid
);
--> statement-breakpoint
CREATE TABLE "recalculation_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"input_version" bigint NOT NULL,
	"cause" text NOT NULL,
	"earliest_affected_at" timestamp(6) with time zone,
	"status" text NOT NULL,
	"job_id" text,
	"created_at" timestamp(6) with time zone NOT NULL,
	"completed_at" timestamp(6) with time zone,
	"failure_category" text,
	"failure_message" text
);
--> statement-breakpoint
CREATE TABLE "sinking_requirements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"engine_run_id" uuid NOT NULL,
	"fund_id" uuid NOT NULL,
	"cycle_id" uuid,
	"required_minor" bigint NOT NULL,
	"satisfied_minor" bigint NOT NULL,
	"outstanding_minor" bigint NOT NULL,
	"reserved_minor" bigint NOT NULL,
	"protected_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"payload" jsonb NOT NULL,
	"is_authoritative" boolean DEFAULT true NOT NULL,
	"superseded_by" uuid
);
--> statement-breakpoint
ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_transaction_id_financial_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."financial_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_reconciliation_resolutions" ADD CONSTRAINT "cash_reconciliation_resolutions_reconciliation_id_cash_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."cash_reconciliations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_reconciliation_resolutions" ADD CONSTRAINT "cash_reconciliation_resolutions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_reconciliation_resolutions" ADD CONSTRAINT "cash_reconciliation_resolutions_resolution_transaction_id_financial_transactions_id_fk" FOREIGN KEY ("resolution_transaction_id") REFERENCES "public"."financial_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_adjustment_transaction_id_financial_transactions_id_fk" FOREIGN KEY ("adjustment_transaction_id") REFERENCES "public"."financial_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_records" ADD CONSTRAINT "command_records_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derived_pay_cycles" ADD CONSTRAINT "derived_pay_cycles_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "derived_pay_cycles" ADD CONSTRAINT "derived_pay_cycles_engine_run_id_engine_runs_id_fk" FOREIGN KEY ("engine_run_id") REFERENCES "public"."engine_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economic_flows" ADD CONSTRAINT "economic_flows_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economic_flows" ADD CONSTRAINT "economic_flows_transaction_id_financial_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."financial_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engine_runs" ADD CONSTRAINT "engine_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluation_profiles" ADD CONSTRAINT "evaluation_profiles_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exact_rate_examples" ADD CONSTRAINT "exact_rate_examples_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_payloads" ADD CONSTRAINT "fact_payloads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_ambiguities" ADD CONSTRAINT "flow_ambiguities_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_ambiguities" ADD CONSTRAINT "flow_ambiguities_transaction_id_financial_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."financial_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_classifications" ADD CONSTRAINT "flow_classifications_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_classifications" ADD CONSTRAINT "flow_classifications_flow_id_economic_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."economic_flows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_engine_run_id_engine_runs_id_fk" FOREIGN KEY ("engine_run_id") REFERENCES "public"."engine_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_input_versions" ADD CONSTRAINT "owner_input_versions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planning_contexts" ADD CONSTRAINT "planning_contexts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recalculation_records" ADD CONSTRAINT "recalculation_records_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings_versions" ADD CONSTRAINT "settings_versions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sinking_events" ADD CONSTRAINT "sinking_events_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sinking_events" ADD CONSTRAINT "sinking_events_fund_id_sinking_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."sinking_funds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sinking_funds" ADD CONSTRAINT "sinking_funds_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sinking_requirements" ADD CONSTRAINT "sinking_requirements_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sinking_requirements" ADD CONSTRAINT "sinking_requirements_engine_run_id_engine_runs_id_fk" FOREIGN KEY ("engine_run_id") REFERENCES "public"."engine_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sinking_requirements" ADD CONSTRAINT "sinking_requirements_fund_id_sinking_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."sinking_funds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_versions" ADD CONSTRAINT "transaction_versions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_versions" ADD CONSTRAINT "transaction_versions_transaction_id_financial_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."financial_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entries_account_idx" ON "account_entries" USING btree ("owner_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_owner_id_uq" ON "accounts" USING btree ("owner_id","id");--> statement-breakpoint
CREATE INDEX "audit_owner_time_idx" ON "audit_events" USING btree ("owner_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cash_reconciliations_owner_id_uq" ON "cash_reconciliations" USING btree ("owner_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "command_owner_kind_key_uq" ON "command_records" USING btree ("owner_id","kind","idempotency_key");--> statement-breakpoint
CREATE INDEX "pay_cycles_owner_idx" ON "derived_pay_cycles" USING btree ("owner_id","start_date");--> statement-breakpoint
CREATE UNIQUE INDEX "economic_flows_owner_id_uq" ON "economic_flows" USING btree ("owner_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "engine_run_identity_uq" ON "engine_runs" USING btree ("owner_id","input_version","engine_version","settings_version","as_of");--> statement-breakpoint
CREATE INDEX "engine_run_latest_idx" ON "engine_runs" USING btree ("owner_id","completed_at");--> statement-breakpoint
CREATE INDEX "fact_type_idx" ON "fact_payloads" USING btree ("owner_id","fact_type");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_owner_id_uq" ON "financial_transactions" USING btree ("owner_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ambiguity_owner_id_uq" ON "flow_ambiguities" USING btree ("owner_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "flow_classification_current_uq" ON "flow_classifications" USING btree ("owner_id","flow_id") WHERE "flow_classifications"."is_current";--> statement-breakpoint
CREATE UNIQUE INDEX "metric_authoritative_uq" ON "metric_snapshots" USING btree ("owner_id","metric_kind","period_key") WHERE "metric_snapshots"."is_authoritative";--> statement-breakpoint
CREATE INDEX "metric_run_idx" ON "metric_snapshots" USING btree ("engine_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recalculation_owner_version_cause_uq" ON "recalculation_records" USING btree ("owner_id","input_version","cause");--> statement-breakpoint
CREATE INDEX "recalculation_owner_time_idx" ON "recalculation_records" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_owner_idx" ON "sessions" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_current_uq" ON "settings_versions" USING btree ("owner_id") WHERE "settings_versions"."is_current";--> statement-breakpoint
CREATE UNIQUE INDEX "sinking_events_owner_id_uq" ON "sinking_events" USING btree ("owner_id","id");--> statement-breakpoint
CREATE INDEX "sinking_events_fund_time_idx" ON "sinking_events" USING btree ("owner_id","fund_id","effective_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sinking_funds_owner_id_uq" ON "sinking_funds" USING btree ("owner_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sinking_requirement_authoritative_uq" ON "sinking_requirements" USING btree ("owner_id","fund_id") WHERE "sinking_requirements"."is_authoritative";--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_one_current_uq" ON "transaction_versions" USING btree ("owner_id","transaction_id") WHERE "transaction_versions"."is_current";--> statement-breakpoint
CREATE INDEX "transaction_effective_idx" ON "transaction_versions" USING btree ("owner_id","effective_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "engine_runs_owner_id_uq" ON "engine_runs" USING btree ("owner_id","id");
--> statement-breakpoint
ALTER TABLE "transaction_versions" ADD CONSTRAINT "transaction_versions_owner_transaction_fk" FOREIGN KEY ("owner_id","transaction_id") REFERENCES "financial_transactions"("owner_id","id");
--> statement-breakpoint
ALTER TABLE "account_entries" ADD CONSTRAINT "entries_owner_transaction_revision_fk" FOREIGN KEY ("owner_id","transaction_id","transaction_revision") REFERENCES "transaction_versions"("owner_id","transaction_id","revision");
--> statement-breakpoint
ALTER TABLE "account_entries" ADD CONSTRAINT "entries_owner_account_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "accounts"("owner_id","id");
--> statement-breakpoint
ALTER TABLE "economic_flows" ADD CONSTRAINT "economic_flows_owner_transaction_fk" FOREIGN KEY ("owner_id","transaction_id") REFERENCES "financial_transactions"("owner_id","id");
--> statement-breakpoint
ALTER TABLE "flow_classifications" ADD CONSTRAINT "flow_classifications_owner_flow_fk" FOREIGN KEY ("owner_id","flow_id") REFERENCES "economic_flows"("owner_id","id");
--> statement-breakpoint
ALTER TABLE "flow_ambiguities" ADD CONSTRAINT "flow_ambiguities_owner_transaction_fk" FOREIGN KEY ("owner_id","transaction_id") REFERENCES "financial_transactions"("owner_id","id");
--> statement-breakpoint
ALTER TABLE "sinking_events" ADD CONSTRAINT "sinking_events_owner_fund_fk" FOREIGN KEY ("owner_id","fund_id") REFERENCES "sinking_funds"("owner_id","id");
--> statement-breakpoint
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_owner_account_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "accounts"("owner_id","id");
--> statement-breakpoint
ALTER TABLE "cash_reconciliations" ADD CONSTRAINT "cash_reconciliations_owner_transaction_fk" FOREIGN KEY ("owner_id","adjustment_transaction_id") REFERENCES "financial_transactions"("owner_id","id");
--> statement-breakpoint
ALTER TABLE "cash_reconciliation_resolutions" ADD CONSTRAINT "resolutions_owner_reconciliation_fk" FOREIGN KEY ("owner_id","reconciliation_id") REFERENCES "cash_reconciliations"("owner_id","id");
--> statement-breakpoint
ALTER TABLE "cash_reconciliation_resolutions" ADD CONSTRAINT "resolutions_owner_transaction_fk" FOREIGN KEY ("owner_id","resolution_transaction_id") REFERENCES "financial_transactions"("owner_id","id");
--> statement-breakpoint
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_owner_run_fk" FOREIGN KEY ("owner_id","engine_run_id") REFERENCES "engine_runs"("owner_id","id");
--> statement-breakpoint
ALTER TABLE "sinking_requirements" ADD CONSTRAINT "sinking_requirements_owner_run_fk" FOREIGN KEY ("owner_id","engine_run_id") REFERENCES "engine_runs"("owner_id","id");
--> statement-breakpoint
ALTER TABLE "sinking_requirements" ADD CONSTRAINT "sinking_requirements_owner_fund_fk" FOREIGN KEY ("owner_id","fund_id") REFERENCES "sinking_funds"("owner_id","id");
