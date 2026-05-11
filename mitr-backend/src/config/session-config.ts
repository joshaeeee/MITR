const USER_HISTORY_TTL_SEC = 60 * 60 * 24 * 30;
const USER_HISTORY_MAX_TURNS = 300;
const USER_EVENTS_TTL_SEC = 60 * 60 * 24 * 30;
const USER_EVENTS_MAX = 200;

const readNumberEnv = (key: string, defaultValue: number): number => {
  const value = process.env[key]?.trim();
  if (!value) return defaultValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
};

export const sessionConfig = Object.freeze({
  get deviceTokenTtlSec() {
    return readNumberEnv('DEVICE_TOKEN_TTL_SEC', 86_400);
  },
  get terminatedSessionTtlSec() {
    return Math.min(readNumberEnv('DEVICE_TOKEN_TTL_SEC', 86_400), 3600);
  },
  get idleTimeoutSec() {
    return readNumberEnv('SESSION_IDLE_TIMEOUT_SEC', 1_800);
  },
  get deviceConversationIdleTimeoutSec() {
    return Math.max(1, Math.ceil(readNumberEnv('DEVICE_CONVERSATION_IDLE_TIMEOUT_MS', 20_000) / 1000));
  },
  get userHistoryTtlSec() {
    return USER_HISTORY_TTL_SEC;
  },
  get userHistoryMaxTurns() {
    return USER_HISTORY_MAX_TURNS;
  },
  get userEventsTtlSec() {
    return USER_EVENTS_TTL_SEC;
  },
  get userEventsMax() {
    return USER_EVENTS_MAX;
  }
});
