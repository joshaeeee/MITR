const COMMON_WEAK_PASSWORDS = new Set([
  'password',
  'password1',
  'password12',
  'password123',
  'password1234',
  '1234567890',
  '123456789012',
  'qwerty12345',
  'letmein12345',
  'welcome12345',
  'admin123456',
  'mitr123456',
  'reka123456'
]);

const normalize = (value: string): string => value.trim().toLowerCase();

const splitNameTokens = (name?: string): string[] =>
  name
    ?.toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4) ?? [];

export interface PasswordPolicyInput {
  password: string;
  email?: string;
  name?: string;
}

export const validatePasswordPolicy = (input: PasswordPolicyInput): { ok: true } | { ok: false; reason: string } => {
  const password = input.password;
  const lower = normalize(password);

  if (password !== password.trim()) {
    return { ok: false, reason: 'Password cannot start or end with whitespace' };
  }
  if (password.length < 12) {
    return { ok: false, reason: 'Password must be at least 12 characters' };
  }
  if (password.length > 128) {
    return { ok: false, reason: 'Password must be at most 128 characters' };
  }
  if (COMMON_WEAK_PASSWORDS.has(lower)) {
    return { ok: false, reason: 'Password is too common' };
  }
  if (/(.)\1{5,}/.test(password)) {
    return { ok: false, reason: 'Password has too many repeated characters' };
  }
  if (/(012345|123456|234567|345678|456789|987654|876543|765432|654321)/.test(lower)) {
    return { ok: false, reason: 'Password contains an unsafe sequence' };
  }

  const categories = [
    /[a-z]/.test(password),
    /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^a-zA-Z0-9]/.test(password)
  ].filter(Boolean).length;
  if (categories < 3) {
    return { ok: false, reason: 'Password must include at least three of lowercase, uppercase, number, or symbol' };
  }

  const emailLocal = input.email?.split('@')[0]?.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (emailLocal && emailLocal.length >= 4 && lower.replace(/[^a-z0-9]/g, '').includes(emailLocal)) {
    return { ok: false, reason: 'Password cannot contain your email name' };
  }

  for (const token of splitNameTokens(input.name)) {
    if (lower.replace(/[^a-z0-9]/g, '').includes(token.replace(/[^a-z0-9]/g, ''))) {
      return { ok: false, reason: 'Password cannot contain your name' };
    }
  }

  return { ok: true };
};

export const assertPasswordPolicy = (input: PasswordPolicyInput): void => {
  const result = validatePasswordPolicy(input);
  if (!result.ok) throw new Error(result.reason);
};
