CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" text NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text,
	"hardware_rev" text,
	"firmware_version" text,
	"device_access_token_hash" text NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "device_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" text NOT NULL,
	"user_id" text NOT NULL,
	"room_name" text NOT NULL,
	"participant_identity" text NOT NULL,
	"language" text DEFAULT 'hi-IN' NOT NULL,
	"firmware_version" text,
	"hardware_rev" text,
	"status" text DEFAULT 'issued' NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text
);
--> statement-breakpoint
CREATE TABLE "device_telemetry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" uuid,
	"event_type" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firmware_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hardware_rev" text NOT NULL,
	"version" text NOT NULL,
	"rollout_channel" text DEFAULT 'dev' NOT NULL,
	"download_url" text,
	"release_notes" text,
	"is_mandatory" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "devices_device_id_uq" ON "devices" USING btree ("device_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "devices_access_token_uq" ON "devices" USING btree ("device_access_token_hash");
--> statement-breakpoint
CREATE INDEX "devices_user_claimed_idx" ON "devices" USING btree ("user_id","claimed_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "device_claims_code_hash_uq" ON "device_claims" USING btree ("code_hash");
--> statement-breakpoint
CREATE INDEX "device_claims_user_created_idx" ON "device_claims" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "device_sessions_device_started_idx" ON "device_sessions" USING btree ("device_id","started_at");
--> statement-breakpoint
CREATE INDEX "device_sessions_user_started_idx" ON "device_sessions" USING btree ("user_id","started_at");
--> statement-breakpoint
CREATE INDEX "device_sessions_device_status_idx" ON "device_sessions" USING btree ("device_id","status","started_at");
--> statement-breakpoint
CREATE INDEX "device_telemetry_device_created_idx" ON "device_telemetry" USING btree ("device_id","created_at");
--> statement-breakpoint
CREATE INDEX "device_telemetry_session_created_idx" ON "device_telemetry" USING btree ("session_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "firmware_releases_hardware_version_uq" ON "firmware_releases" USING btree ("hardware_rev","version");
--> statement-breakpoint
CREATE INDEX "firmware_releases_hardware_channel_active_idx" ON "firmware_releases" USING btree ("hardware_rev","rollout_channel","is_active","published_at");
