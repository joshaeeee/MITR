import { getCurrentDateTimeContext } from '../../lib/current-datetime.js';

export const validateReminderDatetime = (datetimeISO: string, nowMs = Date.now()): { fireAtMs: number; delayMs: number } => {
  const fireAtMs = new Date(datetimeISO).getTime();
  if (Number.isNaN(fireAtMs)) {
    throw new Error('Invalid datetimeISO: expected a valid ISO datetime string.');
  }

  const delayMs = fireAtMs - nowMs;
  if (delayMs < 0) {
    const currentDateTime = getCurrentDateTimeContext(new Date(nowMs));
    throw new Error(
      `Reminder datetime is in the past relative to current India time ${currentDateTime.dateTimeISO}. Please provide a future time.`
    );
  }

  return { fireAtMs, delayMs };
};
