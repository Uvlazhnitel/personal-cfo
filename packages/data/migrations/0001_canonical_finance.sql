CREATE TABLE "account_entries" (
	"owner_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"transaction_revision" integer NOT NULL,
	"entry_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"role" text NOT NULL,
	CONSTRAINT "account_entries_owner_id_transaction_id_transaction_revision_entry_id_pk" PRIMARY KEY("owner_id","transaction_id","transaction_revision","entry_id")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value_source" text NOT NULL,
	"currency" text NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "economic_flows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"effective_at" timestamp(6) with time zone NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_payloads" (
	"owner_id" uuid NOT NULL,
	"fact_type" text NOT NULL,
	"fact_id" text NOT NULL,
	"effective_at" timestamp(6) with time zone,
	"payload" jsonb NOT NULL,
	CONSTRAINT "fact_payloads_owner_id_fact_type_fact_id_pk" PRIMARY KEY("owner_id","fact_type","fact_id")
);
--> statement-breakpoint
CREATE TABLE "financial_transactions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp(6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flow_ambiguities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"materiality" text NOT NULL,
	"status" text DEFAULT 'unresolved' NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_at" timestamp(6) with time zone NOT NULL,
	"resolved_at" timestamp(6) with time zone,
	"resolver" text,
	"reason" text,
	CONSTRAINT "ambiguity_status_ck" CHECK ("flow_ambiguities"."status" in ('unresolved','confirmed_transfer','rejected_transfer'))
);
--> statement-breakpoint
CREATE TABLE "flow_classifications" (
	"owner_id" uuid NOT NULL,
	"flow_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"payload" jsonb NOT NULL,
	"decided_at" timestamp(6) with time zone NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	CONSTRAINT "flow_classifications_owner_id_flow_id_revision_pk" PRIMARY KEY("owner_id","flow_id","revision")
);
--> statement-breakpoint
CREATE TABLE "transaction_versions" (
	"owner_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"kind" text NOT NULL,
	"booking_status" text NOT NULL,
	"effective_at" timestamp(6) with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"superseded_at" timestamp(6) with time zone,
	CONSTRAINT "transaction_versions_owner_id_transaction_id_revision_pk" PRIMARY KEY("owner_id","transaction_id","revision")
);
--> statement-breakpoint
