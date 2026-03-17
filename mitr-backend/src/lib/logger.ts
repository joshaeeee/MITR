type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const isLogLevel = (value: unknown): value is LogLevel =>
  typeof value === 'string' && value in order;

const shouldLog = (level: LogLevel): boolean => {
  const configured = process.env.LOG_LEVEL;
  const threshold = isLogLevel(configured) ? configured : 'info';
  return order[level] >= order[threshold];
};

const toSerializable = (value: unknown): unknown => {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }

  if (value && typeof value === 'object') {
    try {
      JSON.stringify(value);
      return value;
    } catch {
      return String(value);
    }
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
