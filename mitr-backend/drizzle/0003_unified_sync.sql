CREATE INDEX "conversation_turns_user_created_idx" ON "conversation_turns" USING btree ("user_id","created_at");
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "display_name" text;
--> statement-breakpoint
CREATE TABLE "user_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "user_profiles_user_uq" ON "user_profiles" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE "auth_passwords" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "password_hash" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_passwords_user_uq" ON "auth_passwords" USING btree ("user_id");
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "access_token_hash" text NOT NULL,
  "refresh_token_hash" text NOT NULL,
  "access_expires_at" timestamp with time zone NOT NULL,
  "refresh_expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_access_token_uq" ON "auth_sessions" USING btree ("access_token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_sessions_refresh_token_uq" ON "auth_sessions" USING btree ("refresh_token_hash");
--> statement-breakpoint
CREATE INDEX "auth_sessions_user_created_idx" ON "auth_sessions" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE TABLE "user_event_stream" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" text NOT NULL,
  "event_type" text NOT NULL,
  "payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "user_event_stream_user_created_idx" ON "user_event_stream" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "user_event_stream_user_id_idx" ON "user_event_stream" USING btree ("user_id","id");
