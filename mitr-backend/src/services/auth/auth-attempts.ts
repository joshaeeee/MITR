interface AttemptBucket {
  failures: number;
  lockedUntil: number;
  resetAt: number;
}

const buckets = new Map<string, AttemptBucket>();

const now = (): number => Date.now();

const getBucket = (key: string, windowMs: number): AttemptBucket => {
  const current = buckets.get(key);
  const ts = now();
  if (current && current.resetAt > ts) return current;
  const fresh = { failures: 0, lockedUntil: 0, resetAt: ts + windowMs };
  buckets.set(key, fresh);
  return fresh;
};

export const assertAuthNotLocked = (
  key: string,
  options: { windowSec: number }
): void => {
  const bucket = getBucket(key, options.windowSec * 1000);
  if (bucket.lockedUntil > now()) {
    const retryAfterSec = Math.ceil((bucket.lockedUntil - now()) / 1000);
    throw new Error(`Too many failed attempts. Try again in ${retryAfterSec} seconds.`);
  }
};

export const recordAuthFailure = (
  key: string,
  options: { maxFailures: number; windowSec: number }
): void => {
  const windowMs = options.windowSec * 1000;
  const bucket = getBucket(key, windowMs);
  bucket.failures += 1;
  if (bucket.failures >= options.maxFailures) {
    bucket.lockedUntil = now() + windowMs;
  }
};

export const recordAuthSuccess = (key: string): void => {
  buckets.delete(key);
};
