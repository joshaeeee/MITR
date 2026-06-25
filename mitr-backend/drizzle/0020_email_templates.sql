CREATE TABLE IF NOT EXISTS "email_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "category" text DEFAULT 'customer' NOT NULL,
  "subject" text NOT NULL,
  "html" text NOT NULL,
  "text_body" text DEFAULT '' NOT NULL,
  "variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "sample_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "sendable_from_dashboard" boolean DEFAULT false NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "email_templates_category_check" CHECK ("category" IN ('customer', 'internal'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "email_templates_key_uq" ON "email_templates" ("key");
CREATE INDEX IF NOT EXISTS "email_templates_active_category_idx" ON "email_templates" ("is_active", "category");
