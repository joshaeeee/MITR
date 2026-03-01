import { pgTable, text, timestamp, uuid, jsonb, boolean, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  externalId: text('external_id').notNull().unique(),
  displayName: text('display_name'),
  preferredLanguage: text('preferred_language'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

export const userProfiles = pgTable('user_profiles', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(),
  answers: jsonb('answers').$type<Record<string, string>>().default({}).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  userUnique: uniqueIndex('user_profiles_user_uq').on(table.userId)
}));

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
}, (table) => ({
  userCreatedIdx: index('conversation_turns_user_created_idx').on(table.userId, table.createdAt)
}));

export const userInputTranscripts = pgTable('user_input_transcripts', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: text('session_id').notNull(),
  userId: text('user_id').notNull(),
  transcript: text('transcript').notNull(),
  language: text('language'),
  source: text('source').default('openai_realtime').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  userCreatedIdx: index('user_input_transcripts_user_created_idx').on(table.userId, table.createdAt),
  sessionCreatedIdx: index('user_input_transcripts_session_created_idx').on(table.sessionId, table.createdAt)
}));

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

export const familyAccounts = pgTable('family_accounts', {
  id: uuid('id').defaultRandom().primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

export const familyMembers = pgTable('family_members', {
  id: uuid('id').defaultRandom().primaryKey(),
  familyId: uuid('family_id').notNull(),
  userId: text('user_id').notNull(),
  role: text('role').$type<'owner' | 'member'>().notNull(),
  displayName: text('display_name'),
  email: text('email'),
  phone: text('phone'),
  invitedAt: timestamp('invited_at', { withTimezone: true }).defaultNow().notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true })
}, (table) => ({
  familyUserIdx: uniqueIndex('family_members_family_user_uq').on(table.familyId, table.userId)
}));

export const elderProfiles = pgTable('elder_profiles', {
  id: uuid('id').defaultRandom().primaryKey(),
  familyId: uuid('family_id').notNull(),
  name: text('name').notNull(),
  ageRange: text('age_range'),
  language: text('language'),
  city: text('city'),
  timezone: text('timezone'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
});

export const elderDevices = pgTable('elder_devices', {
  id: uuid('id').defaultRandom().primaryKey(),
  elderId: uuid('elder_id').notNull(),
  serialNumber: text('serial_number').notNull(),
  firmwareVersion: text('firmware_version'),
  wifiConnected: boolean('wifi_connected').default(false).notNull(),
  linkedAt: timestamp('linked_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  elderIdx: uniqueIndex('elder_devices_elder_uq').on(table.elderId)
}));

export const nudges = pgTable('nudges', {
  id: uuid('id').defaultRandom().primaryKey(),
  elderId: uuid('elder_id').notNull(),
  createdByUserId: text('created_by_user_id').notNull(),
  type: text('type').$type<'text' | 'voice'>().notNull(),
  text: text('text'),
  voiceUrl: text('voice_url'),
  priority: text('priority').$type<'gentle' | 'important' | 'urgent'>().notNull(),
  deliveryState: text('delivery_state')
    .$type<'queued' | 'delivering' | 'delivered' | 'acknowledged' | 'failed'>()
    .notNull(),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  nudgeStateIdx: index('nudges_elder_delivery_state_scheduled_idx').on(table.elderId, table.deliveryState, table.scheduledAt)
}));

export const voiceNotes = pgTable('voice_notes', {
  id: uuid('id').defaultRandom().primaryKey(),
  elderId: uuid('elder_id').notNull(),
  uploadedByUserId: text('uploaded_by_user_id').notNull(),
  fileUrl: text('file_url').notNull(),
  mimeType: text('mime_type'),
  durationSec: integer('duration_sec'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

export const insightSnapshots = pgTable('insight_snapshots', {
  id: uuid('id').defaultRandom().primaryKey(),
  elderId: uuid('elder_id').notNull(),
  ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().default({}).notNull()
}, (table) => ({
  elderTsIdx: index('insight_snapshots_elder_ts_idx').on(table.elderId, table.ts)
}));

export const concernSignals = pgTable('concern_signals', {
  id: uuid('id').defaultRandom().primaryKey(),
  elderId: uuid('elder_id').notNull(),
  type: text('type').notNull(),
  severity: text('severity').$type<'low' | 'medium' | 'high' | 'critical'>().notNull(),
  confidence: text('confidence').$type<'low' | 'medium' | 'high'>().notNull(),
  message: text('message').notNull(),
  status: text('status').$type<'open' | 'resolved'>().default('open').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

export const alerts = pgTable('alerts', {
  id: uuid('id').defaultRandom().primaryKey(),
  elderId: uuid('elder_id').notNull(),
  concernSignalId: uuid('concern_signal_id'),
  severity: text('severity').$type<'low' | 'medium' | 'high' | 'critical'>().notNull(),
  status: text('status').$type<'open' | 'acknowledged' | 'resolved'>().default('open').notNull(),
  title: text('title').notNull(),
  details: text('details').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  elderStatusSeverityCreatedIdx: index('alerts_elder_status_severity_created_idx').on(
    table.elderId,
    table.status,
    table.severity,
    table.createdAt
  )
}));

export const alertActions = pgTable('alert_actions', {
  id: uuid('id').defaultRandom().primaryKey(),
  alertId: uuid('alert_id').notNull(),
  action: text('action').notNull(),
  actorUserId: text('actor_user_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

export const escalationPolicies = pgTable('escalation_policies', {
  id: uuid('id').defaultRandom().primaryKey(),
  elderId: uuid('elder_id').notNull(),
  quietHoursStart: text('quiet_hours_start').notNull(),
  quietHoursEnd: text('quiet_hours_end').notNull(),
  stage1NudgeDelayMin: integer('stage1_nudge_delay_min').notNull(),
  stage2FamilyAlertDelayMin: integer('stage2_family_alert_delay_min').notNull(),
  stage3EmergencyDelayMin: integer('stage3_emergency_delay_min').notNull(),
  enabledTriggers: jsonb('enabled_triggers').$type<string[]>().default([]).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  elderUnique: uniqueIndex('escalation_policies_elder_uq').on(table.elderId)
}));

export const careRoutines = pgTable('care_routines', {
  id: uuid('id').defaultRandom().primaryKey(),
  elderId: uuid('elder_id').notNull(),
  key: text('key').notNull(),
  title: text('title').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  schedule: text('schedule').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
});

export const careReminders = pgTable('care_reminders', {
  id: uuid('id').defaultRandom().primaryKey(),
  elderId: uuid('elder_id').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  scheduledTime: text('scheduled_time').notNull(),
  enabled: boolean('enabled').default(true).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
});

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  actorUserId: text('actor_user_id'),
  scope: text('scope').notNull(),
  action: text('action').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

export const authIdentities = pgTable('auth_identities', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(),
  provider: text('provider').notNull(),
  providerUserId: text('provider_user_id').notNull(),
  email: text('email'),
  phone: text('phone'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  providerIdentityUnique: uniqueIndex('auth_identities_provider_user_uq').on(table.provider, table.providerUserId)
}));

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

export const otpChallenges = pgTable('otp_challenges', {
  id: uuid('id').defaultRandom().primaryKey(),
  phone: text('phone').notNull(),
  codeHash: text('code_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
});

export const oauthLinkages = pgTable('oauth_linkages', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(),
  provider: text('provider').notNull(),
  providerUserId: text('provider_user_id').notNull(),
  linkedAt: timestamp('linked_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  linkageUnique: uniqueIndex('oauth_linkages_provider_user_uq').on(table.provider, table.providerUserId)
}));

export const authPasswords = pgTable('auth_passwords', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(),
  passwordHash: text('password_hash').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  userUnique: uniqueIndex('auth_passwords_user_uq').on(table.userId)
}));

export const authSessions = pgTable('auth_sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(),
  accessTokenHash: text('access_token_hash').notNull(),
  refreshTokenHash: text('refresh_token_hash').notNull(),
  accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }).notNull(),
  refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  accessUnique: uniqueIndex('auth_sessions_access_token_uq').on(table.accessTokenHash),
  refreshUnique: uniqueIndex('auth_sessions_refresh_token_uq').on(table.refreshTokenHash),
  userCreatedIdx: index('auth_sessions_user_created_idx').on(table.userId, table.createdAt)
}));

export const userEventStream = pgTable('user_event_stream', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(),
  eventType: text('event_type').notNull(),
  payloadJson: jsonb('payload_json').$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  userCreatedIdx: index('user_event_stream_user_created_idx').on(table.userId, table.createdAt),
  userIdIdIdx: index('user_event_stream_user_id_idx').on(table.userId, table.id)
}));

export const insightSignalEvents = pgTable('insight_signal_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  elderId: uuid('elder_id').notNull(),
  userId: text('user_id').notNull(),
  sessionId: text('session_id').notNull(),
  transcriptId: uuid('transcript_id'),
  dateKey: text('date_key').notNull(),
  sourceLanguage: text('source_language'),
  normalizedLanguage: text('normalized_language').default('en').notNull(),
  transcriptOriginal: text('transcript_original').notNull(),
  transcriptNormalized: text('transcript_normalized').notNull(),
  engagementScore: integer('engagement_score').notNull(),
  emotionalToneScore: integer('emotional_tone_score').notNull(),
  socialConnectionScore: integer('social_connection_score').notNull(),
  adherenceScore: integer('adherence_score').notNull(),
  distressScore: integer('distress_score').notNull(),
  overallScore: integer('overall_score').notNull(),
  scoreBand: text('score_band').$type<'stable' | 'watch' | 'concern'>().notNull(),
  confidence: integer('confidence').notNull(),
  dataSufficiency: integer('data_sufficiency').notNull(),
  featuresJson: jsonb('features_json').$type<Record<string, unknown>>().default({}).notNull(),
  eventTs: timestamp('event_ts', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  elderDateIdx: index('insight_signal_events_elder_date_idx').on(table.elderId, table.dateKey, table.eventTs),
  userCreatedIdx: index('insight_signal_events_user_created_idx').on(table.userId, table.createdAt)
}));

export const insightDailyScores = pgTable('insight_daily_scores', {
  id: uuid('id').defaultRandom().primaryKey(),
  elderId: uuid('elder_id').notNull(),
  dateKey: text('date_key').notNull(),
  engagementScore: integer('engagement_score').notNull(),
  emotionalToneScore: integer('emotional_tone_score').notNull(),
  socialConnectionScore: integer('social_connection_score').notNull(),
  adherenceScore: integer('adherence_score').notNull(),
  distressScore: integer('distress_score').notNull(),
  overallScore: integer('overall_score').notNull(),
  scoreBand: text('score_band').$type<'stable' | 'watch' | 'concern'>().notNull(),
  confidence: integer('confidence').notNull(),
  dataSufficiency: integer('data_sufficiency').notNull(),
  metricsJson: jsonb('metrics_json').$type<Record<string, unknown>>().default({}).notNull(),
  lastComputedAt: timestamp('last_computed_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  elderDateUnique: uniqueIndex('insight_daily_scores_elder_date_uq').on(table.elderId, table.dateKey),
  elderComputedIdx: index('insight_daily_scores_elder_computed_idx').on(table.elderId, table.lastComputedAt)
}));

export const insightRecommendations = pgTable('insight_recommendations', {
  id: uuid('id').defaultRandom().primaryKey(),
  elderId: uuid('elder_id').notNull(),
  dateKey: text('date_key').notNull(),
  recommendationType: text('recommendation_type').notNull(),
  title: text('title').notNull(),
  whyText: text('why_text').notNull(),
  actionText: text('action_text').notNull(),
  status: text('status').$type<'active' | 'accepted' | 'dismissed' | 'completed'>().default('active').notNull(),
  scoreBand: text('score_band').$type<'stable' | 'watch' | 'concern'>().notNull(),
  confidence: integer('confidence').notNull(),
  cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
  metadataJson: jsonb('metadata_json').$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  elderStatusCreatedIdx: index('insight_recommendations_elder_status_created_idx').on(
    table.elderId,
    table.status,
    table.createdAt
  )
}));

export const insightEvidenceSpans = pgTable('insight_evidence_spans', {
  id: uuid('id').defaultRandom().primaryKey(),
  elderId: uuid('elder_id').notNull(),
  signalEventId: uuid('signal_event_id'),
  recommendationId: uuid('recommendation_id'),
  concernSignalId: uuid('concern_signal_id'),
  transcriptId: uuid('transcript_id'),
  snippet: text('snippet').notNull(),
  rationale: text('rationale').notNull(),
  weight: integer('weight').default(50).notNull(),
  eventTs: timestamp('event_ts', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  elderCreatedIdx: index('insight_evidence_spans_elder_created_idx').on(table.elderId, table.createdAt),
  signalIdx: index('insight_evidence_spans_signal_idx').on(table.signalEventId)
}));

export const insightCheckins = pgTable('insight_checkins', {
  id: uuid('id').defaultRandom().primaryKey(),
  elderId: uuid('elder_id').notNull(),
  createdByUserId: text('created_by_user_id').notNull(),
  weekStartDate: text('week_start_date').notNull(),
  moodLabel: text('mood_label').$type<'better' | 'same' | 'worse'>().notNull(),
  engagementLabel: text('engagement_label').$type<'better' | 'same' | 'worse'>().notNull(),
  socialLabel: text('social_label').$type<'better' | 'same' | 'worse'>().notNull(),
  concernLevel: text('concern_level').$type<'none' | 'low' | 'medium' | 'high'>().default('none').notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  elderWeekIdx: index('insight_checkins_elder_week_idx').on(table.elderId, table.weekStartDate, table.createdAt)
}));

export const insightModelVersions = pgTable('insight_model_versions', {
  id: uuid('id').defaultRandom().primaryKey(),
  key: text('key').notNull(),
  version: text('version').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  configJson: jsonb('config_json').$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  keyVersionUnique: uniqueIndex('insight_model_versions_key_version_uq').on(table.key, table.version),
  keyActiveIdx: index('insight_model_versions_key_active_idx').on(table.key, table.isActive, table.createdAt)
}));

export const insightPipelineRuns = pgTable('insight_pipeline_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  elderId: uuid('elder_id'),
  userId: text('user_id'),
  runType: text('run_type').notNull(),
  status: text('status').$type<'started' | 'completed' | 'failed'>().notNull(),
  inputCount: integer('input_count').default(1).notNull(),
  queueLagMs: integer('queue_lag_ms'),
  errorMessage: text('error_message'),
  metadataJson: jsonb('metadata_json').$type<Record<string, unknown>>().default({}).notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true })
}, (table) => ({
  elderStartedIdx: index('insight_pipeline_runs_elder_started_idx').on(table.elderId, table.startedAt),
  statusStartedIdx: index('insight_pipeline_runs_status_started_idx').on(table.status, table.startedAt)
}));

export const insightDailyDigests = pgTable('insight_daily_digests', {
  id: uuid('id').defaultRandom().primaryKey(),
  elderId: uuid('elder_id').notNull(),
  dateKey: text('date_key').notNull(),
  summaryJson: jsonb('summary_json').$type<Record<string, unknown>>().default({}).notNull(),
  scoreBand: text('score_band').$type<'stable' | 'watch' | 'concern'>().notNull(),
  confidence: integer('confidence').notNull(),
  dataSufficiency: integer('data_sufficiency').notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  elderDateUnique: uniqueIndex('insight_daily_digests_elder_date_uq').on(table.elderId, table.dateKey),
  elderGeneratedIdx: index('insight_daily_digests_elder_generated_idx').on(table.elderId, table.generatedAt)
}));

export const insightRecommendationFeedback = pgTable('insight_recommendation_feedback', {
  id: uuid('id').defaultRandom().primaryKey(),
  recommendationId: uuid('recommendation_id').notNull(),
  elderId: uuid('elder_id').notNull(),
  userId: text('user_id').notNull(),
  action: text('action').$type<'accepted' | 'dismissed' | 'completed'>().notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  recommendationCreatedIdx: index('insight_reco_feedback_reco_created_idx').on(table.recommendationId, table.createdAt),
  elderCreatedIdx: index('insight_reco_feedback_elder_created_idx').on(table.elderId, table.createdAt)
}));

export const caregiverNotificationPreferences = pgTable('caregiver_notification_preferences', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(),
  familyId: uuid('family_id').notNull(),
  digestEnabled: boolean('digest_enabled').default(true).notNull(),
  digestHourLocal: integer('digest_hour_local').default(20).notNull(),
  digestMinuteLocal: integer('digest_minute_local').default(30).notNull(),
  timezone: text('timezone').default('Asia/Kolkata').notNull(),
  realtimeEnabled: boolean('realtime_enabled').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  userUnique: uniqueIndex('caregiver_notif_prefs_user_uq').on(table.userId),
  familyDigestIdx: index('caregiver_notif_prefs_family_digest_idx').on(table.familyId, table.digestEnabled)
}));

export const caregiverPushTokens = pgTable('caregiver_push_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: text('user_id').notNull(),
  expoPushToken: text('expo_push_token').notNull(),
  platform: text('platform').$type<'ios' | 'android' | 'unknown'>().default('unknown').notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  tokenUnique: uniqueIndex('caregiver_push_tokens_token_uq').on(table.expoPushToken),
  userActiveIdx: index('caregiver_push_tokens_user_active_idx').on(table.userId, table.isActive)
}));

export const digestDeliveryLogs = pgTable('digest_delivery_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  digestId: uuid('digest_id').notNull(),
  userId: text('user_id').notNull(),
  deliveryChannel: text('delivery_channel').$type<'expo_push' | 'in_app'>().notNull(),
  status: text('status').$type<'sent' | 'failed' | 'skipped'>().notNull(),
  providerMessageId: text('provider_message_id'),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
}, (table) => ({
  dedupeUnique: uniqueIndex('digest_delivery_logs_dedupe_uq').on(table.digestId, table.userId, table.deliveryChannel),
  userCreatedIdx: index('digest_delivery_logs_user_created_idx').on(table.userId, table.createdAt)
}));
