import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';

export interface InternalServiceAuthContext {
  service: 'internal';
}

export const INTERNAL_SERVICE_TOKEN_HEADER = 'x-internal-service-token';

const safeTokenEquals = (presentedToken: string, expectedToken: string): boolean => {
  const presented = Buffer.from(presentedToken.trim());
  const expected = Buffer.from(expectedToken);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
};

export const requireInternalServiceAuth = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  const expectedToken = env.INTERNAL_SERVICE_TOKEN;
  if (!expectedToken) {
    void reply.status(503).send({ error: 'Internal service authentication is not configured' });
    return;
  }

  const presentedToken = request.headers[INTERNAL_SERVICE_TOKEN_HEADER];
  if (typeof presentedToken !== 'string' || !safeTokenEquals(presentedToken, expectedToken)) {
    void reply.status(401).send({ error: 'Invalid internal service token' });
    return;
  }

  request.internalAuth = { service: 'internal' };
};
