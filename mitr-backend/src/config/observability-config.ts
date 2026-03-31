import path from 'node:path';
import { env } from './env.js';

export const observabilityConfig = Object.freeze({
  get logLevel() {
    return env.LOG_LEVEL;
  },
  get localLatencyTrackingEnabled() {
    return env.NODE_ENV !== 'production';
  },
  get localLatencyTrackingFile() {
    const configured = env.LOCAL_LATENCY_TRACKING_FILE?.trim();
    return path.resolve(configured && configured.length > 0 ? configured : path.join(process.cwd(), 'var', 'latency-turns.jsonl'));
  },
  healthCheckTimeoutMs: 3000
});
