#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${1:-${SCRIPT_DIR}/.env.prod}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[preflight] missing ${ENV_FILE}" >&2
  exit 1
fi

env_value() {
  local file="$1"
  local key="$2"
  awk -F= -v k="${key}" '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    $1 == k { sub(/^[^=]*=/, ""); print; found=1 }
    END { if (!found) exit 1 }
  ' "${file}" 2>/dev/null | tail -1
}

trim() {
  local value="$1"
  value="${value%\"}"
  value="${value#\"}"
  printf '%s' "${value}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

failures=0

require_nonempty() {
  local file="$1"
  local key="$2"
  local value
  value="$(trim "$(env_value "${file}" "${key}" || true)")"
  if [[ -z "${value}" ]]; then
    echo "[preflight] ${file}: ${key} is required" >&2
    failures=$((failures + 1))
  fi
}

require_not_placeholder() {
  local file="$1"
  local key="$2"
  local value
  value="$(trim "$(env_value "${file}" "${key}" || true)")"
  local lower
  lower="$(printf '%s' "${value}" | tr '[:upper:]' '[:lower:]')"
  if [[ -z "${value}" || "${lower}" == *example.com* || "${lower}" == *".example"* || "${lower}" == *localhost* || "${lower}" == *127.0.0.1* || "${value}" == ghcr.io/OWNER/* || "${lower}" == "changeme" || "${lower}" == "change_me" || "${lower}" == *placeholder* ]]; then
    echo "[preflight] ${file}: ${key} is empty or still a placeholder" >&2
    failures=$((failures + 1))
  fi
}

validate_openai_api_key() {
  local file="$1"
  local key="$2"
  local value
  local status
  local response_file
  if [[ "${VALIDATE_OPENAI_API_KEY:-false}" != "true" ]]; then
    return
  fi
  value="$(trim "$(env_value "${file}" "${key}" || true)")"
  if [[ -z "${value}" ]]; then
    return
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "[preflight] curl is required for OpenAI API key validation" >&2
    failures=$((failures + 1))
    return
  fi
  response_file="$(mktemp)"
  status="$(curl -sS -o "${response_file}" -w '%{http_code}' --max-time 10 \
    -H "Authorization: Bearer ${value}" \
    https://api.openai.com/v1/models 2>/dev/null || true)"
  rm -f "${response_file}"
  if [[ "${status}" != "200" ]]; then
    echo "[preflight] ${file}: ${key} failed OpenAI API validation (HTTP ${status:-000})" >&2
    failures=$((failures + 1))
  fi
}

require_url_prefix() {
  local file="$1"
  local key="$2"
  local prefix="$3"
  local value
  value="$(trim "$(env_value "${file}" "${key}" || true)")"
  if [[ "${value}" != "${prefix}"* ]]; then
    echo "[preflight] ${file}: ${key} must start with ${prefix}" >&2
    failures=$((failures + 1))
  fi
}

require_https_origin_list() {
  local file="$1"
  local key="$2"
  local value
  value="$(trim "$(env_value "${file}" "${key}" || true)")"
  if [[ -z "${value}" ]]; then
    echo "[preflight] ${file}: ${key} is required" >&2
    failures=$((failures + 1))
    return
  fi
  IFS=',' read -r -a origins <<< "${value}"
  for raw_origin in "${origins[@]}"; do
    local origin
    origin="$(trim "${raw_origin}")"
    local lower
    lower="$(printf '%s' "${origin}" | tr '[:upper:]' '[:lower:]')"
    if [[ -z "${origin}" || "${origin}" == "*" || "${origin}" != https://* || "${lower}" == *example.com* || "${lower}" == *".example"* || "${lower}" == *localhost* || "${lower}" == *127.0.0.1* || "${lower}" == *placeholder* ]]; then
      echo "[preflight] ${file}: ${key} must contain only real https:// origins" >&2
      failures=$((failures + 1))
      return
    fi
  done
}

require_true() {
  local file="$1"
  local key="$2"
  local value
  value="$(trim "$(env_value "${file}" "${key}" || true)")"
  if [[ "${value}" != "true" ]]; then
    echo "[preflight] ${file}: ${key} must be true" >&2
    failures=$((failures + 1))
  fi
}

require_secret_min_length() {
  local file="$1"
  local key="$2"
  local min_length="$3"
  local value
  value="$(trim "$(env_value "${file}" "${key}" || true)")"
  local lower
  lower="$(printf '%s' "${value}" | tr '[:upper:]' '[:lower:]')"
  if [[ -z "${value}" ]]; then
    echo "[preflight] ${file}: ${key} is required" >&2
    failures=$((failures + 1))
    return
  fi
  if [[ "${#value}" -lt "${min_length}" || "${lower}" == "changeme" || "${lower}" == "change_me" || "${lower}" == "placeholder" || "${lower}" == "internal-test-token" || "${lower}" == "internal-token-test" || "${lower}" == "test-token" ]]; then
    echo "[preflight] ${file}: ${key} must be a high-entropy secret with at least ${min_length} characters" >&2
    failures=$((failures + 1))
  fi
}

require_same_value() {
  local file_a="$1"
  local key_a="$2"
  local file_b="$3"
  local key_b="$4"
  local value_a
  local value_b
  value_a="$(trim "$(env_value "${file_a}" "${key_a}" || true)")"
  value_b="$(trim "$(env_value "${file_b}" "${key_b}" || true)")"
  if [[ -n "${value_a}" && -n "${value_b}" && "${value_a}" != "${value_b}" ]]; then
    echo "[preflight] ${file_b}: ${key_b} must match ${key_a} from ${file_a}" >&2
    failures=$((failures + 1))
  fi
}

require_false_or_empty() {
  local file="$1"
  local key="$2"
  local value
  value="$(trim "$(env_value "${file}" "${key}" || true)")"
  if [[ -n "${value}" && "${value}" != "false" ]]; then
    echo "[preflight] ${file}: ${key} must be false or unset in production" >&2
    failures=$((failures + 1))
  fi
}

reject_value() {
  local file="$1"
  local key="$2"
  local rejected="$3"
  local value
  value="$(trim "$(env_value "${file}" "${key}" || true)")"
  if [[ "${value}" == "${rejected}" ]]; then
    echo "[preflight] ${file}: ${key}=${rejected} is forbidden in production" >&2
    failures=$((failures + 1))
  fi
}

require_base64_32() {
  local file="$1"
  local key="$2"
  local value
  local decoded_len
  value="$(trim "$(env_value "${file}" "${key}" || true)")"
  if [[ -z "${value}" ]]; then
    echo "[preflight] ${file}: ${key} is required" >&2
    failures=$((failures + 1))
    return
  fi
  if ! decoded_len="$(printf '%s' "${value}" | openssl base64 -d -A 2>/dev/null | wc -c | tr -d '[:space:]')" || [[ "${decoded_len}" != "32" ]]; then
    echo "[preflight] ${file}: ${key} must decode to 32 bytes" >&2
    failures=$((failures + 1))
  fi
}

require_postgres_sslmode() {
  local file="$1"
  local key="$2"
  local value
  value="$(trim "$(env_value "${file}" "${key}" || true)")"
  if [[ -z "${value}" ]]; then
    echo "[preflight] ${file}: ${key} is required" >&2
    failures=$((failures + 1))
    return
  fi
  if [[ "${value}" != *"sslmode=verify-full"* ]]; then
    echo "[preflight] ${file}: ${key} must include sslmode=verify-full" >&2
    failures=$((failures + 1))
  fi
}

require_not_placeholder "${ENV_FILE}" API_IMAGE
require_not_placeholder "${ENV_FILE}" PIPECAT_GATEWAY_IMAGE
require_not_placeholder "${ENV_FILE}" REMINDER_IMAGE
require_true "${ENV_FILE}" ENABLE_HTTPS
require_not_placeholder "${ENV_FILE}" PUBLIC_HOSTNAME
require_not_placeholder "${ENV_FILE}" API_PUBLIC_BASE_URL
require_not_placeholder "${ENV_FILE}" PIPECAT_GATEWAY_PUBLIC_WS_URL
require_not_placeholder "${ENV_FILE}" PIPECAT_GATEWAY_PUBLIC_HTTP_URL
require_https_origin_list "${ENV_FILE}" CORS_ORIGINS
require_url_prefix "${ENV_FILE}" API_PUBLIC_BASE_URL "https://"
require_url_prefix "${ENV_FILE}" PIPECAT_GATEWAY_PUBLIC_WS_URL "wss://"
require_url_prefix "${ENV_FILE}" PIPECAT_GATEWAY_PUBLIC_HTTP_URL "https://"
require_postgres_sslmode "${ENV_FILE}" POSTGRES_URL
require_nonempty "${ENV_FILE}" REDIS_URL
require_secret_min_length "${ENV_FILE}" INTERNAL_SERVICE_TOKEN 32
require_secret_min_length "${ENV_FILE}" SHORT_CODE_PEPPER 32
require_not_placeholder "${ENV_FILE}" OPENAI_API_KEY
validate_openai_api_key "${ENV_FILE}" OPENAI_API_KEY
require_nonempty "${ENV_FILE}" MEM0_API_KEY
require_nonempty "${ENV_FILE}" QDRANT_URL
require_nonempty "${ENV_FILE}" QDRANT_API_KEY
require_base64_32 "${ENV_FILE}" VOICE_NOTES_ENCRYPTION_KEY_B64
require_true "${ENV_FILE}" SECURITY_KEYS_ROTATED_ACK
require_true "${ENV_FILE}" PROD_SECRETS_OUT_OF_REPO_ACK
require_true "${ENV_FILE}" VOICE_NOTES_LOCAL_STORAGE_ACK_RISK
require_true "${ENV_FILE}" POSTGRES_STORAGE_ENCRYPTION_ACK
require_true "${ENV_FILE}" POSTGRES_BACKUPS_ENCRYPTION_ACK

if [[ "$(trim "$(env_value "${ENV_FILE}" AUTH_DEV_OTP_BYPASS || true)")" != "false" ]]; then
  echo "[preflight] ${ENV_FILE}: AUTH_DEV_OTP_BYPASS must be false" >&2
  failures=$((failures + 1))
fi

otp_mode="$(trim "$(env_value "${ENV_FILE}" AUTH_OTP_DELIVERY_MODE || true)")"
if [[ "${otp_mode}" == "dev_log" ]]; then
  echo "[preflight] ${ENV_FILE}: AUTH_OTP_DELIVERY_MODE=dev_log is forbidden in production" >&2
  failures=$((failures + 1))
elif [[ "${otp_mode}" == "twilio" ]]; then
  require_nonempty "${ENV_FILE}" TWILIO_ACCOUNT_SID
  require_nonempty "${ENV_FILE}" TWILIO_AUTH_TOKEN
  require_nonempty "${ENV_FILE}" TWILIO_FROM_PHONE
fi

for service_env in \
  "${SCRIPT_DIR}/.env.prod.pipecat-gateway" \
  "${SCRIPT_DIR}/.env.prod.reminder-worker" \
  "${SCRIPT_DIR}/.env.prod.insights-worker" \
  "${SCRIPT_DIR}/.env.prod.digest-worker"
do
  if [[ ! -f "${service_env}" ]]; then
    echo "[preflight] missing ${service_env}" >&2
    failures=$((failures + 1))
  fi
done

if [[ -f "${SCRIPT_DIR}/.env.prod.pipecat-gateway" ]]; then
  gateway_env="${SCRIPT_DIR}/.env.prod.pipecat-gateway"
  require_not_placeholder "${gateway_env}" MITR_GATEWAY_PUBLIC_WS_URL
  require_url_prefix "${gateway_env}" MITR_GATEWAY_PUBLIC_WS_URL "wss://"
  require_https_origin_list "${gateway_env}" MITR_GATEWAY_CORS_ORIGINS
  reject_value "${gateway_env}" MITR_GATEWAY_AUTH_MODE "local"
  require_false_or_empty "${gateway_env}" MITR_GATEWAY_LOG_TRANSCRIPTS
  require_secret_min_length "${gateway_env}" MITR_BACKEND_INTERNAL_TOKEN 32
  require_same_value "${ENV_FILE}" INTERNAL_SERVICE_TOKEN "${gateway_env}" MITR_BACKEND_INTERNAL_TOKEN
  require_not_placeholder "${gateway_env}" OPENAI_API_KEY
  require_same_value "${ENV_FILE}" OPENAI_API_KEY "${gateway_env}" OPENAI_API_KEY
fi

for worker_env in \
  "${SCRIPT_DIR}/.env.prod.reminder-worker" \
  "${SCRIPT_DIR}/.env.prod.insights-worker" \
  "${SCRIPT_DIR}/.env.prod.digest-worker"
do
  if [[ -f "${worker_env}" ]]; then
    require_postgres_sslmode "${worker_env}" POSTGRES_URL
  fi
done

if [[ "${failures}" -gt 0 ]]; then
  echo "[preflight] production env preflight failed with ${failures} issue(s)" >&2
  exit 1
fi

echo "[preflight] production env preflight passed"
