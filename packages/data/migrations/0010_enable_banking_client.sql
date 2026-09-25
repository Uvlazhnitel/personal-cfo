CREATE TABLE "enable_banking_authorization_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"state_hash" text NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp(6) with time zone NOT NULL,
	"claimed_at" timestamp(6) with time zone,
	"completed_at" timestamp(6) with time zone,
	"failure_category" text,
	"created_at" timestamp(6) with time zone NOT NULL,
	CONSTRAINT "enable_banking_authorization_status_ck" CHECK ("enable_banking_authorization_attempts"."status" in ('pending','exchanging','completed','cancelled','failed','expired','indeterminate'))
);
--> statement-breakpoint
CREATE TABLE "enable_banking_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"generation" uuid NOT NULL,
	"status" text NOT NULL,
	"application_id_hash" text NOT NULL,
	"session_id_ciphertext" text,
	"session_id_iv" text,
	"session_id_auth_tag" text,
	"session_generation" uuid,
	"consent_expires_at" timestamp(6) with time zone,
	"active_run_id" uuid,
	"lease_id" uuid,
	"lease_expires_at" timestamp(6) with time zone,
	"last_failure_category" text,
	"created_at" timestamp(6) with time zone NOT NULL,
	"updated_at" timestamp(6) with time zone NOT NULL,
	CONSTRAINT "enable_banking_connection_status_ck" CHECK ("enable_banking_connections"."status" in ('disconnected','connecting','active','reauth_required','error','revoked')),
	CONSTRAINT "enable_banking_session_ciphertext_shape_ck" CHECK (("enable_banking_connections"."session_id_ciphertext" is null and "enable_banking_connections"."session_id_iv" is null and "enable_banking_connections"."session_id_auth_tag" is null and "enable_banking_connections"."session_generation" is null and "enable_banking_connections"."consent_expires_at" is null) or ("enable_banking_connections"."session_id_ciphertext" is not null and "enable_banking_connections"."session_id_iv" is not null and "enable_banking_connections"."session_id_auth_tag" is not null and "enable_banking_connections"."session_generation" is not null and "enable_banking_connections"."consent_expires_at" is not null)),
	CONSTRAINT "enable_banking_connection_lease_shape_ck" CHECK (("enable_banking_connections"."active_run_id" is null and "enable_banking_connections"."lease_id" is null and "enable_banking_connections"."lease_expires_at" is null) or ("enable_banking_connections"."active_run_id" is not null and "enable_banking_connections"."lease_id" is not null and "enable_banking_connections"."lease_expires_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "enable_banking_provider_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"stable_account_key" text NOT NULL,
	"identification_hash_ciphertext" text NOT NULL,
	"identification_hash_iv" text NOT NULL,
	"identification_hash_auth_tag" text NOT NULL,
	"account_uid_ciphertext" text,
	"account_uid_iv" text,
	"account_uid_auth_tag" text,
	"display_hint_ciphertext" text,
	"display_hint_iv" text,
	"display_hint_auth_tag" text,
	"session_generation" uuid,
	"currency" text NOT NULL,
	"canonical_account_id" uuid,
	"observed_at" timestamp(6) with time zone NOT NULL,
	"updated_at" timestamp(6) with time zone NOT NULL,
	CONSTRAINT "enable_banking_display_hint_shape_ck" CHECK (("enable_banking_provider_accounts"."display_hint_ciphertext" is null and "enable_banking_provider_accounts"."display_hint_iv" is null and "enable_banking_provider_accounts"."display_hint_auth_tag" is null) or ("enable_banking_provider_accounts"."display_hint_ciphertext" is not null and "enable_banking_provider_accounts"."display_hint_iv" is not null and "enable_banking_provider_accounts"."display_hint_auth_tag" is not null)),
	CONSTRAINT "enable_banking_account_uid_shape_ck" CHECK (("enable_banking_provider_accounts"."account_uid_ciphertext" is null and "enable_banking_provider_accounts"."account_uid_iv" is null and "enable_banking_provider_accounts"."account_uid_auth_tag" is null and "enable_banking_provider_accounts"."session_generation" is null) or ("enable_banking_provider_accounts"."account_uid_ciphertext" is not null and "enable_banking_provider_accounts"."account_uid_iv" is not null and "enable_banking_provider_accounts"."account_uid_auth_tag" is not null and "enable_banking_provider_accounts"."session_generation" is not null))
);
--> statement-breakpoint
CREATE TABLE "enable_banking_raw_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"method" text NOT NULL,
	"request_key" text NOT NULL,
	"request_cursor_hash" text,
	"http_status" integer NOT NULL,
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
	CONSTRAINT "enable_banking_receipt_endpoint_ck" CHECK ("enable_banking_raw_receipts"."endpoint" in ('aspsps','authorization','session_exchange','session','account_details','balances','transactions','disconnect')),
	CONSTRAINT "enable_banking_receipt_method_ck" CHECK ("enable_banking_raw_receipts"."method" in ('GET','POST','DELETE')),
	CONSTRAINT "enable_banking_receipt_status_ck" CHECK ("enable_banking_raw_receipts"."status" in ('received','normalized','quarantined','failed')),
	CONSTRAINT "enable_banking_receipt_ciphertext_shape_ck" CHECK (("enable_banking_raw_receipts"."payload_ciphertext" is null and "enable_banking_raw_receipts"."payload_iv" is null and "enable_banking_raw_receipts"."payload_auth_tag" is null) or ("enable_banking_raw_receipts"."payload_ciphertext" is not null and "enable_banking_raw_receipts"."payload_iv" is not null and "enable_banking_raw_receipts"."payload_auth_tag" is not null))
);
--> statement-breakpoint
CREATE TABLE "enable_banking_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"strategy" text,
	"session_generation" uuid,
	"provider_account_id" uuid,
	"continuation_ciphertext" text,
	"continuation_iv" text,
	"continuation_auth_tag" text,
	"continuation_hash" text,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"coverage_from" date,
	"coverage_through" date,
	"started_at" timestamp(6) with time zone NOT NULL,
	"completed_at" timestamp(6) with time zone,
	"failure_category" text,
	CONSTRAINT "enable_banking_run_kind_ck" CHECK ("enable_banking_runs"."kind" in ('authorization','diagnostic_fetch','disconnect')),
	CONSTRAINT "enable_banking_run_status_ck" CHECK ("enable_banking_runs"."status" in ('pending','running','completed','failed','indeterminate')),
	CONSTRAINT "enable_banking_run_continuation_shape_ck" CHECK (("enable_banking_runs"."continuation_ciphertext" is null and "enable_banking_runs"."continuation_iv" is null and "enable_banking_runs"."continuation_auth_tag" is null and "enable_banking_runs"."continuation_hash" is null) or ("enable_banking_runs"."continuation_ciphertext" is not null and "enable_banking_runs"."continuation_iv" is not null and "enable_banking_runs"."continuation_auth_tag" is not null and "enable_banking_runs"."continuation_hash" is not null))
);
--> statement-breakpoint
CREATE TABLE "enable_banking_source_revisions" (
	"owner_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"revision_sha256" text NOT NULL,
	"record_kind" text NOT NULL,
	"provider_status" text,
	"receipt_id" uuid NOT NULL,
	"first_seen_at" timestamp(6) with time zone NOT NULL,
	"last_seen_at" timestamp(6) with time zone NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	CONSTRAINT "enable_banking_source_revisions_owner_id_connection_id_source_key_revision_sha256_pk" PRIMARY KEY("owner_id","connection_id","source_key","revision_sha256"),
	CONSTRAINT "enable_banking_source_kind_ck" CHECK ("enable_banking_source_revisions"."record_kind" in ('account','balance','transaction'))
);
--> statement-breakpoint
ALTER TABLE "enable_banking_authorization_attempts" ADD CONSTRAINT "enable_banking_authorization_attempts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_authorization_attempts" ADD CONSTRAINT "enable_banking_authorization_attempts_connection_id_enable_banking_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."enable_banking_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_authorization_attempts" ADD CONSTRAINT "enable_banking_authorization_attempts_run_id_enable_banking_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."enable_banking_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_connections" ADD CONSTRAINT "enable_banking_connections_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_provider_accounts" ADD CONSTRAINT "enable_banking_provider_accounts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_provider_accounts" ADD CONSTRAINT "enable_banking_provider_accounts_connection_id_enable_banking_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."enable_banking_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_provider_accounts" ADD CONSTRAINT "enable_banking_provider_accounts_canonical_account_id_accounts_id_fk" FOREIGN KEY ("canonical_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_raw_receipts" ADD CONSTRAINT "enable_banking_raw_receipts_run_id_enable_banking_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."enable_banking_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_raw_receipts" ADD CONSTRAINT "enable_banking_raw_receipts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_raw_receipts" ADD CONSTRAINT "enable_banking_raw_receipts_connection_id_enable_banking_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."enable_banking_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_runs" ADD CONSTRAINT "enable_banking_runs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_runs" ADD CONSTRAINT "enable_banking_runs_connection_id_enable_banking_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."enable_banking_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_source_revisions" ADD CONSTRAINT "enable_banking_source_revisions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_source_revisions" ADD CONSTRAINT "enable_banking_source_revisions_connection_id_enable_banking_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."enable_banking_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_source_revisions" ADD CONSTRAINT "enable_banking_source_revisions_provider_account_id_enable_banking_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."enable_banking_provider_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_source_revisions" ADD CONSTRAINT "enable_banking_source_revisions_receipt_id_enable_banking_raw_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."enable_banking_raw_receipts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "enable_banking_authorization_state_uq" ON "enable_banking_authorization_attempts" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "enable_banking_authorization_owner_status_idx" ON "enable_banking_authorization_attempts" USING btree ("owner_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "enable_banking_connection_owner_uq" ON "enable_banking_connections" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enable_banking_connection_generation_uq" ON "enable_banking_connections" USING btree ("generation");--> statement-breakpoint
CREATE UNIQUE INDEX "enable_banking_provider_account_identity_uq" ON "enable_banking_provider_accounts" USING btree ("owner_id","stable_account_key");--> statement-breakpoint
CREATE UNIQUE INDEX "enable_banking_provider_account_binding_uq" ON "enable_banking_provider_accounts" USING btree ("owner_id","canonical_account_id") WHERE "enable_banking_provider_accounts"."canonical_account_id" is not null;--> statement-breakpoint
CREATE INDEX "enable_banking_provider_account_connection_idx" ON "enable_banking_provider_accounts" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "enable_banking_receipt_run_idx" ON "enable_banking_raw_receipts" USING btree ("run_id","received_at");--> statement-breakpoint
CREATE INDEX "enable_banking_receipt_pending_idx" ON "enable_banking_raw_receipts" USING btree ("owner_id","connection_id","status","received_at");--> statement-breakpoint
CREATE INDEX "enable_banking_receipt_expiry_idx" ON "enable_banking_raw_receipts" USING btree ("payload_expires_at");--> statement-breakpoint
CREATE INDEX "enable_banking_runs_owner_started_idx" ON "enable_banking_runs" USING btree ("owner_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "enable_banking_source_current_uq" ON "enable_banking_source_revisions" USING btree ("owner_id","connection_id","source_key") WHERE "enable_banking_source_revisions"."is_current";--> statement-breakpoint
CREATE INDEX "enable_banking_source_receipt_idx" ON "enable_banking_source_revisions" USING btree ("receipt_id");
