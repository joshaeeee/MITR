import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

type JournalEntry = {
  idx: number;
  tag: string;
  when: number;
};

type BaselineTarget = {
  tag: string;
  checks: string[];
};

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../drizzle');
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, 'meta/_journal.json');
const BASELINE_TARGETS: BaselineTarget[] = [
  {
    tag: '0000_chemical_blink',
    checks: [
      "to_regclass('public.conversation_turns') is not null",
      "to_regclass('public.long_sessions') is not null",
      "to_regclass('public.users') is not null"
    ]
  },
  {
    tag: '0001_sad_norrin_radd',
    checks: [
      "exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'long_sessions' and column_name = 'version')",
      "exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'long_sessions' and column_name = 'metadata_json')",
      "to_regclass('public.long_sessions_user_status_idx') is not null"
    ]
  },
  {
    tag: '0002_sparkling_raider',
    checks: [
      "to_regclass('public.alerts') is not null",
      "to_regclass('public.elder_profiles') is not null",
      "to_regclass('public.family_accounts') is not null"
    ]
  },
  {
    tag: '0003_unified_sync',
    checks: [
      "to_regclass('public.user_profiles') is not null",
      "to_regclass('public.auth_passwords') is not null",
      "to_regclass('public.auth_sessions') is not null",
      "to_regclass('public.user_event_stream') is not null",
      "exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = 'display_name')"
    ]
  },
  {
    tag: '0004_user_input_transcripts',
    checks: [
      "to_regclass('public.user_input_transcripts') is not null",
      "to_regclass('public.user_input_transcripts_user_created_idx') is not null",
      "to_regclass('public.user_input_transcripts_session_created_idx') is not null"
    ]
  },
  {
    tag: '0005_insights_pipeline',
    checks: [
      "to_regclass('public.insight_signal_events') is not null",
      "to_regclass('public.insight_daily_scores') is not null",
      "to_regclass('public.insight_recommendations') is not null",
      "to_regclass('public.insight_pipeline_runs') is not null"
    ]
  },
  {
    tag: '0006_daily_digest_and_feedback',
    checks: [
      "to_regclass('public.insight_daily_digests') is not null",
      "to_regclass('public.insight_recommendation_feedback') is not null",
      "to_regclass('public.caregiver_notification_preferences') is not null",
      "to_regclass('public.caregiver_push_tokens') is not null",
      "to_regclass('public.digest_delivery_logs') is not null"
    ]
  },
  {
    tag: '0007_elder_device_usage_sessions',
    checks: [
      "to_regclass('public.elder_device_usage_sessions') is not null",
      "to_regclass('public.elder_device_usage_sessions_session_uq') is not null"
    ]
  },
  {
    tag: '0008_care_plan_items',
    checks: [
      "to_regclass('public.care_plan_items') is not null",
      "to_regclass('public.care_plan_items_elder_section_sort_idx') is not null"
    ]
  }
];

const loadJournal = (): JournalEntry[] => {
  const parsed = JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8')) as { entries: JournalEntry[] };
  return parsed.entries;
};

const hashMigration = (tag: string): string => {
  const sqlPath = path.join(MIGRATIONS_DIR, `${tag}.sql`);
  const sql = fs.readFileSync(sqlPath, 'utf8');
  return crypto.createHash('sha256').update(sql).digest('hex');
};

const main = async (): Promise<void> => {
  const postgresUrl = process.env.POSTGRES_URL?.trim();
  if (!postgresUrl) {
    throw new Error('POSTGRES_URL is required');
  }

  const journalByTag = new Map(loadJournal().map((entry) => [entry.tag, entry]));
  const client = new Client({ connectionString: postgresUrl });
  await client.connect();

  try {
    await client.query('create schema if not exists drizzle');
    await client.query(`
      create table if not exists drizzle.__drizzle_migrations (
        id serial primary key,
        hash text not null,
        created_at bigint
      )
    `);

    const existing = await client.query<{ created_at: string }>(
      'select created_at from drizzle.__drizzle_migrations'
    );
    const existingCreatedAt = new Set(existing.rows.map((row) => Number(row.created_at)));

    const inserted: string[] = [];
    const skipped: string[] = [];

    for (const target of BASELINE_TARGETS) {
      const journalEntry = journalByTag.get(target.tag);
      if (!journalEntry) {
        throw new Error(`Missing journal entry for ${target.tag}`);
      }

      const checkSql = `select ${target.checks.map((check, index) => `${check} as c${index}`).join(', ')}`;
      const checkResult = await client.query<Record<string, boolean>>(checkSql);
      const row = checkResult.rows[0];
      const failedChecks = Object.entries(row)
        .filter(([, passed]) => !passed)
        .map(([column]) => target.checks[Number(column.slice(1))]);

      if (failedChecks.length > 0) {
        throw new Error(
          `Cannot baseline ${target.tag}: required legacy schema is missing:\n- ${failedChecks.join('\n- ')}`
        );
      }

      if (existingCreatedAt.has(journalEntry.when)) {
        skipped.push(target.tag);
        continue;
      }

      await client.query(
        'insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)',
        [hashMigration(target.tag), journalEntry.when]
      );
      inserted.push(target.tag);
    }

    process.stdout.write(
      `${JSON.stringify(
        {
          inserted,
          skipped,
          migrationsTable: 'drizzle.__drizzle_migrations'
        },
        null,
        2
      )}\n`
    );
  } finally {
    await client.end();
  }
};

void main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
