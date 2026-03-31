import { env } from './env.js';

const USER_HISTORY_TTL_SEC = 60 * 60 * 24 * 30;
const USER_HISTORY_MAX_TURNS = 300;
const USER_EVENTS_TTL_SEC = 60 * 60 * 24 * 30;
const USER_EVENTS_MAX = 200;

export const sessionConfig = Object.freeze({
  get deviceTokenTtlSec() {
    return env.DEVICE_TOKEN_TTL_SEC;
  },
  get terminatedSessionTtlSec() {
    return Math.min(env.DEVICE_TOKEN_TTL_SEC, 3600);
  },
  get idleTimeoutSec() {
    return env.SESSION_IDLE_TIMEOUT_SEC;
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
