CREATE TABLE "care_plan_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "elder_id" uuid NOT NULL,
  "section" text NOT NULL,
  "type" text NOT NULL,
  "title" text NOT NULL,
  "description" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "scheduled_at" text,
  "repeat_rule" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "care_plan_items_elder_section_sort_idx" ON "care_plan_items" USING btree ("elder_id","section","sort_order");
--> statement-breakpoint
CREATE INDEX "care_plan_items_elder_created_idx" ON "care_plan_items" USING btree ("elder_id","created_at");
