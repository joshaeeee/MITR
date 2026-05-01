ALTER TABLE "device_sessions"
  ADD COLUMN "agent_state" text DEFAULT 'not_dispatched' NOT NULL,
  ADD COLUMN "agent_dispatch_id" text,
  ADD COLUMN "agent_ready_at" timestamp with time zone,
  ADD COLUMN "agent_last_seen_at" timestamp with time zone,
  ADD COLUMN "agent_restart_count" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "agent_last_error" text;

ALTER TABLE "device_conversations"
  ADD COLUMN "wake_id" text;

CREATE UNIQUE INDEX "device_conversations_session_wake_id_uq"
  ON "device_conversations" ("device_session_id", "wake_id");
