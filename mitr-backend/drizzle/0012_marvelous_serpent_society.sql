ALTER TABLE "devices"
  ADD COLUMN "current_device_session_id" uuid;

ALTER TABLE "device_sessions"
  ADD COLUMN "boot_id" text;

UPDATE "device_sessions"
SET "boot_id" = 'legacy-' || "id"::text
WHERE "boot_id" IS NULL;

ALTER TABLE "device_sessions"
  ALTER COLUMN "boot_id" SET NOT NULL;

CREATE TABLE "device_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "device_session_id" uuid NOT NULL,
  "device_id" text NOT NULL,
  "state" text DEFAULT 'opening' NOT NULL,
  "requested_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  "end_reason" text,
  "last_user_activity_at" timestamp with time zone,
  "wakeword_model" text,
  "wakeword_phrase" text,
  "wakeword_score" text
);

CREATE INDEX "device_conversations_session_requested_idx"
  ON "device_conversations" ("device_session_id", "requested_at");

CREATE INDEX "device_conversations_device_state_requested_idx"
  ON "device_conversations" ("device_id", "state", "requested_at");
