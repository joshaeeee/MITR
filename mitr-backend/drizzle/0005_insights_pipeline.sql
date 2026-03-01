CREATE TABLE "insight_signal_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "elder_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "session_id" text NOT NULL,
  "transcript_id" uuid,
  "date_key" text NOT NULL,
  "source_language" text,
  "normalized_language" text DEFAULT 'en' NOT NULL,
  "transcript_original" text NOT NULL,
  "transcript_normalized" text NOT NULL,
  "engagement_score" integer NOT NULL,
  "emotional_tone_score" integer NOT NULL,
  "social_connection_score" integer NOT NULL,
  "adherence_score" integer NOT NULL,
  "distress_score" integer NOT NULL,
  "overall_score" integer NOT NULL,
  "score_band" text NOT NULL,
  "confidence" integer NOT NULL,
  "data_sufficiency" integer NOT NULL,
  "features_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "event_ts" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "insight_signal_events_elder_date_idx" ON "insight_signal_events" USING btree ("elder_id","date_key","event_ts");
--> statement-breakpoint
CREATE INDEX "insight_signal_events_user_created_idx" ON "insight_signal_events" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE TABLE "insight_daily_scores" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "elder_id" uuid NOT NULL,
  "date_key" text NOT NULL,
  "engagement_score" integer NOT NULL,
  "emotional_tone_score" integer NOT NULL,
  "social_connection_score" integer NOT NULL,
  "adherence_score" integer NOT NULL,
  "distress_score" integer NOT NULL,
  "overall_score" integer NOT NULL,
  "score_band" text NOT NULL,
  "confidence" integer NOT NULL,
  "data_sufficiency" integer NOT NULL,
  "metrics_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "last_computed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "insight_daily_scores_elder_date_uq" ON "insight_daily_scores" USING btree ("elder_id","date_key");
--> statement-breakpoint
CREATE INDEX "insight_daily_scores_elder_computed_idx" ON "insight_daily_scores" USING btree ("elder_id","last_computed_at");
--> statement-breakpoint
CREATE TABLE "insight_recommendations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "elder_id" uuid NOT NULL,
  "date_key" text NOT NULL,
  "recommendation_type" text NOT NULL,
  "title" text NOT NULL,
  "why_text" text NOT NULL,
  "action_text" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "score_band" text NOT NULL,
  "confidence" integer NOT NULL,
  "cooldown_until" timestamp with time zone,
  "metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "insight_recommendations_elder_status_created_idx" ON "insight_recommendations" USING btree ("elder_id","status","created_at");
--> statement-breakpoint
CREATE TABLE "insight_evidence_spans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "elder_id" uuid NOT NULL,
  "signal_event_id" uuid,
  "recommendation_id" uuid,
  "concern_signal_id" uuid,
  "transcript_id" uuid,
  "snippet" text NOT NULL,
  "rationale" text NOT NULL,
  "weight" integer DEFAULT 50 NOT NULL,
  "event_ts" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "insight_evidence_spans_elder_created_idx" ON "insight_evidence_spans" USING btree ("elder_id","created_at");
--> statement-breakpoint
CREATE INDEX "insight_evidence_spans_signal_idx" ON "insight_evidence_spans" USING btree ("signal_event_id");
--> statement-breakpoint
CREATE TABLE "insight_checkins" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "elder_id" uuid NOT NULL,
  "created_by_user_id" text NOT NULL,
  "week_start_date" text NOT NULL,
  "mood_label" text NOT NULL,
  "engagement_label" text NOT NULL,
  "social_label" text NOT NULL,
  "concern_level" text DEFAULT 'none' NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "insight_checkins_elder_week_idx" ON "insight_checkins" USING btree ("elder_id","week_start_date","created_at");
--> statement-breakpoint
CREATE TABLE "insight_model_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL,
  "version" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "config_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "insight_model_versions_key_version_uq" ON "insight_model_versions" USING btree ("key","version");
--> statement-breakpoint
CREATE INDEX "insight_model_versions_key_active_idx" ON "insight_model_versions" USING btree ("key","is_active","created_at");
--> statement-breakpoint
CREATE TABLE "insight_pipeline_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "elder_id" uuid,
  "user_id" text,
  "run_type" text NOT NULL,
  "status" text NOT NULL,
  "input_count" integer DEFAULT 1 NOT NULL,
  "queue_lag_ms" integer,
  "error_message" text,
  "metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "insight_pipeline_runs_elder_started_idx" ON "insight_pipeline_runs" USING btree ("elder_id","started_at");
--> statement-breakpoint
CREATE INDEX "insight_pipeline_runs_status_started_idx" ON "insight_pipeline_runs" USING btree ("status","started_at");
