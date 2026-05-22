CREATE TABLE IF NOT EXISTS "swiggy_oauth_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "state_hash" text NOT NULL,
  "code_verifier" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "swiggy_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "access_token_ciphertext" text NOT NULL,
  "scope" text,
  "token_type" text DEFAULT 'Bearer' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "last_authorized_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  "metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "swiggy_delivery_preferences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "address_id" text NOT NULL,
  "label" text,
  "display_text" text,
  "selected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "swiggy_oauth_states_state_hash_uq" ON "swiggy_oauth_states" ("state_hash");
CREATE INDEX IF NOT EXISTS "swiggy_oauth_states_user_created_idx" ON "swiggy_oauth_states" ("user_id", "created_at");
CREATE UNIQUE INDEX IF NOT EXISTS "swiggy_connections_user_uq" ON "swiggy_connections" ("user_id");
CREATE INDEX IF NOT EXISTS "swiggy_connections_user_status_idx" ON "swiggy_connections" ("user_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "swiggy_delivery_preferences_user_uq" ON "swiggy_delivery_preferences" ("user_id");
