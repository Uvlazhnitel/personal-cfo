CREATE TABLE "enable_banking_opening_balance_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_account_id" uuid NOT NULL,
	"canonical_account_id" uuid NOT NULL,
	"canonical_transaction_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"opening_balance_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"statement_period_from" date NOT NULL,
	"statement_period_through" date NOT NULL,
	"balance_boundary_at" timestamp(6) with time zone NOT NULL,
	"statement_sha256" text NOT NULL,
	"observation_set_sha256" text NOT NULL,
	"booked_observation_count" integer NOT NULL,
	"provider_balance_revision_sha256" text NOT NULL,
	"created_at" timestamp(6) with time zone NOT NULL,
	CONSTRAINT "enable_banking_opening_balance_currency_ck" CHECK ("enable_banking_opening_balance_evidence"."currency" = 'EUR'),
	CONSTRAINT "enable_banking_opening_balance_period_ck" CHECK ("enable_banking_opening_balance_evidence"."statement_period_from" <= "enable_banking_opening_balance_evidence"."statement_period_through"),
	CONSTRAINT "enable_banking_opening_balance_count_ck" CHECK ("enable_banking_opening_balance_evidence"."booked_observation_count" > 0),
	CONSTRAINT "enable_banking_opening_balance_statement_hash_ck" CHECK ("enable_banking_opening_balance_evidence"."statement_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "enable_banking_opening_balance_observation_hash_ck" CHECK ("enable_banking_opening_balance_evidence"."observation_set_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "enable_banking_opening_balance_provider_hash_ck" CHECK ("enable_banking_opening_balance_evidence"."provider_balance_revision_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "enable_banking_opening_balance_evidence" ADD CONSTRAINT "enable_banking_opening_balance_evidence_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_opening_balance_evidence" ADD CONSTRAINT "enable_banking_opening_balance_evidence_connection_id_enable_banking_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."enable_banking_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_opening_balance_evidence" ADD CONSTRAINT "enable_banking_opening_balance_evidence_provider_account_id_enable_banking_provider_accounts_id_fk" FOREIGN KEY ("provider_account_id") REFERENCES "public"."enable_banking_provider_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_opening_balance_evidence" ADD CONSTRAINT "enable_banking_opening_balance_evidence_canonical_account_id_accounts_id_fk" FOREIGN KEY ("canonical_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_opening_balance_evidence" ADD CONSTRAINT "enable_banking_opening_balance_evidence_canonical_transaction_id_financial_transactions_id_fk" FOREIGN KEY ("canonical_transaction_id") REFERENCES "public"."financial_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enable_banking_opening_balance_evidence" ADD CONSTRAINT "enable_banking_opening_balance_evidence_command_id_command_records_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."command_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "enable_banking_opening_balance_owner_account_uq" ON "enable_banking_opening_balance_evidence" USING btree ("owner_id","canonical_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enable_banking_opening_balance_transaction_uq" ON "enable_banking_opening_balance_evidence" USING btree ("canonical_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enable_banking_opening_balance_command_uq" ON "enable_banking_opening_balance_evidence" USING btree ("command_id");