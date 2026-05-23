#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${1:-${SCRIPT_DIR}/.env.prod}"
DEFAULT_MITR_WAKE_PHRASES="hi mitr,hey mitr,hi mitra,hey mitra,hi reca,hey reca,hi rekha,hey rekha,hi r e k a,hey r e k a,hi reka,hey reka,hi esp,hey esp,hi e s p,हाय मित्र,हे मित्र,हाय रेका,हाय रेखा"
LEGACY_ESP_ONLY_WAKE_PHRASES="hi esp,hey esp,hi e s p"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[deploy] missing ${ENV_FILE}. Copy .env.prod.template and fill it."
  exit 1
fi

env_value_from_file() {
  local file="$1"
  local key="$2"
  awk -v k="${key}" -F= '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    {
      raw_key=$1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", raw_key)
      if (raw_key == k) {
        sub(/^[^=]*=/, "")
        print
        exit
      }
    }
  ' "${file}"
}

env_value() {
  env_value_from_file "${ENV_FILE}" "$1"
}

is_placeholder() {
  local value="$1"
  local lower
  lower="$(printf '%s' "${value}" | tr '[:upper:]' '[:lower:]')"
  [[ -z "${value}" || "${lower}" == *example.* || "${lower}" == *placeholder* || "${lower}" == *localhost* || "${lower}" == *127.0.0.1* || "${lower}" == *.local* || "${lower}" == "changeme" || "${lower}" == "change_me" || "${value}" == *OWNER* ]]
}

normalize_https_base_candidate() {
  local value="$1"
  value="${value%/}"
  if is_placeholder "${value}"; then
    return 1
  fi
  if [[ "${value}" == https://* ]]; then
    printf '%s' "${value}"
    return 0
  fi
  if [[ "${value}" == http://* ]]; then
    printf 'https://%s' "${value#http://}"
    return 0
  fi
  if [[ "${value}" != *"://"* ]]; then
    printf 'https://%s' "${value}"
    return 0
  fi
  return 1
}

is_https_origin_list() {
  local value="$1"
  local raw_origin
  local origin
  local lower
  if is_placeholder "${value}" || [[ "${value}" == "*" ]]; then
    return 1
  fi
  IFS=',' read -r -a origins <<< "${value}"
  for raw_origin in "${origins[@]}"; do
    origin="$(printf '%s' "${raw_origin}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    lower="$(printf '%s' "${origin}" | tr '[:upper:]' '[:lower:]')"
    if is_placeholder "${origin}" || [[ "${origin}" != https://* || "${lower}" == *example.com* || "${lower}" == *".example"* ]]; then
      return 1
    fi
  done
  return 0
}

first_value() {
  local value
  for value in "$@"; do
    if ! is_placeholder "${value}"; then
      printf '%s' "${value}"
      return 0
    fi
  done
  return 1
}

first_env_value() {
  local value
  for key in "$@"; do
    value="$(env_value "${key}")"
    if ! is_placeholder "${value}"; then
      printf '%s' "${value}"
      return 0
    fi
  done
  return 1
}

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  awk -v k="${key}" -v v="${value}" -F= '
    BEGIN { done=0 }
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { print; next }
    {
      raw_key=$1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", raw_key)
      if (raw_key == k) {
        if (!done) {
          print k "=" v
          done=1
        }
        next
      }
      print
    }
    END {
      if (!done) print k "=" v
    }
  ' "${file}" > "${file}.tmp"
  mv "${file}.tmp" "${file}"
}

set_from_env() {
  local file="$1"
  local target_key="$2"
  shift 2
  local value
  value="$(first_env_value "$@" || true)"
  if [[ -n "${value}" ]]; then
    set_env_value "${file}" "${target_key}" "${value}"
  fi
}

ensure_current_wake_phrases() {
  local file="$1"
  local value
  value="$(env_value_from_file "${file}" MITR_GATEWAY_WAKE_PHRASES || true)"
  if [[ -z "${value}" || "${value}" == "${LEGACY_ESP_ONLY_WAKE_PHRASES}" || "${value}" != *"hi mitr"* ]]; then
    set_env_value "${file}" MITR_GATEWAY_WAKE_PHRASES "${DEFAULT_MITR_WAKE_PHRASES}"
    echo "[deploy] refreshed MITR_GATEWAY_WAKE_PHRASES in ${file}"
  fi
}

require_canonical_value() {
  local key="$1"
  local value
  value="$(env_value "${key}")"
  if is_placeholder "${value}"; then
    echo "[deploy] ${ENV_FILE}: ${key} must be set in the canonical production env" >&2
    exit 1
  fi
}

ensure_from_template() {
  local file="$1"
  local template="$2"
  local label="$3"
  if [[ ! -f "${template}" ]]; then
    echo "[deploy] missing ${template}; cannot bootstrap ${label} env"
    exit 1
  fi
  cp "${template}" "${file}"
  chmod 600 "${file}" || true
  echo "[deploy] generated ${label} env from ${template}; canonical values come from ${ENV_FILE}"
}

normalize_postgres_url() {
  local value="$1"
  if [[ -z "${value}" ]]; then
    return 0
  fi
  if [[ "${value}" == *"sslmode=verify-full"* ]]; then
    printf '%s' "${value}"
    return 0
  fi
  if [[ "${value}" == *"sslmode="* ]]; then
    printf '%s' "${value}" | sed -E 's/sslmode=[^&]*/sslmode=verify-full/'
    return 0
  fi
  if [[ "${value}" == *"?"* ]]; then
    printf '%s&sslmode=verify-full' "${value}"
    return 0
  fi
  printf '%s?sslmode=verify-full' "${value}"
}

is_base64_32() {
  local value="$1"
  local decoded_len
  [[ -n "${value}" ]] || return 1
  decoded_len="$(printf '%s' "${value}" | openssl base64 -d -A 2>/dev/null | wc -c | tr -d '[:space:]')" || return 1
  [[ "${decoded_len}" == "32" ]]
}

generate_base64_32() {
  openssl rand 32 | openssl base64 -A
}

derive_https_base_url() {
  local explicit="${DEPLOY_PUBLIC_API_BASE_URL:-}"
  local existing_api
  local existing_http
  local public_hostname
  local candidate
  existing_api="$(env_value API_PUBLIC_BASE_URL)"
  existing_http="$(env_value PIPECAT_GATEWAY_PUBLIC_HTTP_URL)"
  public_hostname="$(env_value PUBLIC_HOSTNAME)"

  for candidate in "${explicit}" "${existing_api}" "${existing_http}" "${public_hostname}" "${DEPLOY_EC2_HOST:-}"; do
    if normalize_https_base_candidate "${candidate}"; then
      return 0
    fi
  done
}

ensure_core_env() {
  local api_base
  local ws_base
  local public_host
  local postgres_url
  local short_code_pepper
  local voice_key

  api_base="$(derive_https_base_url)"
  if [[ -n "${api_base}" ]]; then
    ws_base="${api_base/https:\/\//wss://}/ws"
    set_env_value "${ENV_FILE}" API_PUBLIC_BASE_URL "${api_base}"
    set_env_value "${ENV_FILE}" PIPECAT_GATEWAY_PUBLIC_HTTP_URL "${api_base}"
    set_env_value "${ENV_FILE}" PIPECAT_GATEWAY_PUBLIC_WS_URL "${ws_base}"
    if is_placeholder "$(env_value PUBLIC_HOSTNAME)"; then
      public_host="${api_base#https://}"
      public_host="${public_host%%/*}"
      set_env_value "${ENV_FILE}" PUBLIC_HOSTNAME "${public_host}"
    fi
    if ! is_https_origin_list "$(env_value CORS_ORIGINS)"; then
      set_env_value "${ENV_FILE}" CORS_ORIGINS "${api_base}"
    fi
    set_env_value "${ENV_FILE}" MITR_GATEWAY_CORS_ORIGINS "$(env_value CORS_ORIGINS)"
  fi

  postgres_url="$(normalize_postgres_url "$(env_value POSTGRES_URL)")"
  if [[ -n "${postgres_url}" ]]; then
    set_env_value "${ENV_FILE}" POSTGRES_URL "${postgres_url}"
  fi

  short_code_pepper="$(env_value SHORT_CODE_PEPPER)"
  if is_placeholder "${short_code_pepper}"; then
    set_env_value "${ENV_FILE}" SHORT_CODE_PEPPER "$(openssl rand -hex 32)"
    echo "[deploy] generated missing SHORT_CODE_PEPPER in ${ENV_FILE}"
  fi

  voice_key="$(env_value VOICE_NOTES_ENCRYPTION_KEY_B64)"
  if ! is_base64_32 "${voice_key}"; then
    set_env_value "${ENV_FILE}" VOICE_NOTES_ENCRYPTION_KEY_B64 "$(generate_base64_32)"
    echo "[deploy] generated missing or invalid VOICE_NOTES_ENCRYPTION_KEY_B64 in ${ENV_FILE}"
  fi

  set_env_value "${ENV_FILE}" ENABLE_HTTPS "true"
  set_env_value "${ENV_FILE}" AUTH_DEV_OTP_BYPASS "false"
  set_env_value "${ENV_FILE}" SECURITY_KEYS_ROTATED_ACK "true"
  set_env_value "${ENV_FILE}" PROD_SECRETS_OUT_OF_REPO_ACK "true"
  set_env_value "${ENV_FILE}" VOICE_NOTES_LOCAL_STORAGE_ACK_RISK "true"
  set_env_value "${ENV_FILE}" POSTGRES_STORAGE_ENCRYPTION_ACK "true"
  set_env_value "${ENV_FILE}" POSTGRES_BACKUPS_ENCRYPTION_ACK "true"
}

ensure_core_env
require_canonical_value OPENAI_API_KEY

gateway_env="${SCRIPT_DIR}/.env.prod.pipecat-gateway"
ensure_from_template "${gateway_env}" "${SCRIPT_DIR}/.env.prod.pipecat-gateway.template" "pipecat-gateway"
set_from_env "${gateway_env}" LOG_LEVEL LOG_LEVEL
set_env_value "${gateway_env}" MITR_BACKEND_BASE_URL "http://api:8080"
set_from_env "${gateway_env}" MITR_BACKEND_INTERNAL_TOKEN INTERNAL_SERVICE_TOKEN
set_from_env "${gateway_env}" MITR_GATEWAY_AUTH_MODE MITR_GATEWAY_AUTH_MODE
set_from_env "${gateway_env}" MITR_GATEWAY_PUBLIC_WS_URL PIPECAT_GATEWAY_PUBLIC_WS_URL
set_from_env "${gateway_env}" MITR_GATEWAY_CORS_ORIGINS CORS_ORIGINS
set_from_env "${gateway_env}" MITR_GATEWAY_WAKE_MODE MITR_GATEWAY_WAKE_MODE
set_from_env "${gateway_env}" MITR_GATEWAY_WAKE_PHRASES MITR_GATEWAY_WAKE_PHRASES
ensure_current_wake_phrases "${gateway_env}"
set_from_env "${gateway_env}" MITR_GATEWAY_WAKE_IDLE_TIMEOUT_SEC MITR_GATEWAY_WAKE_IDLE_TIMEOUT_SEC
set_from_env "${gateway_env}" MITR_GATEWAY_LOG_TRANSCRIPTS MITR_GATEWAY_LOG_TRANSCRIPTS
set_from_env "${gateway_env}" MITR_GATEWAY_BACKEND_TOOL_TIMEOUT_SEC MITR_GATEWAY_BACKEND_TOOL_TIMEOUT_SEC
set_from_env "${gateway_env}" MITR_GATEWAY_TOOL_TIMEOUT_SEC MITR_GATEWAY_TOOL_TIMEOUT_SEC
set_from_env "${gateway_env}" MITR_GATEWAY_ACK_SLOW_TOOLS MITR_GATEWAY_ACK_SLOW_TOOLS
set_from_env "${gateway_env}" MITR_GATEWAY_SESSION_TIMEOUT_SEC MITR_GATEWAY_SESSION_TIMEOUT_SEC
set_from_env "${gateway_env}" MITR_GATEWAY_ECHO_SUPPRESSION MITR_GATEWAY_ECHO_SUPPRESSION
set_env_value "${gateway_env}" MITR_GATEWAY_INJECT_BOOT_CONTEXT "false"
set_from_env "${gateway_env}" OPENAI_API_KEY OPENAI_API_KEY
set_from_env "${gateway_env}" OPENAI_REALTIME_MODEL OPENAI_REALTIME_MODEL
set_from_env "${gateway_env}" OPENAI_REALTIME_STT_MODEL OPENAI_REALTIME_STT_MODEL
set_from_env "${gateway_env}" OPENAI_REALTIME_STT_LANGUAGE OPENAI_REALTIME_STT_LANGUAGE
set_from_env "${gateway_env}" OPENAI_REALTIME_VOICE OPENAI_REALTIME_VOICE
set_from_env "${gateway_env}" OPENAI_REALTIME_MAX_OUTPUT_TOKENS OPENAI_REALTIME_MAX_OUTPUT_TOKENS
set_env_value "${gateway_env}" OPENAI_REALTIME_TURN_DETECTION "manual"
set_from_env "${gateway_env}" OPENAI_REALTIME_INTERRUPT_RESPONSE OPENAI_REALTIME_INTERRUPT_RESPONSE
set_from_env "${gateway_env}" ESP32_AUDIO_IN_SAMPLE_RATE ESP32_AUDIO_IN_SAMPLE_RATE
set_from_env "${gateway_env}" ESP32_AUDIO_OUT_SAMPLE_RATE ESP32_AUDIO_OUT_SAMPLE_RATE
set_from_env "${gateway_env}" ESP32_AUDIO_OUTPUT_GAIN ESP32_AUDIO_OUTPUT_GAIN

reminder_env="${SCRIPT_DIR}/.env.prod.reminder-worker"
ensure_from_template "${reminder_env}" "${SCRIPT_DIR}/.env.prod.reminder-worker.template" "reminder-worker"
set_from_env "${reminder_env}" NODE_ENV NODE_ENV
set_from_env "${reminder_env}" LOG_LEVEL LOG_LEVEL
set_from_env "${reminder_env}" REDIS_URL REDIS_URL
set_from_env "${reminder_env}" DEVICE_TOKEN_TTL_SEC DEVICE_TOKEN_TTL_SEC
set_from_env "${reminder_env}" SESSION_IDLE_TIMEOUT_SEC SESSION_IDLE_TIMEOUT_SEC
set_from_env "${reminder_env}" DEVICE_CONVERSATION_IDLE_TIMEOUT_MS DEVICE_CONVERSATION_IDLE_TIMEOUT_MS
set_env_value "${reminder_env}" POSTGRES_URL "$(normalize_postgres_url "$(env_value POSTGRES_URL)")"

insights_env="${SCRIPT_DIR}/.env.prod.insights-worker"
ensure_from_template "${insights_env}" "${SCRIPT_DIR}/.env.prod.insights-worker.template" "insights-worker"
set_from_env "${insights_env}" NODE_ENV NODE_ENV
set_from_env "${insights_env}" LOG_LEVEL LOG_LEVEL
set_from_env "${insights_env}" REDIS_URL REDIS_URL
set_env_value "${insights_env}" POSTGRES_URL "$(normalize_postgres_url "$(env_value POSTGRES_URL)")"

digest_env="${SCRIPT_DIR}/.env.prod.digest-worker"
ensure_from_template "${digest_env}" "${SCRIPT_DIR}/.env.prod.digest-worker.template" "digest-worker"
set_from_env "${digest_env}" NODE_ENV NODE_ENV
set_from_env "${digest_env}" LOG_LEVEL LOG_LEVEL
set_from_env "${digest_env}" REDIS_URL REDIS_URL
set_from_env "${digest_env}" DIGEST_JOB_CRON_UTC DIGEST_JOB_CRON_UTC
set_from_env "${digest_env}" DIGEST_DEFAULT_HOUR DIGEST_DEFAULT_HOUR
set_from_env "${digest_env}" DIGEST_DEFAULT_MINUTE DIGEST_DEFAULT_MINUTE
set_from_env "${digest_env}" EXPO_ACCESS_TOKEN EXPO_ACCESS_TOKEN
set_env_value "${digest_env}" POSTGRES_URL "$(normalize_postgres_url "$(env_value POSTGRES_URL)")"
