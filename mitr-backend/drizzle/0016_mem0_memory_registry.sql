ALTER TABLE "elder_memory_items" ALTER COLUMN "summary" DROP NOT NULL;

ALTER TABLE "elder_memory_items" ADD COLUMN "mem0_user_id" text;
ALTER TABLE "elder_memory_items" ADD COLUMN "mem0_event_id" text;
ALTER TABLE "elder_memory_items" ADD COLUMN "mem0_memory_id" text;
ALTER TABLE "elder_memory_items" ADD COLUMN "mem0_status" text DEFAULT 'not_indexed' NOT NULL;
ALTER TABLE "elder_memory_items" ADD COLUMN "mem0_indexed_at" timestamp with time zone;
ALTER TABLE "elder_memory_items" ADD COLUMN "content_hash" text;

CREATE INDEX "elder_memory_items_mem0_user_status_idx"
  ON "elder_memory_items" ("mem0_user_id", "status");

CREATE INDEX "elder_memory_items_mem0_memory_idx"
  ON "elder_memory_items" ("mem0_memory_id");

CREATE INDEX "elder_memory_items_elder_content_hash_idx"
  ON "elder_memory_items" ("elder_id", "content_hash");
