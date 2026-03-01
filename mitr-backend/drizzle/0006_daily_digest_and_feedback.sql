ALTER TABLE "insight_recommendations" DROP CONSTRAINT IF EXISTS "insight_recommendations_status_check";
--> statement-breakpoint
CREATE TABLE "insight_daily_digests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "elder_id" uuid NOT NULL,
  "date_key" text NOT NULL,
  "summary_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "score_band" text NOT NULL,
  "confidence" integer NOT NULL,
  "data_sufficiency" integer NOT NULL,
  "generated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "insight_daily_digests_elder_date_uq" ON "insight_daily_digests" USING btree ("elder_id","date_key");
--> statement-breakpoint
CREATE INDEX "insight_daily_digests_elder_generated_idx" ON "insight_daily_digests" USING btree ("elder_id","generated_at");
--> statement-breakpoint
CREATE TABLE "insight_recommendation_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "recommendation_id" uuid NOT NULL,
  "elder_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "action" text NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "insight_reco_feedback_reco_created_idx" ON "insight_recommendation_feedback" USING btree ("recommendation_id","created_at");
--> statement-breakpoint
CREATE INDEX "insight_reco_feedback_elder_created_idx" ON "insight_recommendation_feedback" USING btree ("elder_id","created_at");
--> statement-breakpoint
CREATE TABLE "caregiver_notification_preferences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "family_id" uuid NOT NULL,
  "digest_enabled" boolean DEFAULT true NOT NULL,
  "digest_hour_local" integer DEFAULT 20 NOT NULL,
  "digest_minute_local" integer DEFAULT 30 NOT NULL,
  "timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
  "realtime_enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "caregiver_notif_prefs_user_uq" ON "caregiver_notification_preferences" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "caregiver_notif_prefs_family_digest_idx" ON "caregiver_notification_preferences" USING btree ("family_id","digest_enabled");
--> statement-breakpoint
CREATE TABLE "caregiver_push_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "expo_push_token" text NOT NULL,
  "platform" text DEFAULT 'unknown' NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "caregiver_push_tokens_token_uq" ON "caregiver_push_tokens" USING btree ("expo_push_token");
--> statement-breakpoint
CREATE INDEX "caregiver_push_tokens_user_active_idx" ON "caregiver_push_tokens" USING btree ("user_id","is_active");
--> statement-breakpoint
CREATE TABLE "digest_delivery_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "digest_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "delivery_channel" text NOT NULL,
  "status" text NOT NULL,
  "provider_message_id" text,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "digest_delivery_logs_dedupe_uq" ON "digest_delivery_logs" USING btree ("digest_id","user_id","delivery_channel");
--> statement-breakpoint
CREATE INDEX "digest_delivery_logs_user_created_idx" ON "digest_delivery_logs" USING btree ("user_id","created_at");
