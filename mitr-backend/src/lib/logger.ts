import { observabilityConfig } from '../config/observability-config.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const REDACTED = '[redacted]';
const SENSITIVE_KEY_PATTERN =
  /(authorization|cookie|token|secret|password|apikey|api_key|email|phone|transcript|usertext|assistanttext|text|query|args|arguments|result|payload|body|fileurl|voiceurl)/i;

const isLogLevel = (value: unknown): value is LogLevel =>
  typeof value === 'string' && value in order;

const shouldLog = (level: LogLevel): boolean => {
  const configured = observabilityConfig.logLevel;
  const threshold = isLogLevel(configured) ? configured : 'info';
  return order[level] >= order[threshold];
};

const toSerializable = (value: unknown): unknown => {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message
    };
  }

  return redact(value);
};

const redact = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (value instanceof Error) return toSerializable(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redact(item, seen);
    }
    return output;
  }

  return value;
};

const base = (level: LogLevel, message: string, meta?: unknown): void => {
  if (!shouldLog(level)) return;

  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    service: 'mitr-backend',
    msg: message
  };

  if (meta !== undefined) {
    record.meta = toSerializable(meta);
  }

  process.stdout.write(`${JSON.stringify(record)}\n`);
};

export const logger = {
  debug: (message: string, meta?: unknown): void => base('debug', message, meta),
  info: (message: string, meta?: unknown): void => base('info', message, meta),
  warn: (message: string, meta?: unknown): void => base('warn', message, meta),
  error: (message: string, meta?: unknown): void => base('error', message, meta)
};
