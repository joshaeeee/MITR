import { createHmac } from 'node:crypto';

const DEV_SHORT_CODE_PEPPER = 'mitr-development-short-code-pepper';

const shortCodePepper = (): string => {
  const configured = process.env.SHORT_CODE_PEPPER?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SHORT_CODE_PEPPER is required in production');
  }
  return DEV_SHORT_CODE_PEPPER;
};

export const hashShortCode = (purpose: string, code: string): string =>
  createHmac('sha256', shortCodePepper())
    .update(purpose)
    .update('\0')
    .update(code)
    .digest('hex');
