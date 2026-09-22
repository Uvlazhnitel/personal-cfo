CREATE TABLE "sharesight_raw_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"provider_portfolio_id" text NOT NULL,
	"capability" text NOT NULL,
	"request_key" text NOT NULL,
	"request_from" date,
	"request_to" date,
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
	CONSTRAINT "sharesight_receipt_status_ck" CHECK ("sharesight_raw_receipts"."status" in ('received','normalized','quarantined','failed')),
	CONSTRAINT "sharesight_receipt_ciphertext_shape_ck" CHECK (("sharesight_raw_receipts"."payload_ciphertext" is null and "sharesight_raw_receipts"."payload_iv" is null and "sharesight_raw_receipts"."payload_auth_tag" is null) or ("sharesight_raw_receipts"."payload_ciphertext" is not null and "sharesight_raw_receipts"."payload_iv" is not null and "sharesight_raw_receipts"."payload_auth_tag" is not null))
);
--> statement-breakpoint
CREATE TABLE "sharesight_source_revisions" (
	"owner_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"revision_sha256" text NOT NULL,
	"record_kind" text NOT NULL,
	"receipt_id" uuid NOT NULL,
	"first_seen_at" timestamp(6) with time zone NOT NULL,
	"last_seen_at" timestamp(6) with time zone NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	CONSTRAINT "sharesight_source_revisions_owner_id_source_id_revision_sha256_pk" PRIMARY KEY("owner_id","source_id","revision_sha256")
);
--> statement-breakpoint
CREATE TABLE "sharesight_sync_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"provider_portfolio_id" text NOT NULL,
	"status" text NOT NULL,
	"scan_from" date,
	"scan_to" date,
	"continuation" jsonb,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_freshness" text DEFAULT 'unconfirmed' NOT NULL,
	"started_at" timestamp(6) with time zone NOT NULL,
	"completed_at" timestamp(6) with time zone,
	"failure_category" text,
	CONSTRAINT "sharesight_sync_run_status_ck" CHECK ("sharesight_sync_runs"."status" in ('running','completed','failed')),
	CONSTRAINT "sharesight_sync_run_completion_ck" CHECK (("sharesight_sync_runs"."status" = 'running' and "sharesight_sync_runs"."completed_at" is null) or ("sharesight_sync_runs"."status" <> 'running' and "sharesight_sync_runs"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "sharesight_sync_states" (
	"owner_id" uuid NOT NULL,
	"provider_portfolio_id" text NOT NULL,
	"investment_account_id" uuid NOT NULL,
	"connection_id" text NOT NULL,
	"lease_id" uuid,
	"lease_expires_at" timestamp(6) with time zone,
	"active_run_id" uuid,
	"last_successful_sync_at" timestamp(6) with time zone,
	"last_failure_category" text,
	"created_at" timestamp(6) with time zone NOT NULL,
	"updated_at" timestamp(6) with time zone NOT NULL,
	CONSTRAINT "sharesight_sync_states_owner_id_provider_portfolio_id_pk" PRIMARY KEY("owner_id","provider_portfolio_id"),
	CONSTRAINT "sharesight_sync_lease_shape_ck" CHECK (("sharesight_sync_states"."lease_id" is null and "sharesight_sync_states"."lease_expires_at" is null) or ("sharesight_sync_states"."lease_id" is not null and "sharesight_sync_states"."lease_expires_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "sharesight_raw_receipts" ADD CONSTRAINT "sharesight_raw_receipts_run_id_sharesight_sync_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sharesight_sync_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharesight_raw_receipts" ADD CONSTRAINT "sharesight_raw_receipts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharesight_source_revisions" ADD CONSTRAINT "sharesight_source_revisions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharesight_source_revisions" ADD CONSTRAINT "sharesight_source_revisions_receipt_id_sharesight_raw_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."sharesight_raw_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharesight_sync_runs" ADD CONSTRAINT "sharesight_sync_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharesight_sync_states" ADD CONSTRAINT "sharesight_sync_states_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sharesight_sync_states" ADD CONSTRAINT "sharesight_sync_states_investment_account_id_accounts_id_fk" FOREIGN KEY ("investment_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sharesight_receipt_run_request_idx" ON "sharesight_raw_receipts" USING btree ("run_id","request_key");--> statement-breakpoint
CREATE INDEX "sharesight_receipt_pending_idx" ON "sharesight_raw_receipts" USING btree ("owner_id","status","received_at");--> statement-breakpoint
CREATE INDEX "sharesight_receipt_expiry_idx" ON "sharesight_raw_receipts" USING btree ("payload_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sharesight_source_current_uq" ON "sharesight_source_revisions" USING btree ("owner_id","source_id") WHERE "sharesight_source_revisions"."is_current";--> statement-breakpoint
CREATE INDEX "sharesight_source_receipt_idx" ON "sharesight_source_revisions" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "sharesight_sync_runs_owner_started_idx" ON "sharesight_sync_runs" USING btree ("owner_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sharesight_connection_id_uq" ON "sharesight_sync_states" USING btree ("connection_id");
