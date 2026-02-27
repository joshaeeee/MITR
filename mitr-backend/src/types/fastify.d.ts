import 'fastify';
import type { AuthContext } from '../services/auth/auth-middleware.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}
