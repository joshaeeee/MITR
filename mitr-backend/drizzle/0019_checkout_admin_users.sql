CREATE TABLE IF NOT EXISTS "checkout_admin_users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "password_hash" text NOT NULL,
  "role" text DEFAULT 'admin' NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "must_change_password" boolean DEFAULT true NOT NULL,
  "created_by" text,
  "last_login_at" timestamp with time zone,
  "metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "checkout_admin_users_email_lower" CHECK ("email" = lower("email")),
  CONSTRAINT "checkout_admin_users_role_check" CHECK ("role" IN ('owner', 'admin'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "checkout_admin_users_email_uq" ON "checkout_admin_users" ("email");
CREATE INDEX IF NOT EXISTS "checkout_admin_users_active_idx" ON "checkout_admin_users" ("is_active", "created_at");
