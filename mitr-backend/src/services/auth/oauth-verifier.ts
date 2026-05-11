import { createPublicKey, createVerify } from 'node:crypto';
import type { JsonWebKey } from 'node:crypto';
import { env } from '../../config/env.js';

type OAuthProvider = 'apple' | 'google';

export interface VerifiedOAuthIdentity {
  provider: OAuthProvider;
  providerUserId: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface JwtPayload {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
}

interface JwksKey {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

interface JwksCacheEntry {
  expiresAt: number;
  keys: JwksKey[];
}

const jwksCache = new Map<string, JwksCacheEntry>();
const JWKS_CACHE_MS = 60 * 60 * 1000;

const providerConfig = {
  google: {
    issuer: new Set(['https://accounts.google.com', 'accounts.google.com']),
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
    audiences: () => parseCsv(env.GOOGLE_OAUTH_CLIENT_IDS)
  },
  apple: {
    issuer: new Set(['https://appleid.apple.com']),
    jwksUrl: 'https://appleid.apple.com/auth/keys',
    audiences: () => parseCsv(env.APPLE_OAUTH_CLIENT_IDS)
  }
} satisfies Record<OAuthProvider, {
  issuer: Set<string>;
  jwksUrl: string;
  audiences: () => string[];
}>;

const parseCsv = (value?: string): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const decodeBase64Url = (value: string): Buffer => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return Buffer.from(padded, 'base64');
};

const decodeJson = <T>(value: string): T => JSON.parse(decodeBase64Url(value).toString('utf8')) as T;

const fetchJwks = async (url: string): Promise<JwksKey[]> => {
  const cached = jwksCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`OAuth JWKS fetch failed: ${response.status}`);
  const payload = (await response.json()) as { keys?: JwksKey[] };
  const keys = Array.isArray(payload.keys) ? payload.keys : [];
  jwksCache.set(url, { keys, expiresAt: Date.now() + JWKS_CACHE_MS });
  return keys;
};

const hasAudience = (aud: string | string[] | undefined, allowed: string[]): boolean => {
  const values = Array.isArray(aud) ? aud : aud ? [aud] : [];
  return values.some((value) => allowed.includes(value));
};

const isEmailVerified = (value: boolean | string | undefined): boolean =>
  value === true || (typeof value === 'string' && value.toLowerCase() === 'true');

export const verifyOAuthIdToken = async (
  provider: OAuthProvider,
  token: string
): Promise<VerifiedOAuthIdentity> => {
  const config = providerConfig[provider];
  const audiences = config.audiences();
  if (audiences.length === 0) {
    throw new Error(`${provider} OAuth client id is not configured`);
  }

  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid OAuth ID token');

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJson<JwtHeader>(encodedHeader);
  const payload = decodeJson<JwtPayload>(encodedPayload);

  if (header.alg !== 'RS256' || !header.kid) throw new Error('Unsupported OAuth token signature');
  if (!payload.sub) throw new Error('OAuth token missing subject');
  if (!payload.iss || !config.issuer.has(payload.iss)) throw new Error('OAuth token issuer rejected');
  if (!hasAudience(payload.aud, audiences)) throw new Error('OAuth token audience rejected');
  if (!payload.exp || payload.exp * 1000 <= Date.now()) throw new Error('OAuth token expired');

  const keys = await fetchJwks(config.jwksUrl);
  const key = keys.find((candidate) =>
    candidate.kid === header.kid &&
    candidate.kty === 'RSA' &&
    (!candidate.use || candidate.use === 'sig') &&
    (!candidate.alg || candidate.alg === 'RS256') &&
    Boolean(candidate.n) &&
    Boolean(candidate.e)
  );
  if (!key) throw new Error('OAuth signing key not found');

  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  verifier.end();
  const publicKey = createPublicKey({ key: key as JsonWebKey, format: 'jwk' });
  const ok = verifier.verify(publicKey, decodeBase64Url(encodedSignature));
  if (!ok) throw new Error('OAuth token signature rejected');

  return {
    provider,
    providerUserId: payload.sub,
    email: payload.email,
    emailVerified: isEmailVerified(payload.email_verified),
    name: payload.name
  };
};
