import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';

export interface InternalServiceAuthContext {
  service: 'internal';
}

export const INTERNAL_SERVICE_TOKEN_HEADER = 'x-internal-service-token';

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
  if (typeof presentedToken !== 'string' || presentedToken.trim() !== expectedToken) {
    void reply.status(401).send({ error: 'Invalid internal service token' });
    return;
  }

  request.internalAuth = { service: 'internal' };
};
