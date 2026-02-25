import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { reminders } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { scheduleReminderJob } from './queue.js';
import { validateReminderDatetime } from './reminder-time.js';

export interface ReminderInput {
  userId: string;
  title: string;
  datetimeISO: string;
  recurrence?: string;
  locale?: string;
  language?: string;
}

export class ReminderService {
  async create(input: ReminderInput): Promise<{ id: string }> {
    let delayMs: number;
    try {
      ({ delayMs } = validateReminderDatetime(input.datetimeISO));
    } catch (error) {
      logger.warn('Reminder validation failed', {
        userId: input.userId,
        title: input.title,
        datetimeISO: input.datetimeISO,
        error: (error as Error).message
      });
      throw error;
    }

    const [row] = await db
      .insert(reminders)
      .values({
        userId: input.userId,
        title: input.title,
        datetimeIso: input.datetimeISO,
        recurrence: input.recurrence,
        locale: input.locale ?? 'en-IN'
      })
      .returning({ id: reminders.id });

    await scheduleReminderJob(
      {
        reminderId: row.id,
        userId: input.userId,
        title: input.title,
        language: input.language
      },
      delayMs
    );

    logger.info('Reminder scheduled', {
      reminderId: row.id,
      userId: input.userId,
      delayMs
    });

    return row;
  }

  async listByUser(userId: string): Promise<Array<{ id: string; title: string; datetimeISO: string; recurrence: string | null }>> {
    const rows = await db
      .select({ id: reminders.id, title: reminders.title, datetimeISO: reminders.datetimeIso, recurrence: reminders.recurrence })
      .from(reminders)
      .where(eq(reminders.userId, userId));

    return rows;
  }

  async acknowledge(userId: string, reminderId: string): Promise<void> {
    await db
      .update(reminders)
      .set({ acknowledged: true })
      .where(and(eq(reminders.id, reminderId), eq(reminders.userId, userId)));
  }
}
