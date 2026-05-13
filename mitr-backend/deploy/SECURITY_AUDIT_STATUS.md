# Security Audit Status

This maps the pre-launch audit findings to the current mitigation and proof.

For exact verification commands and what each one proves, see
`deploy/SECURITY_TESTING_GUIDE.md`.

Run the main verifier from repo root:

```sh
./scripts/security-hardening-checks.sh
```

Run live RBAC abuse checks against a running API:

```sh
API_BASE=http://localhost:8081 ./scripts/security-abuse-seed-and-smoke.mjs
```

Run the stricter variant with internal Pipecat family-context verification:

```sh
API_BASE=http://localhost:8081 \
INTERNAL_SERVICE_TOKEN='<same value as backend env>' \
REQUIRE_INTERNAL_SERVICE_CHECK=true \
./scripts/security-abuse-seed-and-smoke.mjs
```

## P0 Launch Blockers

| Finding | Status | Evidence |
| --- | --- | --- |
| OAuth token not verified | Fixed | `src/routes/auth.ts` requires `token`; `src/services/auth/oauth-verifier.ts` verifies issuer, audience, expiry, JWKS key, and RS256 signature. |
| Dev OTP bypass default true | Fixed | `AUTH_DEV_OTP_BYPASS` defaults false; prod env validation rejects true; `src/config/env.test.ts` covers unsafe prod settings. |
| No SMS provider | Guarded | `AUTH_OTP_DELIVERY_MODE=disabled` is allowed when phone login is not launched; `twilio` mode requires all Twilio vars; `dev_log` is rejected in prod. |
| OTP/refresh replay under concurrent requests | Fixed | OTP verification and refresh-token rotation use conditional update/returning calls so already-consumed challenges or revoked refresh sessions cannot mint another session. |
| Cross-family alert ack/resolve | Fixed | `updateAlertStatus()` scopes by caller elder ID; `scripts/check-rbac-invariants.mjs` enforces it. |
| Cross-family family member role/delete | Fixed | `setMemberRole()` and `removeMember()` scope by caller family ID; invariant guard enforces it. |
| `isOwner` auto-creates family | Fixed | `isOwner()` reads accepted membership only; family creation is not part of owner check. |
| No rate limiting | Fixed | Global limiter plus auth/device/family/upload route limiters; nginx config includes rate limits. |
| `Math.random` OTP/claim codes | Fixed | Auth/device codes use `crypto.randomInt`. |
| Short-code hash brute force/replay | Fixed | OTP and 6-digit device claim codes are stored with HMAC-SHA256 using `SHORT_CODE_PEPPER`; production runtime/preflight require a high-entropy pepper; claim-code completion conditionally consumes the claim before device token issuance. |
| HTTP-only prod path | Guarded | Prod preflight and runtime env validation require real HTTPS/WSS public URLs and HTTPS gateway CORS origins; nginx refuses HTTPS mode without certs; firmware prod guard requires HTTPS/WSS URLs. |
| Exposed production keys | Ops blocker | Repo and local workspace secret scans check tracked, untracked, ignored `.env`, and `.context` files without printing secrets. Prod preflight requires `SECURITY_KEYS_ROTATED_ACK=true` and `PROD_SECRETS_OUT_OF_REPO_ACK=true`; actual rotation must be done outside code. |

## P1 Launch Hardening

| Finding | Status | Evidence |
| --- | --- | --- |
| Voice notes public by filename | Fixed | File route requires auth; voice-note service verifies ownership; responses are `private, no-store`; encryption tests cover storage crypto. |
| Internal endpoints token config | Fixed | `INTERNAL_SERVICE_TOKEN` is required and must be high-entropy in prod at runtime and preflight; Pipecat gateway token must match it; Pipecat tool bridge requires internal token and validates user/family/elder/device context. |
| Weak password/no lockout | Fixed | Password policy rejects short/common/low-variety/user-identifying passwords; auth lockout test covers failed attempts. |
| Loose CORS | Fixed | Prod requires explicit HTTPS origins for the API and gateway; missing-Origin behavior is controlled by `CORS_ALLOW_MISSING_ORIGIN=false` and rejected if true in prod. |
| Security headers | Fixed | API sets security headers; nginx HTTPS template includes HSTS-related hardening. |
| Logger redaction | Fixed | Logger redacts sensitive fields and caps deep values. |
| Health internals | Fixed | `/health/latency` requires auth; `/healthz` hides dependency detail in production. |
| Query-token leakage in proxy logs | Guarded | Nginx access logs use the `mitr_safe` format with `$uri`, not `$request_uri`, so upload/query tokens are not logged. |
| Firmware insecure defaults | Guarded | `minimal/check-production-config.sh` and CI guard reject prod builds with HTTP/WS URLs or baked device tokens/passwords. |
| Email/OAuth account merge | Fixed | OAuth providers load by provider subject only and do not create email-provider identities. |
| Invite phantom members | Fixed | Invites bind by verified email/phone on acceptance; pending invites do not grant family access. |

## P2 / Operational Hardening

| Finding | Status | Evidence |
| --- | --- | --- |
| No CSRF | Accepted for bearer-token API | No cookie auth is used. Revisit before adding cookie sessions. |
| Voice-note local disk | Ops risk acknowledged | Prod runtime and preflight require `VOICE_NOTES_LOCAL_STORAGE_ACK_RISK=true`, 32-byte encryption key, and storage/backup acknowledgements. |
| No audit log | Partially fixed | Family role/member changes, invites, device revoke, alerts, and voice/security-sensitive actions record audit events. |
| Shared DB client | Accepted for current scale | No code change; tenant scoping enforced in service queries and invariant guard. |
| Unencrypted PII at DB layer | Ops blocker | Prod runtime and preflight require Postgres storage and backup encryption acknowledgements. |
| Workers share full secrets | Fixed/guarded | Service-specific env files and `deploy/check-service-env-scope.sh` keep worker/gateway env narrow. |
| Gateway local auth bypass | Fixed/guarded | Prod preflight and Pipecat gateway startup reject `MITR_GATEWAY_AUTH_MODE=local`; Docker compose sets `NODE_ENV=production` for the gateway. |
| Gateway transcript logging | Fixed/guarded | Prod preflight and Pipecat gateway startup reject `MITR_GATEWAY_LOG_TRANSCRIPTS=true`. |
| Pasted GitHub PAT | Ops blocker | Rotate token outside code; covered by `SECURITY_KEYS_ROTATED_ACK`. |

## Current Non-Code Blockers

Do not call the security objective complete until these are actually done:

- Rotate exposed OpenAI, Google, GitHub, Qdrant, Mem0, Exa, Prokerala, Expo, Twilio, and internal service tokens.
- Fill real `deploy/.env.prod` on the deploy host only; scoped service env files are generated during deploy.
- Provision TLS certificates for `PUBLIC_HOSTNAME`.
- Decide phone OTP launch state: keep disabled, or set `AUTH_OTP_DELIVERY_MODE=twilio` with Twilio credentials.
- Verify production Postgres storage encryption and encrypted automated backups.
- Run `API_BASE=https://... INTERNAL_SERVICE_TOKEN=... REQUIRE_INTERNAL_SERVICE_CHECK=true ./scripts/security-abuse-seed-and-smoke.mjs` against staging/prod before pilot users.
