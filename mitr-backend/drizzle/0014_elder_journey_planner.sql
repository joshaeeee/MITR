CREATE TABLE "elder_journey_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "elder_id" uuid NOT NULL,
  "preferred_address" text,
  "communication_style" text DEFAULT 'respectful' NOT NULL,
  "proactive_level" text DEFAULT 'medium' NOT NULL,
  "privacy_level" text DEFAULT 'routine_updates' NOT NULL,
  "relationship_stage_override" text,
  "first_successful_interaction_at" timestamp with time zone,
  "routine_anchors" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "interests" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "boundaries" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "onboarding_use_cases" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX "elder_journey_profiles_elder_uq"
  ON "elder_journey_profiles" ("elder_id");

CREATE TABLE "elder_prompt_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "elder_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "session_id" text,
  "trigger_type" text NOT NULL,
  "prompt_type" text NOT NULL,
  "prompt_key" text NOT NULL,
  "topic" text,
  "response_state" text DEFAULT 'planned' NOT NULL,
  "sentiment" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "elder_prompt_history_elder_created_idx"
  ON "elder_prompt_history" ("elder_id", "created_at");

CREATE INDEX "elder_prompt_history_elder_prompt_key_created_idx"
  ON "elder_prompt_history" ("elder_id", "prompt_key", "created_at");

CREATE TABLE "elder_medication_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "elder_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "reminder_id" uuid,
  "medicine" text,
  "scheduled_at" timestamp with time zone,
  "status" text NOT NULL,
  "response_text" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "elder_medication_events_elder_created_idx"
  ON "elder_medication_events" ("elder_id", "created_at");

CREATE INDEX "elder_medication_events_reminder_created_idx"
  ON "elder_medication_events" ("reminder_id", "created_at");
