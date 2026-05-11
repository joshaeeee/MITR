import type { FastifyReply } from 'fastify';

export const setSecurityHeaders = (reply: FastifyReply): void => {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('x-frame-options', 'DENY');
  reply.header('cross-origin-resource-policy', 'same-site');
  reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
};
