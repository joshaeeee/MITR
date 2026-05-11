import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';

type RateLimitKeyFn = (request: FastifyRequest) => string;

interface RateLimitOptions {
  keyPrefix: string;
  windowMs: number;
  max: number;
  key?: RateLimitKeyFn;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

const cleanup = (now: number): void => {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
};

const defaultKey: RateLimitKeyFn = (request) => request.ip || request.socket.remoteAddress || 'unknown';

const normalizeDiscriminator = (value: string): string => value.trim().toLowerCase().slice(0, 512);

export const rateLimitKeyDigest = (value: string): string =>
  createHash('sha256').update(normalizeDiscriminator(value)).digest('hex');

export const createRateLimit = (options: RateLimitOptions) => {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const now = Date.now();
    cleanup(now);

    const discriminator = options.key ? options.key(request) : defaultKey(request);
    const key = `${options.keyPrefix}:${rateLimitKeyDigest(discriminator)}`;
    const current = buckets.get(key);
    const bucket = current && current.resetAt > now
      ? current
      : { count: 0, resetAt: now + options.windowMs };

    bucket.count += 1;
    buckets.set(key, bucket);

    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    reply.header('x-ratelimit-limit', String(options.max));
    reply.header('x-ratelimit-remaining', String(Math.max(0, options.max - bucket.count)));
    reply.header('x-ratelimit-reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > options.max) {
      reply.header('retry-after', String(retryAfterSec));
      void reply.status(429).send({ error: 'Too many requests. Please try again later.' });
    }
  };
};

export const bodyFieldKey = (field: string): RateLimitKeyFn => (request) => {
  const body = request.body && typeof request.body === 'object'
    ? (request.body as Record<string, unknown>)
    : {};
  const value = body[field];
  return `${defaultKey(request)}:${typeof value === 'string' ? normalizeDiscriminator(value) : ''}`;
};

export const bodyFieldsKey = (fields: string[]): RateLimitKeyFn => (request) => {
  const body = request.body && typeof request.body === 'object'
    ? (request.body as Record<string, unknown>)
    : {};
  const parts = fields.map((field) => {
    const value = body[field];
    return `${field}=${typeof value === 'string' ? normalizeDiscriminator(value) : ''}`;
  });
  return `${defaultKey(request)}:${parts.join(':')}`;
};
