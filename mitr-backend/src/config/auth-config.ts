import { env } from './env.js';

export const authConfig = Object.freeze({
  get sessionTtlSec() {
    return env.AUTH_SESSION_TTL_SEC;
  },
  get refreshTtlSec() {
    return env.AUTH_REFRESH_TTL_SEC;
  },
  get otpTtlSec() {
    return env.AUTH_OTP_TTL_SEC;
  },
  get revokedSessionRetentionSec() {
    return env.AUTH_REVOKED_SESSION_RETENTION_SEC;
  },
  get consumedOtpRetentionSec() {
    return env.AUTH_OTP_CONSUMED_RETENTION_SEC;
  },
  get devOtpBypassEnabled() {
    return env.AUTH_DEV_OTP_BYPASS;
  },
  get devOtpCode() {
    return env.AUTH_DEV_OTP_CODE;
  }
});
