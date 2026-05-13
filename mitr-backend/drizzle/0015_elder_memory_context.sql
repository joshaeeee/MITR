CREATE TABLE "elder_memory_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "elder_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "memory_type" text NOT NULL,
  "subject" text NOT NULL,
  "summary" text NOT NULL,
  "value_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "importance" integer DEFAULT 50 NOT NULL,
  "confidence" integer DEFAULT 70 NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "source_type" text DEFAULT 'system' NOT NULL,
  "source_id" text,
  "visibility" text DEFAULT 'private' NOT NULL,
  "valid_from" timestamp with time zone,
  "valid_until" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "last_accessed_at" timestamp with time zone,
  "access_count" integer DEFAULT 0 NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "elder_memory_items_elder_status_importance_idx"
  ON "elder_memory_items" ("elder_id", "status", "importance");

CREATE INDEX "elder_memory_items_elder_type_status_idx"
  ON "elder_memory_items" ("elder_id", "memory_type", "status");

CREATE INDEX "elder_memory_items_elder_source_idx"
  ON "elder_memory_items" ("elder_id", "source_type", "source_id");

CREATE INDEX "elder_memory_items_elder_expiry_idx"
  ON "elder_memory_items" ("elder_id", "expires_at");

CREATE TABLE "elder_context_cards" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "elder_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "card_type" text NOT NULL,
  "source_type" text DEFAULT 'system' NOT NULL,
  "source_id" text,
  "dedupe_key" text,
  "title" text NOT NULL,
  "summary" text NOT NULL,
  "priority" integer DEFAULT 50 NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "mention_policy" text DEFAULT 'when_conversational' NOT NULL,
  "due_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone,
  "cooldown_until" timestamp with time zone,
  "last_mentioned_at" timestamp with time zone,
  "mention_count" integer DEFAULT 0 NOT NULL,
  "max_mentions" integer DEFAULT 1 NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "elder_context_cards_elder_status_due_priority_idx"
  ON "elder_context_cards" ("elder_id", "status", "due_at", "priority");

CREATE UNIQUE INDEX "elder_context_cards_elder_dedupe_uq"
  ON "elder_context_cards" ("elder_id", "dedupe_key");

CREATE INDEX "elder_context_cards_elder_source_idx"
  ON "elder_context_cards" ("elder_id", "source_type", "source_id");

CREATE INDEX "elder_context_cards_elder_cooldown_idx"
  ON "elder_context_cards" ("elder_id", "cooldown_until");

CREATE TABLE "elder_context_card_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "card_id" uuid NOT NULL,
  "elder_id" uuid NOT NULL,
  "user_id" text NOT NULL,
  "session_id" text,
  "event_type" text NOT NULL,
  "response_state" text,
  "notes" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX "elder_context_card_events_card_created_idx"
  ON "elder_context_card_events" ("card_id", "created_at");

CREATE INDEX "elder_context_card_events_elder_created_idx"
  ON "elder_context_card_events" ("elder_id", "created_at");
