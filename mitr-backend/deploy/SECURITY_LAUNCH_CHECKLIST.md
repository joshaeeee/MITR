# Security Launch Checklist

Run this before enabling pilot users on a production host.

For a control-by-control verification workflow, see
`deploy/SECURITY_TESTING_GUIDE.md`.

## Required Local Checks

From the repo root:

```sh
./scripts/security-hardening-checks.sh
```

Against a running API:

```sh
API_BASE=https://api.your-domain.example \
INTERNAL_SERVICE_TOKEN='<same value as INTERNAL_SERVICE_TOKEN in deploy/.env.prod>' \
REQUIRE_INTERNAL_SERVICE_CHECK=true \
./scripts/security-abuse-seed-and-smoke.mjs
```

## Required Production Preflight

On the deploy host, after filling the production env files:

```sh
cd mitr-backend
deploy/preflight-prod-env.sh deploy/.env.prod
```

The preflight must pass before `deploy/deploy.sh` is allowed to run.

## Required Operator Acknowledgements

Set these to `true` in `deploy/.env.prod` only after the corresponding action is complete.

`SECURITY_KEYS_ROTATED_ACK=true`

Rotate every key or token that appeared in local logs, chat, screenshots, `.env` files, or developer machines:

- OpenAI project keys
- Google/Gemini API keys
- GitHub personal access tokens
- Twilio credentials, if configured
- Qdrant, Mem0, Exa, Prokerala, Expo, and embedding provider keys
- `INTERNAL_SERVICE_TOKEN`
- device access or pairing tokens, if any were baked into test firmware

`PROD_SECRETS_OUT_OF_REPO_ACK=true`

Production secrets must not live in the repo, `.context`, screenshots, or checked-in files. Prefer a secret manager. If using host env files, keep them only on the deploy host with restrictive permissions:

```sh
chmod 600 deploy/.env.prod deploy/.env.prod.*
```

`POSTGRES_STORAGE_ENCRYPTION_ACK=true`

Confirm production Postgres storage encryption at rest is enabled on the actual database volume or managed database instance.

`POSTGRES_BACKUPS_ENCRYPTION_ACK=true`

Confirm automated production database backups/snapshots are enabled, encrypted, and have an intentional retention policy.

`VOICE_NOTES_LOCAL_STORAGE_ACK_RISK=true`

Set only after voice-note storage is encrypted and backed up. Local EC2 disk is acceptable for a short pilot only if you explicitly accept the single-host failure mode.

## Required HTTPS State

`deploy/preflight-prod-env.sh` requires:

- `ENABLE_HTTPS=true`
- real `PUBLIC_HOSTNAME`
- `CORS_ORIGINS=https://...`
- `API_PUBLIC_BASE_URL=https://...`
- `PIPECAT_GATEWAY_PUBLIC_WS_URL=wss://...`
- `PIPECAT_GATEWAY_PUBLIC_HTTP_URL=https://...`
- Pipecat gateway env uses HTTPS CORS origins, does not use
  `MITR_GATEWAY_AUTH_MODE=local`, and keeps transcript logging disabled

`deploy/configure-nginx.sh` refuses HTTPS mode if certificate files are missing.

## Required Auth State

- `AUTH_DEV_OTP_BYPASS=false`
- `AUTH_OTP_DELIVERY_MODE=disabled` if phone login is not launched
- `AUTH_OTP_DELIVERY_MODE=twilio` only with all Twilio vars set
- Google/Apple OAuth client IDs configured for providers you expose
- `INTERNAL_SERVICE_TOKEN` and `MITR_BACKEND_INTERNAL_TOKEN` set to the same generated high-entropy value
- `SHORT_CODE_PEPPER` set to a generated high-entropy value
- `REDIS_URL` and `QDRANT_API_KEY` configured for production

Generate new internal/voice-note secrets with:

```sh
deploy/generate-prod-secrets.sh
```
