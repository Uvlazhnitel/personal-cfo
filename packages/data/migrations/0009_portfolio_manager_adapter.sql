CREATE TABLE "portfolio_manager_raw_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"connection_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"request_key" text NOT NULL,
	"request_cursor" text,
	"response_cursor" text,
	"received_at" timestamp(6) with time zone NOT NULL,
	"payload_sha256" text NOT NULL,
	"payload_ciphertext" text,
	"payload_iv" text,
	"payload_auth_tag" text,
	"payload_expires_at" timestamp(6) with time zone NOT NULL,
	"status" text NOT NULL,
	"normalization_version" text NOT NULL,
	"source_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"revision_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure_category" text,
	"processed_at" timestamp(6) with time zone,
	CONSTRAINT "portfolio_manager_receipt_endpoint_ck" CHECK ("portfolio_manager_raw_receipts"."endpoint" in ('capabilities','snapshot','capital_flows')),
	CONSTRAINT "portfolio_manager_receipt_status_ck" CHECK ("portfolio_manager_raw_receipts"."status" in ('received','normalized','quarantined','failed')),
	CONSTRAINT "portfolio_manager_receipt_ciphertext_shape_ck" CHECK (("portfolio_manager_raw_receipts"."payload_ciphertext" is null and "portfolio_manager_raw_receipts"."payload_iv" is null and "portfolio_manager_raw_receipts"."payload_auth_tag" is null) or ("portfolio_manager_raw_receipts"."payload_ciphertext" is not null and "portfolio_manager_raw_receipts"."payload_iv" is not null and "portfolio_manager_raw_receipts"."payload_auth_tag" is not null))
);
--> statement-breakpoint
CREATE TABLE "portfolio_manager_source_revisions" (
	"owner_id" uuid NOT NULL,
	"connection_id" text NOT NULL,
	"source_id" text NOT NULL,
	"revision_sha256" text NOT NULL,
	"record_kind" text NOT NULL,
	"provider_revision_id" text,
	"provider_status" text,
	"changed_at" timestamp(6) with time zone,
	"replaces_revision_id" text,
	"replacement_revision_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"receipt_id" uuid NOT NULL,
	"first_seen_at" timestamp(6) with time zone NOT NULL,
	"last_seen_at" timestamp(6) with time zone NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	CONSTRAINT "portfolio_manager_source_revisions_owner_id_connection_id_source_id_revision_sha256_pk" PRIMARY KEY("owner_id","connection_id","source_id","revision_sha256"),
	CONSTRAINT "portfolio_manager_source_status_ck" CHECK ("portfolio_manager_source_revisions"."provider_status" is null or "portfolio_manager_source_revisions"."provider_status" in ('ACTIVE','REPLACED','VOIDED'))
);
--> statement-breakpoint
CREATE TABLE "portfolio_manager_sync_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"connection_id" text NOT NULL,
	"status" text NOT NULL,
	"starting_cursor" text,
	"continuation_cursor" text,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_completeness" text DEFAULT 'unavailable' NOT NULL,
	"started_at" timestamp(6) with time zone NOT NULL,
	"completed_at" timestamp(6) with time zone,
	"failure_category" text,
	CONSTRAINT "portfolio_manager_run_status_ck" CHECK ("portfolio_manager_sync_runs"."status" in ('running','completed','failed')),
	CONSTRAINT "portfolio_manager_run_completion_ck" CHECK (("portfolio_manager_sync_runs"."status" = 'running' and "portfolio_manager_sync_runs"."completed_at" is null) or ("portfolio_manager_sync_runs"."status" <> 'running' and "portfolio_manager_sync_runs"."completed_at" is not null)),
	CONSTRAINT "portfolio_manager_run_completeness_ck" CHECK ("portfolio_manager_sync_runs"."source_completeness" in ('complete','partial','unavailable'))
);
--> statement-breakpoint
CREATE TABLE "portfolio_manager_sync_states" (
	"owner_id" uuid NOT NULL,
	"connection_id" text NOT NULL,
	"investment_account_id" uuid NOT NULL,
	"checkpoint" text,
	"lease_id" uuid,
	"lease_expires_at" timestamp(6) with time zone,
	"active_run_id" uuid,
	"last_successful_sync_at" timestamp(6) with time zone,
	"last_failure_category" text,
	"created_at" timestamp(6) with time zone NOT NULL,
	"updated_at" timestamp(6) with time zone NOT NULL,
	CONSTRAINT "portfolio_manager_sync_states_owner_id_connection_id_pk" PRIMARY KEY("owner_id","connection_id"),
	CONSTRAINT "portfolio_manager_sync_lease_shape_ck" CHECK (("portfolio_manager_sync_states"."lease_id" is null and "portfolio_manager_sync_states"."lease_expires_at" is null) or ("portfolio_manager_sync_states"."lease_id" is not null and "portfolio_manager_sync_states"."lease_expires_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "portfolio_provider_bindings" (
	"owner_id" uuid NOT NULL,
	"investment_account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"connection_id" text NOT NULL,
	"provider_instance_id" text,
	"provider_portfolio_id" text,
	"created_at" timestamp(6) with time zone NOT NULL,
	"updated_at" timestamp(6) with time zone NOT NULL,
	CONSTRAINT "portfolio_provider_bindings_owner_id_investment_account_id_pk" PRIMARY KEY("owner_id","investment_account_id"),
	CONSTRAINT "portfolio_provider_binding_provider_ck" CHECK ("portfolio_provider_bindings"."provider" in ('sharesight','portfolio-manager')),
	CONSTRAINT "portfolio_provider_identity_shape_ck" CHECK (("portfolio_provider_bindings"."provider_instance_id" is null and "portfolio_provider_bindings"."provider_portfolio_id" is null) or ("portfolio_provider_bindings"."provider_instance_id" is not null and "portfolio_provider_bindings"."provider_portfolio_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "portfolio_manager_raw_receipts" ADD CONSTRAINT "portfolio_manager_raw_receipts_run_id_portfolio_manager_sync_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."portfolio_manager_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_manager_raw_receipts" ADD CONSTRAINT "portfolio_manager_raw_receipts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_manager_source_revisions" ADD CONSTRAINT "portfolio_manager_source_revisions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_manager_source_revisions" ADD CONSTRAINT "portfolio_manager_source_revisions_receipt_id_portfolio_manager_raw_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."portfolio_manager_raw_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_manager_sync_runs" ADD CONSTRAINT "portfolio_manager_sync_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_manager_sync_states" ADD CONSTRAINT "portfolio_manager_sync_states_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_manager_sync_states" ADD CONSTRAINT "portfolio_manager_sync_states_investment_account_id_accounts_id_fk" FOREIGN KEY ("investment_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_provider_bindings" ADD CONSTRAINT "portfolio_provider_bindings_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_provider_bindings" ADD CONSTRAINT "portfolio_provider_bindings_investment_account_id_accounts_id_fk" FOREIGN KEY ("investment_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "portfolio_provider_bindings" (
	"owner_id",
	"investment_account_id",
	"provider",
	"connection_id",
	"provider_instance_id",
	"provider_portfolio_id",
	"created_at",
	"updated_at"
)
SELECT
	"owner_id",
	"investment_account_id",
	'sharesight',
	"connection_id",
	"provider_portfolio_id",
	"provider_portfolio_id",
	"created_at",
	"updated_at"
FROM "sharesight_sync_states";--> statement-breakpoint
CREATE INDEX "portfolio_manager_receipt_run_request_idx" ON "portfolio_manager_raw_receipts" USING btree ("run_id","request_key");--> statement-breakpoint
CREATE INDEX "portfolio_manager_receipt_pending_idx" ON "portfolio_manager_raw_receipts" USING btree ("owner_id","connection_id","status","received_at");--> statement-breakpoint
CREATE INDEX "portfolio_manager_receipt_expiry_idx" ON "portfolio_manager_raw_receipts" USING btree ("payload_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_manager_source_current_uq" ON "portfolio_manager_source_revisions" USING btree ("owner_id","connection_id","source_id") WHERE "portfolio_manager_source_revisions"."is_current";--> statement-breakpoint
CREATE INDEX "portfolio_manager_source_receipt_idx" ON "portfolio_manager_source_revisions" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "portfolio_manager_runs_owner_started_idx" ON "portfolio_manager_sync_runs" USING btree ("owner_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_manager_connection_id_uq" ON "portfolio_manager_sync_states" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portfolio_provider_connection_uq" ON "portfolio_provider_bindings" USING btree ("provider","connection_id");
