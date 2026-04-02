ALTER TABLE "devices" ADD COLUMN "family_id" uuid;
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "elder_id" uuid;
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "claimed_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "device_sessions" ADD COLUMN "family_id" uuid;
--> statement-breakpoint
ALTER TABLE "device_sessions" ADD COLUMN "elder_id" uuid;
--> statement-breakpoint
ALTER TABLE "device_sessions" ADD COLUMN "claimed_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "device_telemetry" ADD COLUMN "family_id" uuid;
--> statement-breakpoint
ALTER TABLE "device_telemetry" ADD COLUMN "elder_id" uuid;
--> statement-breakpoint
ALTER TABLE "device_telemetry" ADD COLUMN "claimed_by_user_id" text;
--> statement-breakpoint
CREATE TABLE "device_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pairing_token_hash" text NOT NULL,
	"device_id" text NOT NULL,
	"family_id" uuid NOT NULL,
	"elder_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"claimed_by_user_id" text NOT NULL,
	"display_name" text,
	"status" text DEFAULT 'pending_device' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "device_pairings_token_hash_uq" ON "device_pairings" USING btree ("pairing_token_hash");
--> statement-breakpoint
CREATE INDEX "device_pairings_device_created_idx" ON "device_pairings" USING btree ("device_id","created_at");
--> statement-breakpoint
CREATE INDEX "device_pairings_family_created_idx" ON "device_pairings" USING btree ("family_id","created_at");
--> statement-breakpoint
CREATE INDEX "device_pairings_elder_created_idx" ON "device_pairings" USING btree ("elder_id","created_at");
--> statement-breakpoint
CREATE INDEX "devices_family_claimed_idx" ON "devices" USING btree ("family_id","claimed_at");
--> statement-breakpoint
CREATE INDEX "devices_elder_claimed_idx" ON "devices" USING btree ("elder_id","claimed_at");
--> statement-breakpoint
CREATE INDEX "device_sessions_family_started_idx" ON "device_sessions" USING btree ("family_id","started_at");
--> statement-breakpoint
CREATE INDEX "device_sessions_elder_started_idx" ON "device_sessions" USING btree ("elder_id","started_at");
--> statement-breakpoint
CREATE INDEX "device_telemetry_family_created_idx" ON "device_telemetry" USING btree ("family_id","created_at");
--> statement-breakpoint
CREATE INDEX "device_telemetry_elder_created_idx" ON "device_telemetry" USING btree ("elder_id","created_at");
--> statement-breakpoint
WITH owned_families AS (
    SELECT
        fa.id AS family_id,
        fa.owner_user_id,
        (
            SELECT ep.id
            FROM elder_profiles ep
            WHERE ep.family_id = fa.id
            ORDER BY ep.created_at ASC
            LIMIT 1
        ) AS elder_id
    FROM family_accounts fa
)
UPDATE "devices" AS d
SET
    "family_id" = COALESCE(d."family_id", owned_families.family_id),
    "elder_id" = COALESCE(d."elder_id", owned_families.elder_id),
    "claimed_by_user_id" = COALESCE(d."claimed_by_user_id", d."user_id")
FROM owned_families
WHERE d."user_id" = owned_families.owner_user_id;
--> statement-breakpoint
UPDATE "device_sessions" AS s
SET
    "family_id" = COALESCE(s."family_id", d."family_id"),
    "elder_id" = COALESCE(s."elder_id", d."elder_id"),
    "claimed_by_user_id" = COALESCE(s."claimed_by_user_id", d."claimed_by_user_id", s."user_id")
FROM "devices" AS d
WHERE s."device_id" = d."device_id";
--> statement-breakpoint
UPDATE "device_telemetry" AS t
SET
    "family_id" = COALESCE(t."family_id", d."family_id"),
    "elder_id" = COALESCE(t."elder_id", d."elder_id"),
    "claimed_by_user_id" = COALESCE(t."claimed_by_user_id", d."claimed_by_user_id", t."user_id")
FROM "devices" AS d
WHERE t."device_id" = d."device_id";
