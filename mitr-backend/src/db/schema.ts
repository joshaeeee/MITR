import { pgTable, text, timestamp, uuid, jsonb, boolean, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  externalId: text('external_id').notNull().unique(),
  preferredLanguage: text('preferred_language'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

export const reminders = pgTable('reminders', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull(),
  title: text('title').notNull(),
  datetimeIso: text('datetime_iso').notNull(),
  recurrence: text('recurrence'),
  locale: text('locale').default('en-IN').notNull(),
  acknowledged: boolean('acknowledged').default(false).notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

export const conversationTurns = pgTable('conversation_turns', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: text('session_id').notNull(),
  userId: uuid('user_id').notNull(),
  userText: text('user_text').notNull(),
  assistantText: text('assistant_text').notNull(),
  language: text('language'),
  citations: jsonb('citations').$type<Array<Record<string, unknown>>>().default([]).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

export const longSessions = pgTable('long_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(),
  mode: text('mode').$type<'companion_long' | 'satsang_long' | 'story_long'>().notNull(),
  status: text('status').$type<'running' | 'paused' | 'completed' | 'stopped'>().default('running').notNull(),
  version: integer('version').default(0).notNull(),
  currentBlockId: uuid('current_block_id'),
  phase: text('phase').notNull(),
  targetDurationSec: integer('target_duration_sec').default(1800).notNull(),
  elapsedSec: integer('elapsed_sec').default(0).notNull(),
  topic: text('topic'),
  language: text('language').default('hi-IN').notNull(),
  metadataJson: jsonb('metadata_json').$type<Record<string, unknown>>().default({}).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  endReason: text('end_reason')
}, (table) => ({
  userStatusIdx: index('long_sessions_user_status_idx').on(table.userId, table.status)
}));

export const longSessionBlocks = pgTable('long_session_blocks', {
  id: uuid('id').defaultRandom().primaryKey(),
  longSessionId: uuid('long_session_id').notNull(),
  seq: integer('seq').notNull(),
  blockType: text('block_type').notNull(),
  state: text('state').$type<'queued' | 'running' | 'done' | 'skipped' | 'failed'>().default('queued').notNull(),
  payloadJson: jsonb('payload_json').$type<Record<string, unknown>>().default({}).notNull(),
  resultJson: jsonb('result_json').$type<Record<string, unknown>>(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  retryCount: integer('retry_count').default(0).notNull()
}, (table) => ({
  sessionSeqUnique: uniqueIndex('long_session_blocks_session_seq_uq').on(table.longSessionId, table.seq),
  sessionStateSeqIdx: index('long_session_blocks_session_state_seq_idx').on(table.longSessionId, table.state, table.seq)
}));

export const longSessionSummaries = pgTable('long_session_summaries', {
  id: uuid('id').defaultRandom().primaryKey(),
  longSessionId: uuid('long_session_id').notNull(),
  seq: integer('seq').notNull(),
  summaryText: text('summary_text').notNull(),
  keyPointsJson: jsonb('key_points_json').$type<Array<string>>().default([]).notNull(),
  openLoopsJson: jsonb('open_loops_json').$type<Array<string>>().default([]).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

export const longSessionEvents = pgTable('long_session_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  longSessionId: uuid('long_session_id').notNull(),
  eventType: text('event_type').notNull(),
  payloadJson: jsonb('payload_json').$type<Record<string, unknown>>().default({}).notNull(),
  ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  sessionTsIdx: index('long_session_events_session_ts_idx').on(table.longSessionId, table.ts)
}));
