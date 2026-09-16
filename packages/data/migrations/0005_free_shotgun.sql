CREATE TABLE "account_balance_snapshots" (
	"owner_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"source_as_of" timestamp(6) with time zone NOT NULL,
	"received_at" timestamp(6) with time zone NOT NULL,
	"stale_at" timestamp(6) with time zone NOT NULL,
	"reportability_status" text NOT NULL,
	"original_amount_minor" bigint NOT NULL,
	"original_currency" text NOT NULL,
	"reporting_amount_minor" bigint,
	"reporting_currency" text,
	"fx_rate_id" uuid,
	CONSTRAINT "account_balance_snapshots_owner_id_account_id_source_as_of_pk" PRIMARY KEY("owner_id","account_id","source_as_of"),
	CONSTRAINT "balance_snapshot_reportability_ck" CHECK (("account_balance_snapshots"."reportability_status" = 'available' and "account_balance_snapshots"."reporting_amount_minor" is not null and "account_balance_snapshots"."reporting_currency" is not null) or ("account_balance_snapshots"."reportability_status" = 'missing_fx' and "account_balance_snapshots"."reporting_amount_minor" is null and "account_balance_snapshots"."reporting_currency" is null and "account_balance_snapshots"."fx_rate_id" is null))
);
--> statement-breakpoint
CREATE TABLE "contribution_attributions" (
	"owner_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"plan_id" uuid,
	CONSTRAINT "contribution_attributions_owner_id_transaction_id_pk" PRIMARY KEY("owner_id","transaction_id"),
	CONSTRAINT "contribution_attribution_shape_ck" CHECK (("contribution_attributions"."kind" = 'recurring_plan' and "contribution_attributions"."plan_id" is not null) or ("contribution_attributions"."kind" = 'ad_hoc' and "contribution_attributions"."plan_id" is null))
);
--> statement-breakpoint
CREATE TABLE "investment_contributions" (
	"owner_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"investment_account_id" uuid NOT NULL,
	"principal_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"effective_at" timestamp(6) with time zone NOT NULL,
	CONSTRAINT "investment_contributions_owner_id_transaction_id_pk" PRIMARY KEY("owner_id","transaction_id"),
	CONSTRAINT "investment_contribution_positive_ck" CHECK ("investment_contributions"."principal_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "portfolio_valuations" (
	"owner_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"source_as_of" timestamp(6) with time zone NOT NULL,
	"received_at" timestamp(6) with time zone NOT NULL,
	"stale_at" timestamp(6) with time zone NOT NULL,
	"reportability_status" text NOT NULL,
	"original_amount_minor" bigint NOT NULL,
	"original_currency" text NOT NULL,
	"reporting_amount_minor" bigint,
	"reporting_currency" text,
	"fx_rate_id" uuid,
	"brokerage_cash_treatment" text NOT NULL,
	CONSTRAINT "portfolio_valuations_owner_id_account_id_source_as_of_pk" PRIMARY KEY("owner_id","account_id","source_as_of"),
	CONSTRAINT "portfolio_valuation_reportability_ck" CHECK (("portfolio_valuations"."reportability_status" = 'available' and "portfolio_valuations"."reporting_amount_minor" is not null and "portfolio_valuations"."reporting_currency" is not null) or ("portfolio_valuations"."reportability_status" = 'missing_fx' and "portfolio_valuations"."reporting_amount_minor" is null and "portfolio_valuations"."reporting_currency" is null and "portfolio_valuations"."fx_rate_id" is null)),
	CONSTRAINT "portfolio_valuation_cash_treatment_ck" CHECK ("portfolio_valuations"."brokerage_cash_treatment" in ('included_in_market_value','separate_account'))
);
--> statement-breakpoint
CREATE TABLE "primary_salary_triggers" (
	"owner_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"effective_date" date NOT NULL,
	CONSTRAINT "primary_salary_triggers_owner_id_transaction_id_pk" PRIMARY KEY("owner_id","transaction_id")
);
--> statement-breakpoint
CREATE TABLE "spending_observations" (
	"owner_id" uuid NOT NULL,
	"economic_flow_id" uuid NOT NULL,
	"economic_date" date NOT NULL,
	"category_id" uuid NOT NULL,
	"necessity" text NOT NULL,
	"cadence" text NOT NULL,
	"irregular" boolean NOT NULL,
	CONSTRAINT "spending_observations_owner_id_economic_flow_id_pk" PRIMARY KEY("owner_id","economic_flow_id"),
	CONSTRAINT "spending_observation_necessity_ck" CHECK ("spending_observations"."necessity" in ('essential','discretionary')),
	CONSTRAINT "spending_observation_cadence_ck" CHECK ("spending_observations"."cadence" in ('recurring','variable'))
);
--> statement-breakpoint
ALTER TABLE "account_balance_snapshots" ADD CONSTRAINT "account_balance_snapshots_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contribution_attributions" ADD CONSTRAINT "contribution_attributions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_contributions" ADD CONSTRAINT "investment_contributions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_valuations" ADD CONSTRAINT "portfolio_valuations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "primary_salary_triggers" ADD CONSTRAINT "primary_salary_triggers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spending_observations" ADD CONSTRAINT "spending_observations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "balance_snapshots_owner_time_idx" ON "account_balance_snapshots" USING btree ("owner_id","source_as_of");--> statement-breakpoint
CREATE INDEX "investment_contributions_owner_time_idx" ON "investment_contributions" USING btree ("owner_id","effective_at");--> statement-breakpoint
CREATE INDEX "portfolio_valuations_owner_time_idx" ON "portfolio_valuations" USING btree ("owner_id","source_as_of");--> statement-breakpoint
CREATE INDEX "primary_salary_triggers_owner_date_idx" ON "primary_salary_triggers" USING btree ("owner_id","effective_date");--> statement-breakpoint
CREATE INDEX "spending_observations_owner_date_idx" ON "spending_observations" USING btree ("owner_id","economic_date");--> statement-breakpoint
ALTER TABLE "engine_runs" ADD CONSTRAINT "engine_run_status_ck" CHECK ("engine_runs"."status" in ('running','completed','failed'));--> statement-breakpoint
ALTER TABLE "recalculation_records" ADD CONSTRAINT "recalculation_status_ck" CHECK ("recalculation_records"."status" in ('queued','running','completed','failed','superseded'));--> statement-breakpoint
ALTER TABLE "account_balance_snapshots" ADD CONSTRAINT "balance_snapshots_owner_account_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "accounts"("owner_id","id");--> statement-breakpoint
ALTER TABLE "portfolio_valuations" ADD CONSTRAINT "portfolio_valuations_owner_account_fk" FOREIGN KEY ("owner_id","account_id") REFERENCES "accounts"("owner_id","id");--> statement-breakpoint
ALTER TABLE "investment_contributions" ADD CONSTRAINT "investment_contributions_owner_transaction_fk" FOREIGN KEY ("owner_id","transaction_id") REFERENCES "financial_transactions"("owner_id","id");--> statement-breakpoint
ALTER TABLE "investment_contributions" ADD CONSTRAINT "investment_contributions_owner_account_fk" FOREIGN KEY ("owner_id","investment_account_id") REFERENCES "accounts"("owner_id","id");--> statement-breakpoint
ALTER TABLE "contribution_attributions" ADD CONSTRAINT "contribution_attributions_owner_contribution_fk" FOREIGN KEY ("owner_id","transaction_id") REFERENCES "investment_contributions"("owner_id","transaction_id");--> statement-breakpoint
ALTER TABLE "primary_salary_triggers" ADD CONSTRAINT "primary_salary_triggers_owner_transaction_fk" FOREIGN KEY ("owner_id","transaction_id") REFERENCES "financial_transactions"("owner_id","id");--> statement-breakpoint
ALTER TABLE "spending_observations" ADD CONSTRAINT "spending_observations_owner_flow_fk" FOREIGN KEY ("owner_id","economic_flow_id") REFERENCES "economic_flows"("owner_id","id");--> statement-breakpoint
ALTER TABLE "account_balance_snapshots" ADD CONSTRAINT "balance_snapshot_time_ck" CHECK ("stale_at" >= "source_as_of" AND "received_at" >= "source_as_of");--> statement-breakpoint
ALTER TABLE "portfolio_valuations" ADD CONSTRAINT "portfolio_valuation_time_ck" CHECK ("stale_at" >= "source_as_of" AND "received_at" >= "source_as_of");--> statement-breakpoint
ALTER TABLE "account_balance_snapshots" ADD CONSTRAINT "balance_snapshot_amount_ck" CHECK (
  ("reportability_status" = 'available' AND (
    ("fx_rate_id" IS NULL AND "original_currency" = 'EUR' AND "reporting_currency" = 'EUR' AND "original_amount_minor" = "reporting_amount_minor") OR
    ("fx_rate_id" IS NOT NULL AND "original_currency" <> 'EUR' AND "reporting_currency" = 'EUR')
  )) OR
  ("reportability_status" = 'missing_fx' AND "original_currency" <> 'EUR' AND "reporting_amount_minor" IS NULL AND "reporting_currency" IS NULL AND "fx_rate_id" IS NULL)
);--> statement-breakpoint
ALTER TABLE "portfolio_valuations" ADD CONSTRAINT "portfolio_valuation_amount_ck" CHECK (
  ("reportability_status" = 'available' AND (
    ("fx_rate_id" IS NULL AND "original_currency" = 'EUR' AND "reporting_currency" = 'EUR' AND "original_amount_minor" = "reporting_amount_minor") OR
    ("fx_rate_id" IS NOT NULL AND "original_currency" <> 'EUR' AND "reporting_currency" = 'EUR')
  )) OR
  ("reportability_status" = 'missing_fx' AND "original_currency" <> 'EUR' AND "reporting_amount_minor" IS NULL AND "reporting_currency" IS NULL AND "fx_rate_id" IS NULL)
);--> statement-breakpoint

INSERT INTO "account_balance_snapshots" (
  "owner_id", "account_id", "source_as_of", "received_at", "stale_at",
  "reportability_status", "original_amount_minor", "original_currency",
  "reporting_amount_minor", "reporting_currency", "fx_rate_id"
)
SELECT
  "owner_id",
  ("payload" ->> 'accountId')::uuid,
  ("payload" ->> 'sourceAsOf')::timestamptz,
  ("payload" ->> 'sourceAsOf')::timestamptz,
  ("payload" ->> 'staleAt')::timestamptz,
  "payload" #>> '{value,status}',
  ("payload" #>> '{value,original,amountMinor,$personalCfoBigInt}')::bigint,
  "payload" #>> '{value,original,currency}',
  CASE WHEN "payload" #>> '{value,reporting,amountMinor,$personalCfoBigInt}' IS NULL THEN NULL ELSE ("payload" #>> '{value,reporting,amountMinor,$personalCfoBigInt}')::bigint END,
  "payload" #>> '{value,reporting,currency}',
  NULLIF("payload" #>> '{value,fxRateId}', '')::uuid
FROM "fact_payloads"
WHERE "fact_type" = 'account_balance_snapshot';--> statement-breakpoint

INSERT INTO "portfolio_valuations" (
  "owner_id", "account_id", "source_as_of", "received_at", "stale_at",
  "reportability_status", "original_amount_minor", "original_currency",
  "reporting_amount_minor", "reporting_currency", "fx_rate_id", "brokerage_cash_treatment"
)
SELECT
  "owner_id",
  ("payload" ->> 'accountId')::uuid,
  ("payload" ->> 'sourceAsOf')::timestamptz,
  ("payload" ->> 'sourceAsOf')::timestamptz,
  ("payload" ->> 'staleAt')::timestamptz,
  "payload" #>> '{marketValue,status}',
  ("payload" #>> '{marketValue,original,amountMinor,$personalCfoBigInt}')::bigint,
  "payload" #>> '{marketValue,original,currency}',
  CASE WHEN "payload" #>> '{marketValue,reporting,amountMinor,$personalCfoBigInt}' IS NULL THEN NULL ELSE ("payload" #>> '{marketValue,reporting,amountMinor,$personalCfoBigInt}')::bigint END,
  "payload" #>> '{marketValue,reporting,currency}',
  NULLIF("payload" #>> '{marketValue,fxRateId}', '')::uuid,
  "payload" ->> 'brokerageCashTreatment'
FROM "fact_payloads"
WHERE "fact_type" = 'portfolio_valuation';--> statement-breakpoint

INSERT INTO "investment_contributions" (
  "owner_id", "transaction_id", "investment_account_id", "principal_minor", "currency", "effective_at"
)
SELECT
  "owner_id",
  ("payload" ->> 'transactionId')::uuid,
  ("payload" ->> 'investmentAccountId')::uuid,
  ("payload" #>> '{principal,amountMinor,$personalCfoBigInt}')::bigint,
  "payload" #>> '{principal,currency}',
  ("payload" ->> 'effectiveAt')::timestamptz
FROM "fact_payloads"
WHERE "fact_type" = 'investment_contribution';--> statement-breakpoint

INSERT INTO "contribution_attributions" ("owner_id", "transaction_id", "kind", "plan_id")
SELECT
  "owner_id",
  ("payload" ->> 'transactionId')::uuid,
  "payload" ->> 'kind',
  NULLIF("payload" ->> 'planId', '')::uuid
FROM "fact_payloads"
WHERE "fact_type" = 'contribution_attribution';--> statement-breakpoint

INSERT INTO "primary_salary_triggers" ("owner_id", "transaction_id", "effective_date")
SELECT
  "owner_id",
  ("payload" ->> 'transactionId')::uuid,
  ("payload" ->> 'effectiveDate')::date
FROM "fact_payloads"
WHERE "fact_type" = 'primary_salary_trigger';--> statement-breakpoint

INSERT INTO "spending_observations" (
  "owner_id", "economic_flow_id", "economic_date", "category_id", "necessity", "cadence", "irregular"
)
SELECT
  "owner_id",
  ("payload" ->> 'economicFlowId')::uuid,
  ("payload" ->> 'economicDate')::date,
  ("payload" ->> 'categoryId')::uuid,
  "payload" ->> 'necessity',
  "payload" ->> 'cadence',
  ("payload" ->> 'irregular')::boolean
FROM "fact_payloads"
WHERE "fact_type" = 'spending_observation';--> statement-breakpoint

UPDATE "flow_classifications"
SET "payload" = CASE "kind"
  WHEN 'earned_income' THEN jsonb_build_object('earnedIncomeSource', "payload" -> 'source')
  WHEN 'consumption' THEN jsonb_build_object('reimbursable', "payload" -> 'reimbursable')
  WHEN 'refund' THEN jsonb_build_object('relatedTransactionId', "payload" -> 'relatedTransactionId')
  WHEN 'reimbursement' THEN jsonb_build_object('relatedTransactionId', "payload" -> 'relatedTransactionId')
  ELSE '{}'::jsonb
END;--> statement-breakpoint

DELETE FROM "fact_payloads"
WHERE "fact_type" IN (
  'account_balance_snapshot',
  'portfolio_valuation',
  'investment_contribution',
  'contribution_attribution',
  'primary_salary_trigger',
  'spending_observation'
);--> statement-breakpoint

ALTER TABLE "fact_payloads" ADD CONSTRAINT "fact_payloads_noncanonical_type_ck" CHECK (
  "fact_type" NOT IN (
    'account_balance_snapshot',
    'portfolio_valuation',
    'investment_contribution',
    'contribution_attribution',
    'primary_salary_trigger',
    'spending_observation'
  )
);
