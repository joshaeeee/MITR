ALTER TABLE "device_sessions"
  ADD COLUMN "conversation_state" text DEFAULT 'idle' NOT NULL,
  ADD COLUMN "last_wake_detected_at" timestamp with time zone,
  ADD COLUMN "conversation_started_at" timestamp with time zone,
  ADD COLUMN "conversation_ended_at" timestamp with time zone,
  ADD COLUMN "last_wakeword_model" text,
  ADD COLUMN "last_wakeword_score" text,
  ADD COLUMN "last_conversation_end_reason" text;

CREATE INDEX "device_sessions_device_conversation_idx"
  ON "device_sessions" ("device_id", "conversation_state", "started_at");
