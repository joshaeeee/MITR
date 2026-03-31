CREATE TABLE "elder_device_usage_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "elder_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "session_id" text NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone NOT NULL,
  "duration_sec" integer NOT NULL,
  "usage_summary_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "elder_device_usage_sessions_session_uq" ON "elder_device_usage_sessions" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX "elder_device_usage_sessions_elder_started_idx" ON "elder_device_usage_sessions" USING btree ("elder_id","started_at");
--> statement-breakpoint
CREATE INDEX "elder_device_usage_sessions_elder_ended_idx" ON "elder_device_usage_sessions" USING btree ("elder_id","ended_at");
