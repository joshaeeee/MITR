import 'fastify';
import type { AuthContext } from '../services/auth/auth-middleware.js';
import type { DeviceAuthContext } from '../services/device/device-auth.js';
import type { InternalServiceAuthContext } from '../services/auth/internal-service-auth.js';
import type { CheckoutAdminAuthContext } from '../services/checkout/checkout-admin-auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
    deviceAuth?: DeviceAuthContext;
    internalAuth?: InternalServiceAuthContext;
    checkoutAdminAuth?: CheckoutAdminAuthContext;
    rawBody?: string;
  }
}
