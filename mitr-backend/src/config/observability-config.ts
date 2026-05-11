import path from 'node:path';

const readLogLevel = (): string => process.env.LOG_LEVEL?.trim() || 'info';

export const observabilityConfig = Object.freeze({
  get logLevel() {
    return readLogLevel();
  },
  get localLatencyTrackingEnabled() {
    return process.env.NODE_ENV !== 'production';
  },
  get localLatencyTrackingFile() {
    const configured = process.env.LOCAL_LATENCY_TRACKING_FILE?.trim();
    return path.resolve(configured && configured.length > 0 ? configured : path.join(process.cwd(), 'var', 'latency-turns.jsonl'));
  },
  healthCheckTimeoutMs: 3000
});
