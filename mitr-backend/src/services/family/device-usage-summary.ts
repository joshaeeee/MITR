import { toIsoDateKey } from '../insights/insights-scoring.js';
import type { DeviceUsageSummary } from './family-types.js';

export interface DeviceUsageSessionLike {
  startedAt: Date;
  endedAt: Date;
  durationSec: number;
}

const toMillis = (value: Date): number => value.getTime();

export const buildDeviceUsageSummary = (
  sessions: DeviceUsageSessionLike[],
  timeZone = 'Asia/Kolkata',
  now = new Date()
): DeviceUsageSummary => {
  const todayKey = toIsoDateKey(now, timeZone);

  let totalDurationSec = 0;
  let todayDurationSec = 0;
  let todaySessionCount = 0;
  let latestSession: DeviceUsageSessionLike | null = null;

  for (const session of sessions) {
    const durationSec = Math.max(0, Math.round(session.durationSec));
    totalDurationSec += durationSec;

    const sessionKey = toIsoDateKey(session.startedAt, timeZone);
    if (sessionKey === todayKey) {
      todayDurationSec += durationSec;
      todaySessionCount += 1;
    }

    if (
      !latestSession ||
      toMillis(session.endedAt) > toMillis(latestSession.endedAt) ||
      (toMillis(session.endedAt) === toMillis(latestSession.endedAt) &&
        toMillis(session.startedAt) > toMillis(latestSession.startedAt))
    ) {
      latestSession = session;
    }
  }

  return {
    totalDurationSec,
    todayDurationSec,
    sessionCount: sessions.length,
    todaySessionCount,
    lastSessionDurationSec: latestSession ? Math.max(0, Math.round(latestSession.durationSec)) : undefined,
    lastSessionStartedAt: latestSession ? latestSession.startedAt.getTime() : undefined,
    lastSessionEndedAt: latestSession ? latestSession.endedAt.getTime() : undefined,
    updatedAt: latestSession ? latestSession.endedAt.getTime() : now.getTime()
  };
};
