import { randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { authIdentities, authPasswords, authSessions, otpChallenges, users } from '../../db/schema.js';
import { authConfig } from '../../config/auth-config.js';
import { logger } from '../../lib/logger.js';
import { hashShortCode } from '../../lib/short-code-hash.js';
import { assertAuthNotLocked, recordAuthFailure, recordAuthSuccess } from './auth-attempts.js';
import { canUseEmailIdentityForPrimaryLogin, shouldCreateEmailIdentity, toTrustedEmailKey } from './auth-linking-policy.js';
import { sendOtpCode } from './otp-delivery.js';
import { assertPasswordPolicy } from './password-policy.js';

export interface AuthUser {
  id: string;
  phone?: string;
  email?: string;
  name?: string;
  providers: Array<'phone' | 'email' | 'apple' | 'google'>;
  createdAt: number;
  updatedAt: number;
}

interface SessionPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

const now = (): number => Date.now();
const toDate = (value: number): Date => new Date(value);
const token = (): string => randomBytes(32).toString('hex');
const generateCode = (): string => randomInt(100000, 1000000).toString();
const toEmailKey = (email: string): string => email.trim().toLowerCase();
const hashOpaqueToken = (value: string): string => createHash('sha256').update(value).digest('hex');
const safeStringEquals = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const hashPassword = (password: string): string => {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
};

const verifyPassword = (password: string, encoded: string): boolean => {
  if (encoded.startsWith('legacy:')) {
    const [, , ...legacyPasswordParts] = encoded.split(':');
    return safeStringEquals(password, legacyPasswordParts.join(':'));
  }
  const [scheme, salt, storedHex] = encoded.split('$');
  if (scheme !== 'scrypt' || !salt || !storedHex) return false;
  const derived = scryptSync(password, salt, 64);
  const stored = Buffer.from(storedHex, 'hex');
  if (stored.length !== derived.length) return false;
  return timingSafeEqual(stored, derived);
};

const hashOtpCode = (code: string): string => hashShortCode('otp', code);

export class AuthService {
  private async loadUserById(userId: string): Promise<AuthUser | null> {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return null;

    const identities = await db.select().from(authIdentities).where(eq(authIdentities.userId, userId));
    const providers = new Set<AuthUser['providers'][number]>();
    let email: string | undefined;
    let phone: string | undefined;

    for (const identity of identities) {
      if (identity.provider === 'phone') providers.add('phone');
      if (identity.provider === 'email') providers.add('email');
      if (identity.provider === 'apple') providers.add('apple');
      if (identity.provider === 'google') providers.add('google');
      if (!email && identity.email) email = identity.email;
      if (!phone && identity.phone) phone = identity.phone;
    }

    return {
      id: user.id,
      phone,
      email,
      name: user.displayName ?? undefined,
      providers: [...providers],
      createdAt: user.createdAt.getTime(),
      updatedAt: user.createdAt.getTime()
    };
  }

  private async loadUserByEmail(email: string): Promise<AuthUser | null> {
    const normalized = toEmailKey(email);
    const [identity] = await db
      .select()
      .from(authIdentities)
      .where(and(eq(authIdentities.provider, 'email'), eq(authIdentities.providerUserId, normalized)))
      .limit(1);
    if (!identity) return null;
    return this.loadUserById(identity.userId);
  }

  private async loadUserByPhone(phone: string): Promise<AuthUser | null> {
    const [identity] = await db
      .select()
      .from(authIdentities)
      .where(and(eq(authIdentities.provider, 'phone'), eq(authIdentities.providerUserId, phone)))
      .limit(1);
    if (!identity) return null;
    return this.loadUserById(identity.userId);
  }

  private async loadUserByProvider(
    provider: 'apple' | 'google',
    providerUserId: string
  ): Promise<AuthUser | null> {
    const [identity] = await db
      .select()
      .from(authIdentities)
      .where(and(eq(authIdentities.provider, provider), eq(authIdentities.providerUserId, providerUserId)))
      .limit(1);
    if (!identity) return null;
    return this.loadUserById(identity.userId);
  }

  private async ensureIdentity(input: {
    userId: string;
    provider: 'phone' | 'email' | 'apple' | 'google';
    providerUserId: string;
    email?: string;
    phone?: string;
  }): Promise<void> {
    const [existing] = await db
      .select()
      .from(authIdentities)
      .where(and(eq(authIdentities.provider, input.provider), eq(authIdentities.providerUserId, input.providerUserId)))
      .limit(1);

    if (existing) {
      if (existing.userId !== input.userId) {
        throw new Error('Identity is already linked to another user');
      }
      if (existing.email !== input.email || existing.phone !== input.phone) {
        await db
          .update(authIdentities)
          .set({
            userId: input.userId,
            email: input.email,
            phone: input.phone
          })
          .where(eq(authIdentities.id, existing.id));
      }
      return;
    }

    await db.insert(authIdentities).values({
      userId: input.userId,
      provider: input.provider,
      providerUserId: input.providerUserId,
      email: input.email,
      phone: input.phone
    });
  }

  private async createUser(input: { name?: string }): Promise<AuthUser> {
    const [created] = await db
      .insert(users)
      .values({
        externalId: randomUUID(),
        displayName: input.name?.trim() || null
      })
      .returning();

    return {
      id: created.id,
      providers: [],
      name: created.displayName ?? undefined,
      createdAt: created.createdAt.getTime(),
      updatedAt: created.createdAt.getTime()
    };
  }

  private async upsertUser(input: {
    phone?: string;
    email?: string;
    name?: string;
    provider: 'phone' | 'email' | 'apple' | 'google';
    providerUserId?: string;
    emailVerified?: boolean;
  }): Promise<AuthUser> {
    const normalizedEmail = toTrustedEmailKey(input);

    let user: AuthUser | null = null;
    if ((input.provider === 'apple' || input.provider === 'google') && input.providerUserId) {
      user = await this.loadUserByProvider(input.provider, input.providerUserId);
    }
    if (!user && input.phone) user = await this.loadUserByPhone(input.phone);
    if (!user && normalizedEmail && canUseEmailIdentityForPrimaryLogin(input.provider)) {
      user = await this.loadUserByEmail(normalizedEmail);
    }

    if (!user) {
      user = await this.createUser({ name: input.name });
    } else if (input.name && !user.name) {
      await db.update(users).set({ displayName: input.name.trim() }).where(eq(users.id, user.id));
      user.name = input.name.trim();
    }

    if (input.phone) {
      await this.ensureIdentity({
        userId: user.id,
        provider: 'phone',
        providerUserId: input.phone,
        phone: input.phone,
        email: normalizedEmail
      });
    }

    if (normalizedEmail && shouldCreateEmailIdentity(input.provider)) {
      await this.ensureIdentity({
        userId: user.id,
        provider: 'email',
        providerUserId: normalizedEmail,
        email: normalizedEmail,
        phone: input.phone
      });
    }

    if (input.provider === 'apple' || input.provider === 'google') {
      const providerUserId = input.providerUserId?.trim();
      if (!providerUserId) throw new Error('Verified provider user id is required');
      await this.ensureIdentity({
        userId: user.id,
        provider: input.provider,
        providerUserId,
        email: normalizedEmail,
        phone: input.phone
      });
    }

    const hydrated = await this.loadUserById(user.id);
    if (!hydrated) throw new Error('Failed to hydrate user');
    return hydrated;
  }

  private async setPasswordCredential(userId: string, password: string): Promise<void> {
    const encoded = hashPassword(password);
    const [existing] = await db.select().from(authPasswords).where(eq(authPasswords.userId, userId)).limit(1);
    if (!existing) {
      await db.insert(authPasswords).values({ userId, passwordHash: encoded });
      return;
    }

    await db
      .update(authPasswords)
      .set({ passwordHash: encoded, updatedAt: new Date() })
      .where(eq(authPasswords.id, existing.id));
  }

  private async getPasswordCredential(userId: string): Promise<string | null> {
    const [credential] = await db
      .select({ passwordHash: authPasswords.passwordHash })
      .from(authPasswords)
      .where(eq(authPasswords.userId, userId))
      .limit(1);
    return credential?.passwordHash ?? null;
  }

  private async issueSessionForUser(user: AuthUser): Promise<SessionPair> {
    const createdAt = now();
    const accessExpiresAt = createdAt + authConfig.sessionTtlSec * 1000;
    const refreshExpiresAt = createdAt + authConfig.refreshTtlSec * 1000;
    const accessToken = token();
    const refreshToken = token();

    await db.insert(authSessions).values({
      userId: user.id,
      accessTokenHash: hashOpaqueToken(accessToken),
      refreshTokenHash: hashOpaqueToken(refreshToken),
      accessExpiresAt: toDate(accessExpiresAt),
      refreshExpiresAt: toDate(refreshExpiresAt)
    });

    return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
  }

  async startOtp(phone: string): Promise<{ challengeId: string; expiresAt: number; devOtpCode?: string }> {
    if (!authConfig.devOtpBypassEnabled && authConfig.otpDeliveryMode === 'disabled') {
      throw new Error('Phone OTP login is not configured');
    }

    const challengeId = randomUUID();
    const code = generateCode();
    const expiresAt = now() + authConfig.otpTtlSec * 1000;

    await db.insert(otpChallenges).values({
      id: challengeId,
      phone,
      codeHash: hashOtpCode(code),
      expiresAt: toDate(expiresAt)
    });

    try {
      await sendOtpCode(phone, code);
    } catch (error) {
      await db.update(otpChallenges).set({ consumedAt: new Date() }).where(eq(otpChallenges.id, challengeId));
      throw error;
    }

    logger.info('OTP challenge created', {
      challengeId,
      phoneMasked: `${phone.slice(0, 2)}******${phone.slice(-2)}`
    });

    return {
      challengeId,
      expiresAt,
      devOtpCode: authConfig.devOtpBypassEnabled || authConfig.otpDeliveryMode === 'dev_log' ? code : undefined
    };
  }

  async verifyOtp(input: { challengeId: string; code: string; name?: string }): Promise<{
    user: AuthUser;
    session: SessionPair;
  }> {
    const attemptKey = `otp:${input.challengeId}`;
    const attemptOptions = {
      maxFailures: authConfig.lockoutMaxFailures,
      windowSec: authConfig.lockoutWindowSec
    };
    assertAuthNotLocked(attemptKey, attemptOptions);

    const [challenge] = await db
      .select()
      .from(otpChallenges)
      .where(eq(otpChallenges.id, input.challengeId))
      .limit(1);

    if (!challenge) {
      recordAuthFailure(attemptKey, attemptOptions);
      throw new Error('OTP challenge not found or expired');
    }
    if (challenge.consumedAt) {
      recordAuthFailure(attemptKey, attemptOptions);
      throw new Error('OTP challenge already consumed');
    }
    if (challenge.expiresAt.getTime() < now()) {
      recordAuthFailure(attemptKey, attemptOptions);
      throw new Error('OTP challenge expired');
    }

    const supplied = hashOtpCode(input.code);
    const expected = challenge.codeHash;
    const bypass = authConfig.devOtpBypassEnabled && input.code === authConfig.devOtpCode;
    if (!bypass) {
      const suppliedBuffer = Buffer.from(supplied, 'hex');
      const expectedBuffer = Buffer.from(expected, 'hex');
      if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) {
        recordAuthFailure(attemptKey, attemptOptions);
        throw new Error('Invalid OTP code');
      }
    }

    const [consumedChallenge] = await db
      .update(otpChallenges)
      .set({ consumedAt: new Date() })
      .where(and(eq(otpChallenges.id, challenge.id), isNull(otpChallenges.consumedAt)))
      .returning({ id: otpChallenges.id });
    if (!consumedChallenge) {
      recordAuthFailure(attemptKey, attemptOptions);
      throw new Error('OTP challenge already consumed');
    }

    const user = await this.upsertUser({
      phone: challenge.phone,
      name: input.name,
      provider: 'phone',
      providerUserId: challenge.phone
    });
    recordAuthSuccess(attemptKey);
    const session = await this.issueSessionForUser(user);
    return { user, session };
  }

  async signupEmail(input: { email: string; password: string; name?: string }): Promise<{
    user: AuthUser;
    session: SessionPair;
  }> {
    const normalizedEmail = toEmailKey(input.email);
    assertPasswordPolicy({
      email: normalizedEmail,
      name: input.name,
      password: input.password
    });
    const existing = await this.loadUserByEmail(normalizedEmail);
    if (existing) throw new Error('Email already in use');

    const user = await this.upsertUser({
      email: normalizedEmail,
      name: input.name,
      provider: 'email',
      providerUserId: normalizedEmail
    });

    await this.setPasswordCredential(user.id, input.password);
    const session = await this.issueSessionForUser(user);
    return { user, session };
  }

  async loginEmail(input: { email: string; password: string }): Promise<{
    user: AuthUser;
    session: SessionPair;
  }> {
    const normalizedEmail = toEmailKey(input.email);
    const attemptKey = `email:${normalizedEmail}`;
    const attemptOptions = {
      maxFailures: authConfig.lockoutMaxFailures,
      windowSec: authConfig.lockoutWindowSec
    };
    assertAuthNotLocked(attemptKey, attemptOptions);

    const user = await this.loadUserByEmail(normalizedEmail);
    if (!user) {
      recordAuthFailure(attemptKey, attemptOptions);
      throw new Error('Invalid email or password');
    }

    const credential = await this.getPasswordCredential(user.id);
    if (!credential) {
      recordAuthFailure(attemptKey, attemptOptions);
      throw new Error('Invalid email or password');
    }
    if (!verifyPassword(input.password, credential)) {
      recordAuthFailure(attemptKey, attemptOptions);
      throw new Error('Invalid email or password');
    }
    if (credential.startsWith('legacy:')) {
      await this.setPasswordCredential(user.id, input.password);
    }

    recordAuthSuccess(attemptKey);
    const session = await this.issueSessionForUser(user);
    return { user, session };
  }

  async oauthLogin(input: {
    provider: 'apple' | 'google';
    email?: string;
    emailVerified: boolean;
    name?: string;
    providerUserId: string;
  }): Promise<{ user: AuthUser; session: SessionPair }> {
    const user = await this.upsertUser({
      email: input.email,
      emailVerified: input.emailVerified,
      name: input.name,
      provider: input.provider,
      providerUserId: input.providerUserId
    });

    const session = await this.issueSessionForUser(user);
    return { user, session };
  }

  async getUserFromAccessToken(accessToken: string): Promise<AuthUser | null> {
    const hash = hashOpaqueToken(accessToken);
    const [session] = await db
      .select()
      .from(authSessions)
      .where(and(eq(authSessions.accessTokenHash, hash), isNull(authSessions.revokedAt), gt(authSessions.accessExpiresAt, new Date())))
      .limit(1);

    if (!session) return null;
    return this.loadUserById(session.userId);
  }

  async refresh(input: { refreshToken: string }): Promise<{ user: AuthUser; session: SessionPair }> {
    const hash = hashOpaqueToken(input.refreshToken);
    const [current] = await db
      .select()
      .from(authSessions)
      .where(and(eq(authSessions.refreshTokenHash, hash), isNull(authSessions.revokedAt)))
      .limit(1);

    if (!current) throw new Error('Invalid refresh token');
    if (current.refreshExpiresAt.getTime() < now()) {
      await db
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(authSessions.id, current.id), isNull(authSessions.revokedAt)));
      throw new Error('Refresh token expired');
    }

    const user = await this.loadUserById(current.userId);
    if (!user) {
      await db
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(authSessions.id, current.id), isNull(authSessions.revokedAt)));
      throw new Error('User no longer exists');
    }

    const [revokedCurrentSession] = await db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(authSessions.id, current.id), isNull(authSessions.revokedAt)))
      .returning({ id: authSessions.id });
    if (!revokedCurrentSession) throw new Error('Invalid refresh token');

    const session = await this.issueSessionForUser(user);
    return { user, session };
  }

  async logout(accessToken: string): Promise<void> {
    const hash = hashOpaqueToken(accessToken);
    await db
      .update(authSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(authSessions.accessTokenHash, hash), isNull(authSessions.revokedAt)));
  }

  async getUserByEmail(email: string): Promise<AuthUser | null> {
    return this.loadUserByEmail(email);
  }

  async getUserByPhone(phone: string): Promise<AuthUser | null> {
    return this.loadUserByPhone(phone);
  }
}
