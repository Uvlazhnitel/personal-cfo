CREATE TABLE "cash_reconciliation_resolutions" (
	"reconciliation_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"resolution_transaction_id" uuid NOT NULL,
	"resolved_at" timestamp(6) with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "reconciliation_resolution_kind_ck" CHECK ("cash_reconciliation_resolutions"."kind" in ('reclassified_adjustment','reversed_adjustment'))
);
--> statement-breakpoint
CREATE TABLE "cash_reconciliations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"adjustment_transaction_id" uuid NOT NULL,
	"calculated_minor" bigint NOT NULL,
	"counted_minor" bigint NOT NULL,
	"variance_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"materiality" text NOT NULL,
	"reconciled_at" timestamp(6) with time zone NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation_profiles" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"as_of" timestamp(6) with time zone NOT NULL,
	"effective_date" date NOT NULL,
	"engine_version" text NOT NULL,
	"settings_version" text NOT NULL,
	"payload" jsonb NOT NULL,
	"updated_at" timestamp(6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exact_rate_examples" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"value" numeric NOT NULL
);
--> statement-breakpoint
CREATE TABLE "planning_contexts" (
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"checkpoint_key" text NOT NULL,
	"effective_at" timestamp(6) with time zone,
	"payload" jsonb NOT NULL,
	CONSTRAINT "planning_contexts_owner_id_kind_checkpoint_key_pk" PRIMARY KEY("owner_id","kind","checkpoint_key")
);
--> statement-breakpoint
CREATE TABLE "settings_versions" (
	"owner_id" uuid NOT NULL,
	"version" text NOT NULL,
	"effective_from" timestamp(6) with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	CONSTRAINT "settings_versions_owner_id_version_pk" PRIMARY KEY("owner_id","version")
);
--> statement-breakpoint
CREATE TABLE "sinking_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"fund_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"effective_at" timestamp(6) with time zone NOT NULL,
	"related_transaction_id" uuid,
	"command_id" uuid,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sinking_funds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"target_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"due_date" date NOT NULL,
	"priority" integer NOT NULL,
	"status" text NOT NULL,
	"allocation_policy" text NOT NULL,
	"created_at" timestamp(6) with time zone NOT NULL,
	"payload" jsonb NOT NULL
);
