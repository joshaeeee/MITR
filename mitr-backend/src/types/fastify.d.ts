import 'fastify';
import type { AuthContext } from '../services/auth/auth-middleware.js';
import type { DeviceAuthContext } from '../services/device/device-auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
    deviceAuth?: DeviceAuthContext;
  }
}
