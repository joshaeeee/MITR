import { config } from "./config.js";

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = ORDER[(config.logLevel as Level)] ?? ORDER.info;

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (ORDER[level] < threshold) return;
  const line: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + "\n");
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
  /** Scoped child logger that prefixes fields (e.g. deviceId) on every line. */
  child: (base: Record<string, unknown>) => ({
    debug: (msg: string, f?: Record<string, unknown>) => emit("debug", msg, { ...base, ...f }),
    info: (msg: string, f?: Record<string, unknown>) => emit("info", msg, { ...base, ...f }),
    warn: (msg: string, f?: Record<string, unknown>) => emit("warn", msg, { ...base, ...f }),
    error: (msg: string, f?: Record<string, unknown>) => emit("error", msg, { ...base, ...f }),
  }),
};

export type Logger = ReturnType<typeof log.child>;
