#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${1:-${SCRIPT_DIR}/.env.prod}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[deploy] missing ${ENV_FILE}. Copy .env.prod.template and fill it."
  exit 1
fi

env_value() {
  local key="$1"
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
  ' "${ENV_FILE}"
}

first_env_value() {
  local value
  for key in "$@"; do
    value="$(env_value "${key}")"
    if [[ -n "${value}" ]]; then
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

ensure_from_template() {
  local file="$1"
  local template="$2"
  local label="$3"
  if [[ -f "${file}" ]]; then
    return 1
  fi
  if [[ ! -f "${template}" ]]; then
    echo "[deploy] missing ${template}; cannot bootstrap ${label} env"
    exit 1
  fi
  cp "${template}" "${file}"
  chmod 600 "${file}" || true
  echo "[deploy] created missing ${file} from ${template}"
  return 0
}

gateway_env="${SCRIPT_DIR}/.env.prod.pipecat-gateway"
if ensure_from_template "${gateway_env}" "${SCRIPT_DIR}/.env.prod.pipecat-gateway.template" "pipecat-gateway"; then
  set_from_env "${gateway_env}" LOG_LEVEL LOG_LEVEL
  set_env_value "${gateway_env}" MITR_BACKEND_BASE_URL "http://api:8080"
  set_from_env "${gateway_env}" MITR_BACKEND_INTERNAL_TOKEN INTERNAL_SERVICE_TOKEN
  set_from_env "${gateway_env}" MITR_GATEWAY_AUTH_MODE MITR_GATEWAY_AUTH_MODE
  set_from_env "${gateway_env}" MITR_GATEWAY_PUBLIC_WS_URL MITR_GATEWAY_PUBLIC_WS_URL PIPECAT_GATEWAY_PUBLIC_WS_URL
  set_from_env "${gateway_env}" MITR_GATEWAY_CORS_ORIGINS MITR_GATEWAY_CORS_ORIGINS CORS_ORIGINS
  set_from_env "${gateway_env}" MITR_GATEWAY_WAKE_MODE MITR_GATEWAY_WAKE_MODE
  set_from_env "${gateway_env}" MITR_GATEWAY_WAKE_PHRASES MITR_GATEWAY_WAKE_PHRASES
  set_from_env "${gateway_env}" MITR_GATEWAY_WAKE_IDLE_TIMEOUT_SEC MITR_GATEWAY_WAKE_IDLE_TIMEOUT_SEC
  set_from_env "${gateway_env}" MITR_GATEWAY_LOG_TRANSCRIPTS MITR_GATEWAY_LOG_TRANSCRIPTS
  set_from_env "${gateway_env}" MITR_GATEWAY_BACKEND_TOOL_TIMEOUT_SEC MITR_GATEWAY_BACKEND_TOOL_TIMEOUT_SEC
  set_from_env "${gateway_env}" MITR_GATEWAY_TOOL_TIMEOUT_SEC MITR_GATEWAY_TOOL_TIMEOUT_SEC
  set_from_env "${gateway_env}" MITR_GATEWAY_ACK_SLOW_TOOLS MITR_GATEWAY_ACK_SLOW_TOOLS
  set_from_env "${gateway_env}" MITR_GATEWAY_SESSION_TIMEOUT_SEC MITR_GATEWAY_SESSION_TIMEOUT_SEC
  set_from_env "${gateway_env}" MITR_GATEWAY_ECHO_SUPPRESSION MITR_GATEWAY_ECHO_SUPPRESSION
  set_from_env "${gateway_env}" OPENAI_API_KEY OPENAI_API_KEY
  set_from_env "${gateway_env}" OPENAI_REALTIME_MODEL OPENAI_REALTIME_MODEL
  set_from_env "${gateway_env}" OPENAI_REALTIME_STT_MODEL OPENAI_REALTIME_STT_MODEL
  set_from_env "${gateway_env}" OPENAI_REALTIME_STT_LANGUAGE OPENAI_REALTIME_STT_LANGUAGE
  set_from_env "${gateway_env}" OPENAI_REALTIME_VOICE OPENAI_REALTIME_VOICE
  set_from_env "${gateway_env}" OPENAI_REALTIME_MAX_OUTPUT_TOKENS OPENAI_REALTIME_MAX_OUTPUT_TOKENS
  set_from_env "${gateway_env}" OPENAI_REALTIME_TURN_DETECTION OPENAI_REALTIME_TURN_DETECTION
  set_from_env "${gateway_env}" OPENAI_REALTIME_INTERRUPT_RESPONSE OPENAI_REALTIME_INTERRUPT_RESPONSE
  set_from_env "${gateway_env}" ESP32_AUDIO_IN_SAMPLE_RATE ESP32_AUDIO_IN_SAMPLE_RATE
  set_from_env "${gateway_env}" ESP32_AUDIO_OUT_SAMPLE_RATE ESP32_AUDIO_OUT_SAMPLE_RATE
fi

reminder_env="${SCRIPT_DIR}/.env.prod.reminder-worker"
if ensure_from_template "${reminder_env}" "${SCRIPT_DIR}/.env.prod.reminder-worker.template" "reminder-worker"; then
  set_from_env "${reminder_env}" NODE_ENV NODE_ENV
  set_from_env "${reminder_env}" LOG_LEVEL LOG_LEVEL
  set_from_env "${reminder_env}" POSTGRES_URL POSTGRES_URL
  set_from_env "${reminder_env}" REDIS_URL REDIS_URL
  set_from_env "${reminder_env}" DEVICE_TOKEN_TTL_SEC DEVICE_TOKEN_TTL_SEC
  set_from_env "${reminder_env}" SESSION_IDLE_TIMEOUT_SEC SESSION_IDLE_TIMEOUT_SEC
  set_from_env "${reminder_env}" DEVICE_CONVERSATION_IDLE_TIMEOUT_MS DEVICE_CONVERSATION_IDLE_TIMEOUT_MS
fi

insights_env="${SCRIPT_DIR}/.env.prod.insights-worker"
if ensure_from_template "${insights_env}" "${SCRIPT_DIR}/.env.prod.insights-worker.template" "insights-worker"; then
  set_from_env "${insights_env}" NODE_ENV NODE_ENV
  set_from_env "${insights_env}" LOG_LEVEL LOG_LEVEL
  set_from_env "${insights_env}" POSTGRES_URL POSTGRES_URL
  set_from_env "${insights_env}" REDIS_URL REDIS_URL
fi

digest_env="${SCRIPT_DIR}/.env.prod.digest-worker"
if ensure_from_template "${digest_env}" "${SCRIPT_DIR}/.env.prod.digest-worker.template" "digest-worker"; then
  set_from_env "${digest_env}" NODE_ENV NODE_ENV
  set_from_env "${digest_env}" LOG_LEVEL LOG_LEVEL
  set_from_env "${digest_env}" POSTGRES_URL POSTGRES_URL
  set_from_env "${digest_env}" REDIS_URL REDIS_URL
  set_from_env "${digest_env}" DIGEST_JOB_CRON_UTC DIGEST_JOB_CRON_UTC
  set_from_env "${digest_env}" DIGEST_DEFAULT_HOUR DIGEST_DEFAULT_HOUR
  set_from_env "${digest_env}" DIGEST_DEFAULT_MINUTE DIGEST_DEFAULT_MINUTE
  set_from_env "${digest_env}" EXPO_ACCESS_TOKEN EXPO_ACCESS_TOKEN
fi
