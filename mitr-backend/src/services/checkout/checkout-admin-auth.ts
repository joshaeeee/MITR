import type { FastifyReply, FastifyRequest } from 'fastify';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { pgPool } from '../../db/client.js';
import { logger } from '../../lib/logger.js';

export const CHECKOUT_ADMIN_SERVICE_TOKEN_HEADER = 'x-checkout-admin-service-token';
export const CHECKOUT_ADMIN_SESSION_TOKEN_HEADER = 'x-checkout-admin-session-token';
export const CHECKOUT_ADMIN_SESSION_TTL_SEC = 8 * 60 * 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CheckoutAdminSessionPayload {
  v: 1;
  sub: string;
  iat: number;
  exp: number;
  nonce: string;
  credentialVersion: string;
}

export interface CheckoutAdminAuthContext {
  adminId: string;
  email: string;
  role: 'owner' | 'admin';
  mustChangePassword: boolean;
}

const safeTokenEquals = (presentedToken: string, expectedToken: string): boolean => {
  const presented = Buffer.from(presentedToken.trim());
  const expected = Buffer.from(expectedToken);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
};

const signSessionPayload = (encodedPayload: string, secret: string): string =>
  createHmac('sha256', secret).update(encodedPayload).digest('base64url');

export const checkoutAdminCredentialVersion = (passwordHash: string, secret: string): string =>
  createHmac('sha256', secret).update(`credential:${passwordHash}`).digest('base64url');

export const createCheckoutAdminSessionToken = (
  adminId: string,
  secret: string,
  credentialVersion: string,
  nowMs = Date.now(),
  nonce = randomBytes(18).toString('base64url')
): string => {
  if (!UUID_RE.test(adminId)) throw new Error('Checkout admin id must be a UUID');
  if (!secret) throw new Error('Checkout admin auth token secret is not configured');
  if (!credentialVersion) throw new Error('Checkout admin credential version is required');
  const issuedAt = Math.floor(nowMs / 1000);
  const payload: CheckoutAdminSessionPayload = {
    v: 1,
    sub: adminId,
    iat: issuedAt,
    exp: issuedAt + CHECKOUT_ADMIN_SESSION_TTL_SEC,
    nonce,
    credentialVersion
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encodedPayload}.${signSessionPayload(encodedPayload, secret)}`;
};

export const verifyCheckoutAdminSessionToken = (
  token: string,
  secret: string,
  nowMs = Date.now()
): CheckoutAdminSessionPayload | null => {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encodedPayload, presentedSignature] = parts;
  if (!encodedPayload || !presentedSignature) return null;
  const expectedSignature = signSessionPayload(encodedPayload, secret);
  if (!safeTokenEquals(presentedSignature, expectedSignature)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Partial<CheckoutAdminSessionPayload>;
    const nowSec = Math.floor(nowMs / 1000);
    if (
      payload.v !== 1 ||
      typeof payload.sub !== 'string' ||
      !UUID_RE.test(payload.sub) ||
      typeof payload.iat !== 'number' ||
      !Number.isInteger(payload.iat) ||
      typeof payload.exp !== 'number' ||
      !Number.isInteger(payload.exp) ||
      typeof payload.nonce !== 'string' ||
      payload.nonce.length < 16 ||
      typeof payload.credentialVersion !== 'string' ||
      payload.credentialVersion.length < 32 ||
      payload.iat > nowSec + 60 ||
      payload.exp <= nowSec ||
      payload.exp - payload.iat !== CHECKOUT_ADMIN_SESSION_TTL_SEC
    ) {
      return null;
    }
    return payload as CheckoutAdminSessionPayload;
  } catch {
    return null;
  }
};

export const issueCheckoutAdminSessionToken = (adminId: string, passwordHash: string): string => {
  const secret = env.CHECKOUT_ADMIN_AUTH_TOKEN_SECRET ?? '';
  return createCheckoutAdminSessionToken(
    adminId,
    secret,
    checkoutAdminCredentialVersion(passwordHash, secret)
  );
};

export const requireCheckoutAdminServiceAuth = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  const expectedToken = env.CHECKOUT_ADMIN_SERVICE_TOKEN;
  if (!expectedToken) {
    void reply.status(503).send({
      error: 'Checkout admin service authentication is not configured',
      code: 'checkout_admin_service_auth_not_configured'
    });
    return;
  }

  const presentedToken = request.headers[CHECKOUT_ADMIN_SERVICE_TOKEN_HEADER];
  if (typeof presentedToken !== 'string' || !safeTokenEquals(presentedToken, expectedToken)) {
    void reply.status(401).send({
      error: 'Invalid checkout admin service token',
      code: 'invalid_checkout_admin_service_token'
    });
  }
};

const authenticateCheckoutAdminSession = async (
  request: FastifyRequest,
  reply: FastifyReply,
  allowPasswordChangeRequired: boolean
): Promise<void> => {
  const presentedToken = request.headers[CHECKOUT_ADMIN_SESSION_TOKEN_HEADER];
  const payload = typeof presentedToken === 'string'
    ? verifyCheckoutAdminSessionToken(presentedToken, env.CHECKOUT_ADMIN_AUTH_TOKEN_SECRET ?? '')
    : null;
  if (!payload) {
    void reply.status(401).send({
      error: 'Invalid or expired checkout admin session',
      code: 'invalid_checkout_admin_session'
    });
    return;
  }

  try {
    const result = await pgPool.query<{
      id: string;
      email: string;
      role: 'owner' | 'admin';
      is_active: boolean;
      must_change_password: boolean;
      password_hash: string;
    }>(
      `select id, email, role, is_active, must_change_password, password_hash
       from checkout_admin_users
       where id = $1`,
      [payload.sub]
    );
    const admin = result.rows[0];
    if (!admin || !admin.is_active) {
      void reply.status(401).send({
        error: 'Checkout admin session is no longer active',
        code: 'inactive_checkout_admin_session'
      });
      return;
    }
    const expectedCredentialVersion = checkoutAdminCredentialVersion(
      admin.password_hash,
      env.CHECKOUT_ADMIN_AUTH_TOKEN_SECRET ?? ''
    );
    if (!safeTokenEquals(payload.credentialVersion, expectedCredentialVersion)) {
      void reply.status(401).send({
        error: 'Checkout admin session is no longer valid',
        code: 'stale_checkout_admin_session'
      });
      return;
    }
    if (admin.must_change_password && !allowPasswordChangeRequired) {
      void reply.status(403).send({
        error: 'Admin password must be changed before continuing',
        code: 'checkout_admin_password_change_required'
      });
      return;
    }
    request.checkoutAdminAuth = {
      adminId: admin.id,
      email: admin.email,
      role: admin.role,
      mustChangePassword: admin.must_change_password
    };
  } catch (error) {
    logger.error('Checkout admin session lookup failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    void reply.status(500).send({
      error: 'Could not validate checkout admin session',
      code: 'checkout_admin_session_validation_failed'
    });
  }
};

export const requireCheckoutAdminSessionAuth = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => authenticateCheckoutAdminSession(request, reply, false);

export const requireCheckoutAdminSessionForPasswordChange = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => authenticateCheckoutAdminSession(request, reply, true);

export const requireCheckoutAdminOwner = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> => {
  if (request.checkoutAdminAuth?.role !== 'owner') {
    void reply.status(403).send({
      error: 'Only owner admins can perform this action',
      code: 'checkout_admin_owner_required'
    });
  }
};
