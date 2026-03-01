CREATE TABLE "user_input_transcripts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" text NOT NULL,
  "user_id" text NOT NULL,
  "transcript" text NOT NULL,
  "language" text,
  "source" text DEFAULT 'openai_realtime' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "user_input_transcripts_user_created_idx" ON "user_input_transcripts" USING btree ("user_id","created_at");
--> statement-breakpoint
CREATE INDEX "user_input_transcripts_session_created_idx" ON "user_input_transcripts" USING btree ("session_id","created_at");
