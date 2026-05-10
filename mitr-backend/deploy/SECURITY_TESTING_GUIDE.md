# Security Testing Guide

Use this guide to verify that the security hardening is actually working before
pilot users go live.

## 1. Run The Local Security Gate

From the repo root:

```sh
./scripts/security-hardening-checks.sh
```

This is the fastest all-in-one check. It verifies:

- tracked and local ignored files do not contain obvious secrets
- every backend route is either authenticated or explicitly allowlisted
- RBAC-sensitive code paths still contain the expected owner/family/session scoping
- backend source does not use raw `console.*` logging, so sensitive fields go through redaction
- backend TypeScript compiles
- backend unit tests pass
- Pipecat gateway Python compiles
- service env files do not receive unrelated secrets
- production preflight rejects unsafe placeholder env files
- production preflight accepts a synthetic safe env
- nginx HTTPS mode refuses to proceed without cert files
- nginx access logs use a safe format that omits query strings
- firmware production config rejects insecure URLs and baked credentials

Passing this command proves the code and config guardrails are intact. It does
not prove that a live API is enforcing tenant isolation at runtime.
The secret-scan checks intentionally report only labels and filenames on failure
so leaked key material is not copied into CI logs.

## 2. Run Live Abuse Checks Against The API

Start the API:

```sh
cd /Users/shivanshjoshi/conductor/workspaces/Mitr/nairobi-v1/mitr-backend
DOTENV_CONFIG_PATH=/Users/shivanshjoshi/Mitr/mitr-backend/.env \
NODE_OPTIONS='-r dotenv/config' \
PORT=8081 \
./node_modules/.bin/tsx src/index.ts
```

Then run the seeded abuse test from the repo root:

```sh
API_BASE=http://localhost:8081 ./scripts/security-abuse-seed-and-smoke.mjs
```

This creates two throwaway users and then proves:

- a protected route rejects missing bearer tokens
- the internal Pipecat tool endpoint rejects missing internal service auth
- User B cannot mutate User A's family member roles
- User B cannot acknowledge User A's alerts
- User B cannot patch User A's care items or routines
- User B cannot read or stop User A's long sessions
- User B cannot end User A's short sessions
- User B cannot read User A's device pairing status

If you want to test the internal Pipecat family-context mismatch check too, pass
the backend internal token:

```sh
API_BASE=http://localhost:8081 \
INTERNAL_SERVICE_TOKEN='<same value as INTERNAL_SERVICE_TOKEN in backend env>' \
REQUIRE_INTERNAL_SERVICE_CHECK=true \
./scripts/security-abuse-seed-and-smoke.mjs
```

For local-only testing, if your `.env` does not define `INTERNAL_SERVICE_TOKEN`,
start the API with a temporary value and pass that same value to the smoke test.
`REQUIRE_INTERNAL_SERVICE_CHECK=true` makes the run fail if the internal
family-context check is skipped.

Run the same abuse test against staging before a pilot:

```sh
API_BASE=https://api.your-staging-domain.example ./scripts/security-abuse-seed-and-smoke.mjs
```

Do not run it against production after real users are live unless you are
comfortable creating throwaway accounts in production.

## 3. Verify Production Env Refuses Unsafe Launches

On the deploy host, after filling the production env files:

```sh
cd /opt/mitr/MITR/mitr-backend
deploy/preflight-prod-env.sh deploy/.env.prod
```

This must fail until all launch-critical settings are real:

- HTTPS and WSS URLs
- non-placeholder image tags
- remote Postgres with `sslmode=verify-full`
- high-entropy internal service token, with matching gateway bridge token
- high-entropy short-code pepper for OTP and legacy device claim code hashes
- Mem0 and Qdrant settings
- voice-note encryption key
- service-specific gateway and worker env files
- required operator acknowledgements
- gateway production auth mode is not `local`
- gateway transcript logging is disabled
- gateway CORS origins are HTTPS production origins

The operator acknowledgements are intentionally manual because code cannot prove
that cloud-side actions happened:

- `SECURITY_KEYS_ROTATED_ACK=true`
- `PROD_SECRETS_OUT_OF_REPO_ACK=true`
- `POSTGRES_STORAGE_ENCRYPTION_ACK=true`
- `POSTGRES_BACKUPS_ENCRYPTION_ACK=true`
- `VOICE_NOTES_LOCAL_STORAGE_ACK_RISK=true`

The deploy preflight checks these before deployment, and the Node API runtime
also refuses to start in `NODE_ENV=production` unless the core launch
acknowledgements, Redis URL, Qdrant API key, internal token, and voice-note
encryption settings are present. The Pipecat gateway also refuses to start in
production if local auth mode, transcript logging, placeholder public URLs, weak
backend bridge tokens, or dev CORS origins are configured.

## 4. Verify CI Blocks Regressions

The backend deploy workflow runs these security gates before deployment:

- repo secret scan
- local workspace secret scan
- route auth coverage
- RBAC invariant guard
- abuse smoke script syntax checks
- service env scope guard
- production preflight template guard
- firmware production config guard

If a future change removes auth from a protected route, weakens an RBAC scoped
query, adds a secret to the repo, or makes production env unsafe, CI should fail
before deployment.

## 5. What Still Requires Human Proof

These cannot be fully verified by local code tests:

- exposed keys have actually been rotated in provider dashboards
- production secrets live only in the deploy host or secret manager
- TLS certificates exist for the real production hostname
- production database storage is encrypted at rest
- production database backups are encrypted and restorable
- production OAuth/Twilio/provider dashboards use the intended redirect URLs and
  allowed origins

Record those checks in `deploy/SECURITY_LAUNCH_CHECKLIST.md` before enabling
pilot users.
