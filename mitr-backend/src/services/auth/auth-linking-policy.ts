export type AuthIdentityProvider = 'phone' | 'email' | 'apple' | 'google';

export const toTrustedEmailKey = (input: {
  provider: AuthIdentityProvider;
  email?: string;
  emailVerified?: boolean;
}): string | undefined => {
  if (!input.email || (input.provider !== 'email' && input.emailVerified !== true)) return undefined;
  return input.email.trim().toLowerCase();
};

export const canUseEmailIdentityForPrimaryLogin = (provider: AuthIdentityProvider): boolean =>
  provider === 'email';

export const shouldCreateEmailIdentity = (provider: AuthIdentityProvider): boolean =>
  provider === 'email';
