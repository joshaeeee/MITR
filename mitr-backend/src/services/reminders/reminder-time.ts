export const validateReminderDatetime = (datetimeISO: string, nowMs = Date.now()): { fireAtMs: number; delayMs: number } => {
  const fireAtMs = new Date(datetimeISO).getTime();
  if (Number.isNaN(fireAtMs)) {
    throw new Error('Invalid datetimeISO: expected a valid ISO datetime string.');
  }

  const delayMs = fireAtMs - nowMs;
  if (delayMs < 0) {
    throw new Error('Reminder datetime is in the past. Please provide a future time.');
  }

  return { fireAtMs, delayMs };
};
