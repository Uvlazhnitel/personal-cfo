CREATE TABLE "telegram_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"source_key" text NOT NULL,
	"owner_id" uuid,
	"update_id" bigint NOT NULL,
	"chat_id" bigint NOT NULL,
	"reply_to_message_id" bigint,
	"purpose" text NOT NULL,
	"response_text" text,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"bot_message_id" bigint,
	"safe_error_category" text,
	"next_attempt_at" timestamp(6) with time zone,
	"created_at" timestamp(6) with time zone NOT NULL,
	"completed_at" timestamp(6) with time zone,
	CONSTRAINT "telegram_delivery_status_ck" CHECK ("telegram_deliveries"."status" in ('pending','sending','retryable','sent','failed','uncertain'))
);
--> statement-breakpoint
CREATE TABLE "telegram_integration_status" (
	"name" text PRIMARY KEY NOT NULL,
	"enabled" boolean NOT NULL,
	"source_key" text,
	"status" text NOT NULL,
	"last_processed_update_id" bigint,
	"last_processed_at" timestamp(6) with time zone,
	"last_error_category" text,
	"updated_at" timestamp(6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_message_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"chat_id" bigint NOT NULL,
	"user_message_id" bigint NOT NULL,
	"bot_message_id" bigint,
	"update_id" bigint NOT NULL,
	"command_id" uuid NOT NULL,
	"proposal_kind" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"status" text NOT NULL,
	"superseded_by" uuid,
	"created_at" timestamp(6) with time zone NOT NULL,
	CONSTRAINT "telegram_link_status_ck" CHECK ("telegram_message_links"."status" in ('current','superseded','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "telegram_owner_links" (
	"source_key" text NOT NULL,
	"telegram_user_id" bigint NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp(6) with time zone NOT NULL,
	"updated_at" timestamp(6) with time zone NOT NULL,
	CONSTRAINT "telegram_owner_links_source_key_telegram_user_id_pk" PRIMARY KEY("source_key","telegram_user_id")
);
--> statement-breakpoint
CREATE TABLE "telegram_pending_clarifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"chat_id" bigint NOT NULL,
	"sender_id" bigint NOT NULL,
	"origin_update_id" bigint NOT NULL,
	"origin_message_id" bigint NOT NULL,
	"proposal_kind" text NOT NULL,
	"missing_field" text NOT NULL,
	"known_fields" jsonb,
	"locale" text NOT NULL,
	"invalid_attempts" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp(6) with time zone NOT NULL,
	"expires_at" timestamp(6) with time zone NOT NULL,
	"resolved_at" timestamp(6) with time zone,
	"resolved_by_update_id" bigint,
	CONSTRAINT "telegram_clarification_status_ck" CHECK ("telegram_pending_clarifications"."status" in ('active','resolved','cancelled','expired','superseded'))
);
--> statement-breakpoint
CREATE TABLE "telegram_poll_state" (
	"source_key" text PRIMARY KEY NOT NULL,
	"next_offset" bigint,
	"last_polled_at" timestamp(6) with time zone,
	"last_error_category" text,
	"updated_at" timestamp(6) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_updates" (
	"source_key" text NOT NULL,
	"update_id" bigint NOT NULL,
	"owner_id" uuid,
	"chat_id" bigint,
	"sender_id" bigint,
	"message_id" bigint,
	"reply_to_message_id" bigint,
	"update_type" text NOT NULL,
	"message_date" timestamp(6) with time zone,
	"message_text" text,
	"text_hash" text,
	"locale" text,
	"status" text NOT NULL,
	"parser_outcome" text,
	"proposal_kind" text,
	"command_id" uuid,
	"entity_type" text,
	"entity_id" text,
	"safe_error_category" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp(6) with time zone NOT NULL,
	"processing_started_at" timestamp(6) with time zone,
	"processed_at" timestamp(6) with time zone,
	CONSTRAINT "telegram_updates_source_key_update_id_pk" PRIMARY KEY("source_key","update_id"),
	CONSTRAINT "telegram_update_status_ck" CHECK ("telegram_updates"."status" in ('received','processing','awaiting_clarification','completed','rejected','unsupported','failed','expired'))
);
--> statement-breakpoint
ALTER TABLE "telegram_deliveries" ADD CONSTRAINT "telegram_deliveries_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_message_links" ADD CONSTRAINT "telegram_message_links_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_message_links" ADD CONSTRAINT "telegram_message_links_command_id_command_records_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."command_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_owner_links" ADD CONSTRAINT "telegram_owner_links_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_pending_clarifications" ADD CONSTRAINT "telegram_pending_clarifications_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_updates" ADD CONSTRAINT "telegram_updates_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_updates" ADD CONSTRAINT "telegram_updates_command_id_command_records_id_fk" FOREIGN KEY ("command_id") REFERENCES "public"."command_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_delivery_update_purpose_uq" ON "telegram_deliveries" USING btree ("source_key","update_id","purpose");--> statement-breakpoint
CREATE INDEX "telegram_delivery_pending_idx" ON "telegram_deliveries" USING btree ("source_key","status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_link_user_message_uq" ON "telegram_message_links" USING btree ("source_key","chat_id","user_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_link_bot_message_uq" ON "telegram_message_links" USING btree ("source_key","chat_id","bot_message_id") WHERE "telegram_message_links"."bot_message_id" is not null;--> statement-breakpoint
CREATE INDEX "telegram_link_owner_time_idx" ON "telegram_message_links" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_owner_source_owner_uq" ON "telegram_owner_links" USING btree ("source_key","owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_one_active_clarification_uq" ON "telegram_pending_clarifications" USING btree ("owner_id","source_key","chat_id") WHERE "telegram_pending_clarifications"."status" = 'active';--> statement-breakpoint
CREATE INDEX "telegram_clarification_expiry_idx" ON "telegram_pending_clarifications" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_message_identity_uq" ON "telegram_updates" USING btree ("source_key","chat_id","message_id") WHERE "telegram_updates"."message_id" is not null;--> statement-breakpoint
CREATE INDEX "telegram_updates_claim_idx" ON "telegram_updates" USING btree ("source_key","status","received_at");--> statement-breakpoint
CREATE INDEX "telegram_updates_owner_idx" ON "telegram_updates" USING btree ("owner_id","received_at");