#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="${ROOT_DIR}/mitr-backend"
DEPLOY_DIR="${BACKEND_DIR}/deploy"

log() {
  printf '\n[security-checks] %s\n' "$1"
}

set_kv() {
  local file="$1"
  local key="$2"
  local value="$3"
  awk -v k="${key}" -v v="${value}" -F= '
    BEGIN { done=0 }
    $1 == k { print k "=" v; done=1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "${file}" > "${file}.tmp" && mv "${file}.tmp" "${file}"
}

cleanup_env_files() {
  rm -f \
    "${ROOT_DIR}"/.repo-secret-scan-test.* \
    "${ROOT_DIR}"/.env.repo-secret-scan-test.* \
    "${ROOT_DIR}"/repo-secret-scan-test.*.env \
    "${ROOT_DIR}"/.context/local-secret-scan-test.* \
    "${DEPLOY_DIR}/.env.prod" \
    "${DEPLOY_DIR}/.env.prod.pipecat-gateway" \
    "${DEPLOY_DIR}/.env.prod.reminder-worker" \
    "${DEPLOY_DIR}/.env.prod.insights-worker" \
    "${DEPLOY_DIR}/.env.prod.digest-worker"
}

trap cleanup_env_files EXIT

cd "${ROOT_DIR}"

log "repository secret scan"
scripts/check-repo-secrets.sh
repo_secret_scan_tmp=".repo-secret-scan-test.$$"
fake_openai_key="sk-proj-$(node -e "console.log('A'.repeat(48))")"
printf 'OPENAI_API_KEY=%s\n' "${fake_openai_key}" > "${repo_secret_scan_tmp}"
if scripts/check-repo-secrets.sh >/tmp/mitr-repo-secret-scan.out 2>&1; then
  cat /tmp/mitr-repo-secret-scan.out
  echo "[security-checks] expected repository secret scan to reject fake key" >&2
  exit 1
fi
if grep -Fq "${fake_openai_key}" /tmp/mitr-repo-secret-scan.out; then
  echo "[security-checks] repository secret scan leaked the secret value in its output" >&2
  exit 1
fi
grep -F "${repo_secret_scan_tmp}" /tmp/mitr-repo-secret-scan.out >/dev/null
rm -f "${repo_secret_scan_tmp}"

repo_sensitive_env_tmp="repo-secret-scan-test.$$.env"
fake_exa_key="exa_$(node -e "console.log('B'.repeat(40))")"
printf 'EXA_API_KEY=%s\n' "${fake_exa_key}" > "${repo_sensitive_env_tmp}"
if scripts/check-repo-secrets.sh >/tmp/mitr-repo-sensitive-env-scan.out 2>&1; then
  cat /tmp/mitr-repo-sensitive-env-scan.out
  echo "[security-checks] expected repository secret scan to reject generic sensitive env values" >&2
  exit 1
fi
if grep -Fq "${fake_exa_key}" /tmp/mitr-repo-sensitive-env-scan.out; then
  echo "[security-checks] repository sensitive-env scan leaked the secret value in its output" >&2
  exit 1
fi
grep -F "${repo_sensitive_env_tmp}" /tmp/mitr-repo-sensitive-env-scan.out >/dev/null
rm -f "${repo_sensitive_env_tmp}"

log "local workspace secret scan"
scripts/check-local-workspace-secrets.sh
local_sensitive_tmp=".context/local-secret-scan-test.$$"
fake_mem0_key="mem0_$(node -e "console.log('C'.repeat(40))")"
printf 'MEM0_API_KEY=%s\n' "${fake_mem0_key}" > "${local_sensitive_tmp}"
if scripts/check-local-workspace-secrets.sh >/tmp/mitr-local-sensitive-env-scan.out 2>&1; then
  cat /tmp/mitr-local-sensitive-env-scan.out
  echo "[security-checks] expected local workspace secret scan to reject generic sensitive values in ignored files" >&2
  exit 1
fi
if grep -Fq "${fake_mem0_key}" /tmp/mitr-local-sensitive-env-scan.out; then
  echo "[security-checks] local sensitive-env scan leaked the secret value in its output" >&2
  exit 1
fi
grep -F "${local_sensitive_tmp}" /tmp/mitr-local-sensitive-env-scan.out >/dev/null
rm -f "${local_sensitive_tmp}"

log "route auth coverage"
node scripts/check-route-auth-coverage.mjs

log "RBAC invariants"
node scripts/check-rbac-invariants.mjs

log "non-cryptographic random guard"
random_matches="$(
  grep -RIn 'Math\.random' mitr-backend/src minimal/main scripts 2>/dev/null \
    | grep -v 'mitr-backend/src/services/companion/satsang-ledger.ts' \
    | grep -v 'scripts/security-hardening-checks.sh' \
    || true
)"
if [[ -n "${random_matches}" ]]; then
  echo "[security-checks] unexpected Math.random usage outside allowlisted non-security content randomization:" >&2
  echo "${random_matches}" >&2
  exit 1
fi

log "raw backend console logging guard"
console_matches="$(
  grep -RInE 'console\.(log|error|warn|debug|info)' mitr-backend/src 2>/dev/null || true
)"
if [[ -n "${console_matches}" ]]; then
  echo "[security-checks] backend source must use the shared logger so sensitive fields stay redacted:" >&2
  echo "${console_matches}" >&2
  exit 1
fi

log "abuse smoke script syntax"
bash -n scripts/security-abuse-smoke.sh
node --check scripts/security-abuse-seed-and-smoke.mjs
if REQUIRE_INTERNAL_SERVICE_CHECK=true bash scripts/security-abuse-smoke.sh >/tmp/mitr-abuse-strict-mode.out 2>&1; then
  cat /tmp/mitr-abuse-strict-mode.out
  echo "[security-checks] expected abuse smoke strict internal-service mode to fail without seeded context" >&2
  exit 1
fi
grep -F 'REQUIRE_INTERNAL_SERVICE_CHECK=true requires INTERNAL_SERVICE_TOKEN' /tmp/mitr-abuse-strict-mode.out >/dev/null

log "git diff whitespace check"
git diff --check

log "backend TypeScript typecheck"
cd "${BACKEND_DIR}"
node ./node_modules/typescript/bin/tsc --noEmit

log "backend unit tests"
npm run test:unit

log "Pipecat gateway Python compile"
cd "${BACKEND_DIR}/pipecat-gateway"
uv run python -m compileall mitr_pipecat_gateway
rm -rf mitr_pipecat_gateway/__pycache__

log "Pipecat gateway production env guard"
if NODE_ENV=production \
  MITR_GATEWAY_AUTH_MODE=local \
  MITR_GATEWAY_PUBLIC_WS_URL=wss://api.mitr.app/ws \
  MITR_GATEWAY_CORS_ORIGINS=https://app.mitr.app \
  MITR_BACKEND_INTERNAL_TOKEN="$(node -e "console.log('a'.repeat(64))")" \
  OPENAI_API_KEY=test-openai-key-12345678901234567890 \
  uv run python -c 'import mitr_pipecat_gateway.server' >/tmp/mitr-gateway-prod-guard.out 2>&1; then
  cat /tmp/mitr-gateway-prod-guard.out
  echo "[security-checks] expected Pipecat gateway prod guard to reject local auth mode" >&2
  exit 1
fi
head -n 5 /tmp/mitr-gateway-prod-guard.out
NODE_ENV=production \
  MITR_GATEWAY_PUBLIC_WS_URL=wss://api.mitr.app/ws \
  MITR_GATEWAY_CORS_ORIGINS=https://app.mitr.app \
  MITR_BACKEND_INTERNAL_TOKEN="$(node -e "console.log('a'.repeat(64))")" \
  OPENAI_API_KEY=test-openai-key-12345678901234567890 \
  uv run python -c 'import mitr_pipecat_gateway.server'

log "service env scope guard"
cd "${BACKEND_DIR}"
cleanup_env_files
cp deploy/.env.prod.pipecat-gateway.template deploy/.env.prod.pipecat-gateway
cp deploy/.env.prod.reminder-worker.template deploy/.env.prod.reminder-worker
cp deploy/.env.prod.insights-worker.template deploy/.env.prod.insights-worker
cp deploy/.env.prod.digest-worker.template deploy/.env.prod.digest-worker
deploy/check-service-env-scope.sh
cleanup_env_files

log "production preflight rejects placeholder templates"
cp deploy/.env.prod.template deploy/.env.prod
cp deploy/.env.prod.pipecat-gateway.template deploy/.env.prod.pipecat-gateway
cp deploy/.env.prod.reminder-worker.template deploy/.env.prod.reminder-worker
cp deploy/.env.prod.insights-worker.template deploy/.env.prod.insights-worker
cp deploy/.env.prod.digest-worker.template deploy/.env.prod.digest-worker
if deploy/preflight-prod-env.sh deploy/.env.prod >/tmp/mitr-preflight-template.out 2>&1; then
  cat /tmp/mitr-preflight-template.out
  echo "[security-checks] expected preflight to fail for placeholder templates" >&2
  exit 1
fi
head -n 20 /tmp/mitr-preflight-template.out
cleanup_env_files

log "production preflight accepts synthetic configured env"
voice_key="$(node -e "console.log(Buffer.alloc(32, 4).toString('base64'))")"
internal_token="$(node -e "console.log('a'.repeat(64))")"
openai_key='test-openai-key-12345678901234567890'
postgres_url='postgresql://mitr:secret@db.example.com:5432/mitr?sslmode=verify-full'
cp deploy/.env.prod.template deploy/.env.prod
cp deploy/.env.prod.pipecat-gateway.template deploy/.env.prod.pipecat-gateway
cp deploy/.env.prod.reminder-worker.template deploy/.env.prod.reminder-worker
cp deploy/.env.prod.insights-worker.template deploy/.env.prod.insights-worker
cp deploy/.env.prod.digest-worker.template deploy/.env.prod.digest-worker
set_kv deploy/.env.prod API_IMAGE ghcr.io/acme/mitr-api:sha-test
set_kv deploy/.env.prod PIPECAT_GATEWAY_IMAGE ghcr.io/acme/mitr-pipecat-gateway:sha-test
set_kv deploy/.env.prod REMINDER_IMAGE ghcr.io/acme/mitr-api:sha-test
set_kv deploy/.env.prod ENABLE_HTTPS true
set_kv deploy/.env.prod PUBLIC_HOSTNAME api.mitr.app
set_kv deploy/.env.prod CORS_ORIGINS https://app.mitr.app
set_kv deploy/.env.prod API_PUBLIC_BASE_URL https://api.mitr.app
set_kv deploy/.env.prod PIPECAT_GATEWAY_PUBLIC_WS_URL wss://api.mitr.app/ws
set_kv deploy/.env.prod PIPECAT_GATEWAY_PUBLIC_HTTP_URL https://api.mitr.app
set_kv deploy/.env.prod POSTGRES_URL "${postgres_url}"
set_kv deploy/.env.prod INTERNAL_SERVICE_TOKEN "${internal_token}"
set_kv deploy/.env.prod SHORT_CODE_PEPPER "$(node -e "console.log('c'.repeat(64))")"
set_kv deploy/.env.prod OPENAI_API_KEY "${openai_key}"
set_kv deploy/.env.prod MEM0_API_KEY mem0-test-key
set_kv deploy/.env.prod QDRANT_URL https://qdrant.example
set_kv deploy/.env.prod QDRANT_API_KEY qdrant-test-key
set_kv deploy/.env.prod VOICE_NOTES_ENCRYPTION_KEY_B64 "${voice_key}"
set_kv deploy/.env.prod VOICE_NOTES_LOCAL_STORAGE_ACK_RISK true
set_kv deploy/.env.prod SECURITY_KEYS_ROTATED_ACK true
set_kv deploy/.env.prod PROD_SECRETS_OUT_OF_REPO_ACK true
set_kv deploy/.env.prod POSTGRES_STORAGE_ENCRYPTION_ACK true
set_kv deploy/.env.prod POSTGRES_BACKUPS_ENCRYPTION_ACK true
set_kv deploy/.env.prod.pipecat-gateway MITR_GATEWAY_PUBLIC_WS_URL wss://api.mitr.app/ws
set_kv deploy/.env.prod.pipecat-gateway MITR_GATEWAY_CORS_ORIGINS https://app.mitr.app
set_kv deploy/.env.prod.pipecat-gateway MITR_GATEWAY_LOG_TRANSCRIPTS false
set_kv deploy/.env.prod.pipecat-gateway MITR_BACKEND_INTERNAL_TOKEN "${internal_token}"
set_kv deploy/.env.prod.pipecat-gateway OPENAI_API_KEY "${openai_key}"
for worker_env in \
  deploy/.env.prod.reminder-worker \
  deploy/.env.prod.insights-worker \
  deploy/.env.prod.digest-worker
do
  set_kv "${worker_env}" POSTGRES_URL "${postgres_url}"
done
deploy/preflight-prod-env.sh deploy/.env.prod

set_kv deploy/.env.prod.pipecat-gateway MITR_BACKEND_INTERNAL_TOKEN "$(node -e "console.log('b'.repeat(64))")"
if deploy/preflight-prod-env.sh deploy/.env.prod >/tmp/mitr-preflight-mismatch.out 2>&1; then
  cat /tmp/mitr-preflight-mismatch.out
  echo "[security-checks] expected preflight to reject mismatched internal service tokens" >&2
  exit 1
fi
head -n 5 /tmp/mitr-preflight-mismatch.out

set_kv deploy/.env.prod.pipecat-gateway MITR_BACKEND_INTERNAL_TOKEN "${internal_token}"
set_kv deploy/.env.prod.pipecat-gateway OPENAI_API_KEY test-stale-service-openai-key-1234567890
if deploy/preflight-prod-env.sh deploy/.env.prod >/tmp/mitr-preflight-openai-mismatch.out 2>&1; then
  cat /tmp/mitr-preflight-openai-mismatch.out
  echo "[security-checks] expected preflight to reject mismatched OpenAI API keys" >&2
  exit 1
fi
head -n 5 /tmp/mitr-preflight-openai-mismatch.out

set_kv deploy/.env.prod.pipecat-gateway OPENAI_API_KEY "${openai_key}"
set_kv deploy/.env.prod INTERNAL_SERVICE_TOKEN short
set_kv deploy/.env.prod.pipecat-gateway MITR_BACKEND_INTERNAL_TOKEN short
if deploy/preflight-prod-env.sh deploy/.env.prod >/tmp/mitr-preflight-weak-token.out 2>&1; then
  cat /tmp/mitr-preflight-weak-token.out
  echo "[security-checks] expected preflight to reject weak internal service tokens" >&2
  exit 1
fi
head -n 5 /tmp/mitr-preflight-weak-token.out

set_kv deploy/.env.prod INTERNAL_SERVICE_TOKEN "${internal_token}"
set_kv deploy/.env.prod.pipecat-gateway MITR_BACKEND_INTERNAL_TOKEN "${internal_token}"
set_kv deploy/.env.prod.pipecat-gateway MITR_GATEWAY_AUTH_MODE local
if deploy/preflight-prod-env.sh deploy/.env.prod >/tmp/mitr-preflight-gateway-local-auth.out 2>&1; then
  cat /tmp/mitr-preflight-gateway-local-auth.out
  echo "[security-checks] expected preflight to reject gateway local auth mode" >&2
  exit 1
fi
head -n 5 /tmp/mitr-preflight-gateway-local-auth.out

set_kv deploy/.env.prod.pipecat-gateway MITR_GATEWAY_AUTH_MODE ""
set_kv deploy/.env.prod.pipecat-gateway MITR_GATEWAY_LOG_TRANSCRIPTS true
if deploy/preflight-prod-env.sh deploy/.env.prod >/tmp/mitr-preflight-gateway-transcripts.out 2>&1; then
  cat /tmp/mitr-preflight-gateway-transcripts.out
  echo "[security-checks] expected preflight to reject gateway transcript logging" >&2
  exit 1
fi
head -n 5 /tmp/mitr-preflight-gateway-transcripts.out

set_kv deploy/.env.prod.pipecat-gateway MITR_GATEWAY_LOG_TRANSCRIPTS false
set_kv deploy/.env.prod.pipecat-gateway MITR_GATEWAY_CORS_ORIGINS "http://localhost:8787"
if deploy/preflight-prod-env.sh deploy/.env.prod >/tmp/mitr-preflight-gateway-cors.out 2>&1; then
  cat /tmp/mitr-preflight-gateway-cors.out
  echo "[security-checks] expected preflight to reject gateway dev CORS origins" >&2
  exit 1
fi
head -n 5 /tmp/mitr-preflight-gateway-cors.out

set_kv deploy/.env.prod.pipecat-gateway MITR_GATEWAY_CORS_ORIGINS https://app.mitr.app
set_kv deploy/.env.prod PIPECAT_GATEWAY_PUBLIC_HTTP_URL http://api.mitr.app
if deploy/preflight-prod-env.sh deploy/.env.prod >/tmp/mitr-preflight-gateway-http.out 2>&1; then
  cat /tmp/mitr-preflight-gateway-http.out
  echo "[security-checks] expected preflight to reject non-HTTPS Pipecat gateway HTTP URL" >&2
  exit 1
fi
head -n 5 /tmp/mitr-preflight-gateway-http.out

set_kv deploy/.env.prod PIPECAT_GATEWAY_PUBLIC_HTTP_URL https://api.mitr.app
set_kv deploy/.env.prod CORS_ORIGINS "https://app.mitr.app,http://localhost:8787"
if deploy/preflight-prod-env.sh deploy/.env.prod >/tmp/mitr-preflight-api-cors.out 2>&1; then
  cat /tmp/mitr-preflight-api-cors.out
  echo "[security-checks] expected preflight to reject non-HTTPS API CORS origins" >&2
  exit 1
fi
head -n 5 /tmp/mitr-preflight-api-cors.out

set_kv deploy/.env.prod CORS_ORIGINS https://app.mitr.app
set_kv deploy/.env.prod.pipecat-gateway MITR_GATEWAY_CORS_ORIGINS "https://app.mitr.app,http://localhost:8787"
if deploy/preflight-prod-env.sh deploy/.env.prod >/tmp/mitr-preflight-gateway-mixed-cors.out 2>&1; then
  cat /tmp/mitr-preflight-gateway-mixed-cors.out
  echo "[security-checks] expected preflight to reject non-HTTPS gateway CORS origins" >&2
  exit 1
fi
head -n 5 /tmp/mitr-preflight-gateway-mixed-cors.out
cleanup_env_files

log "nginx HTTPS deploy guard rejects missing certs"
cp deploy/.env.prod.template deploy/.env.prod
set_kv deploy/.env.prod ENABLE_HTTPS true
set_kv deploy/.env.prod PUBLIC_HOSTNAME "missing-cert-$$.mitr.local"
if bash deploy/configure-nginx.sh >/tmp/mitr-nginx-configure.out 2>&1; then
  cat /tmp/mitr-nginx-configure.out
  echo "[security-checks] expected nginx configure to fail when HTTPS certs are missing" >&2
  exit 1
fi
head -n 5 /tmp/mitr-nginx-configure.out
cleanup_env_files

log "nginx access log query redaction guard"
for nginx_config in deploy/nginx.conf deploy/nginx.http.conf deploy/nginx.https.conf.template; do
  grep -F 'log_format mitr_safe' "${nginx_config}" >/dev/null
  grep -F 'access_log /var/log/nginx/access.log mitr_safe;' "${nginx_config}" >/dev/null
  if grep -E 'log_format[[:space:]]+mitr_safe.*request_uri' "${nginx_config}" >/dev/null; then
    echo "[security-checks] ${nginx_config} safe log format must not include request_uri" >&2
    exit 1
  fi
done

log "firmware production config guard"
cd "${ROOT_DIR}"
sdkconfig_tmp=".context/prod-sdkconfig-test.$$"
printf '%s\n' \
  'CONFIG_MITR_DEVICE_BACKEND_BASE_URL="https://api.example.com"' \
  'CONFIG_MITR_GATEWAY_WS_URL="wss://api.example.com/ws"' \
  'CONFIG_MITR_DEVICE_ACCESS_TOKEN=""' \
  'CONFIG_MITR_DEVICE_PAIRING_TOKEN=""' \
  'CONFIG_MITR_WIFI_PASSWORD=""' > "${sdkconfig_tmp}"
minimal/check-production-config.sh "${sdkconfig_tmp}"
rm -f "${sdkconfig_tmp}"

log "all security hardening checks passed"
