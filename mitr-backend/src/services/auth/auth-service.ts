import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { authIdentities, authPasswords, authSessions, otpChallenges, users } from '../../db/schema.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

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
const generateCode = (): string => (Math.floor(Math.random() * 900000) + 100000).toString();
const toEmailKey = (email: string): string => email.trim().toLowerCase();
const hashOpaqueToken = (value: string): string => createHash('sha256').update(value).digest('hex');

const hashPassword = (password: string): string => {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
};

const verifyPassword = (password: string, encoded: string): boolean => {
  if (encoded.startsWith('legacy:')) {
    const [, , legacyPassword] = encoded.split(':');
    return legacyPassword === password;
  }
  const [scheme, salt, storedHex] = encoded.split('$');
  if (scheme !== 'scrypt' || !salt || !storedHex) return false;
  const derived = scryptSync(password, salt, 64);
  const stored = Buffer.from(storedHex, 'hex');
  if (stored.length !== derived.length) return false;
  return timingSafeEqual(stored, derived);
};

const hashOtpCode = (code: string): string => createHash('sha256').update(code).digest('hex');

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
      if (existing.userId !== input.userId || existing.email !== input.email || existing.phone !== input.phone) {
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
  }): Promise<AuthUser> {
    const normalizedEmail = input.email ? toEmailKey(input.email) : undefined;

    let user: AuthUser | null = null;
    if (input.phone) user = await this.loadUserByPhone(input.phone);
    if (!user && normalizedEmail) user = await this.loadUserByEmail(normalizedEmail);

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

    if (normalizedEmail) {
      await this.ensureIdentity({
        userId: user.id,
        provider: 'email',
        providerUserId: normalizedEmail,
        email: normalizedEmail,
        phone: input.phone
      });
    }

    if (input.provider === 'apple' || input.provider === 'google') {
      const providerUserId = input.providerUserId?.trim() || normalizedEmail || `${input.provider}-${user.id}`;
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
    const accessExpiresAt = createdAt + env.AUTH_SESSION_TTL_SEC * 1000;
    const refreshExpiresAt = createdAt + env.AUTH_REFRESH_TTL_SEC * 1000;
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
    const challengeId = randomUUID();
    const code = generateCode();
    const expiresAt = now() + env.AUTH_OTP_TTL_SEC * 1000;

    await db.insert(otpChallenges).values({
      id: challengeId,
      phone,
      codeHash: hashOtpCode(code),
      expiresAt: toDate(expiresAt)
    });

    logger.info('OTP challenge created', {
      challengeId,
      phoneMasked: `${phone.slice(0, 2)}******${phone.slice(-2)}`
    });

    return {
      challengeId,
      expiresAt,
      devOtpCode: env.AUTH_DEV_OTP_BYPASS ? code : undefined
    };
  }

  async verifyOtp(input: { challengeId: string; code: string; name?: string }): Promise<{
    user: AuthUser;
    session: SessionPair;
  }> {
    const [challenge] = await db
      .select()
      .from(otpChallenges)
      .where(eq(otpChallenges.id, input.challengeId))
      .limit(1);

    if (!challenge) throw new Error('OTP challenge not found or expired');
    if (challenge.consumedAt) throw new Error('OTP challenge already consumed');
    if (challenge.expiresAt.getTime() < now()) {
      throw new Error('OTP challenge expired');
    }

    const supplied = hashOtpCode(input.code);
    const expected = challenge.codeHash;
    const bypass = env.AUTH_DEV_OTP_BYPASS && input.code === env.AUTH_DEV_OTP_CODE;
    if (!bypass) {
      const suppliedBuffer = Buffer.from(supplied, 'hex');
      const expectedBuffer = Buffer.from(expected, 'hex');
      if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) {
        throw new Error('Invalid OTP code');
      }
    }

    await db
      .update(otpChallenges)
      .set({ consumedAt: new Date() })
      .where(eq(otpChallenges.id, challenge.id));

    const user = await this.upsertUser({
      phone: challenge.phone,
      name: input.name,
      provider: 'phone',
      providerUserId: challenge.phone
    });
    const session = await this.issueSessionForUser(user);
    return { user, session };
  }

  async signupEmail(input: { email: string; password: string; name?: string }): Promise<{
    user: AuthUser;
    session: SessionPair;
  }> {
    const normalizedEmail = toEmailKey(input.email);
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
    const user = await this.loadUserByEmail(input.email);
    if (!user) throw new Error('Invalid email or password');

    const credential = await this.getPasswordCredential(user.id);
    if (!credential) throw new Error('Invalid email or password');
    if (!verifyPassword(input.password, credential)) throw new Error('Invalid email or password');
    if (credential.startsWith('legacy:')) {
      await this.setPasswordCredential(user.id, input.password);
    }

    const session = await this.issueSessionForUser(user);
    return { user, session };
  }

  async oauthLogin(input: {
    provider: 'apple' | 'google';
    email?: string;
    name?: string;
    providerUserId?: string;
  }): Promise<{ user: AuthUser; session: SessionPair }> {
    const syntheticEmail = input.email ?? `${input.providerUserId ?? randomUUID()}@${input.provider}.mitr.local`;
    const user = await this.upsertUser({
      email: syntheticEmail,
      name: input.name,
      provider: input.provider,
      providerUserId: input.providerUserId ?? syntheticEmail
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
      await db.update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.id, current.id));
      throw new Error('Refresh token expired');
    }

    const user = await this.loadUserById(current.userId);
    if (!user) {
      await db.update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.id, current.id));
      throw new Error('User no longer exists');
    }

    await db.update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.id, current.id));
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
