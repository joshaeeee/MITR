ALTER TABLE "long_sessions" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "long_sessions" ADD COLUMN "metadata_json" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "long_session_blocks_session_seq_uq" ON "long_session_blocks" USING btree ("long_session_id","seq");--> statement-breakpoint
CREATE INDEX "long_session_blocks_session_state_seq_idx" ON "long_session_blocks" USING btree ("long_session_id","state","seq");--> statement-breakpoint
CREATE INDEX "long_session_events_session_ts_idx" ON "long_session_events" USING btree ("long_session_id","ts");--> statement-breakpoint
CREATE INDEX "long_sessions_user_status_idx" ON "long_sessions" USING btree ("user_id","status");