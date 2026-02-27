import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService, AuthUser } from './auth-service.js';

export interface AuthContext {
  user: AuthUser;
  accessToken: string;
}

const parseBearer = (header?: string): string | null => {
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== 'bearer') return null;
  return token.trim();
};

export const requireAuth =
  (authService: AuthService) =>
  async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const token = parseBearer(request.headers.authorization);
    if (!token) {
      void reply.status(401).send({ error: 'Missing bearer token' });
      return;
    }

    const user = await authService.getUserFromAccessToken(token);
    if (!user) {
      void reply.status(401).send({ error: 'Invalid or expired access token' });
      return;
    }

    request.auth = { user, accessToken: token };
  };
