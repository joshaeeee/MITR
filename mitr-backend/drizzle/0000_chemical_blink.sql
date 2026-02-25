CREATE TABLE "conversation_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"user_text" text NOT NULL,
	"assistant_text" text NOT NULL,
	"language" text,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "long_session_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"long_session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"block_type" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result_json" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"retry_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "long_session_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"long_session_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "long_session_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"long_session_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"summary_text" text NOT NULL,
	"key_points_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"open_loops_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "long_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"current_block_id" uuid,
	"phase" text NOT NULL,
	"target_duration_sec" integer DEFAULT 1800 NOT NULL,
	"elapsed_sec" integer DEFAULT 0 NOT NULL,
	"topic" text,
	"language" text DEFAULT 'hi-IN' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"datetime_iso" text NOT NULL,
	"recurrence" text,
	"locale" text DEFAULT 'en-IN' NOT NULL,
	"acknowledged" boolean DEFAULT false NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" text NOT NULL,
	"preferred_language" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_external_id_unique" UNIQUE("external_id")
);
