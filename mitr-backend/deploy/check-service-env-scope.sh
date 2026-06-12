#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

keys_in_file() {
  local file="$1"
  awk -F= '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    { gsub(/^[[:space:]]+|[[:space:]]+$/, "", $1); print $1 }
  ' "${file}"
}

check_file() {
  local label="$1"
  local file="$2"
  local forbidden_pattern="$3"
  local allowed_pattern="$4"

  if [[ ! -f "${file}" ]]; then
    echo "[service-env-scope] missing ${file}" >&2
    return 1
  fi

  local bad
  bad="$(keys_in_file "${file}" | grep -E "${forbidden_pattern}" | grep -Ev "${allowed_pattern}" || true)"
  if [[ -n "${bad}" ]]; then
    echo "[service-env-scope] ${label} env contains forbidden keys:" >&2
    echo "${bad}" >&2
    return 1
  fi
}

WORKER_FORBIDDEN='^(OPENAI|OPENROUTER|GOOGLE|CARTESIA|SARVAM|EXA|PROKERALA|BHAGAVAD_GITA|YOUTUBE|YTDLP|AUTH_|TWILIO_|DEVICE_(ACCESS|PAIRING|BOOTSTRAP|SECRET|AUTH)|INTERNAL_SERVICE_TOKEN|SHORT_CODE_PEPPER|MEM0_|QDRANT_|EMBEDDING_|VOICE_NOTES_)'
GATEWAY_FORBIDDEN='^(POSTGRES_URL|REDIS_URL|MEM0_|QDRANT_|EMBEDDING_|EXA_|PROKERALA_|BHAGAVAD_GITA_|AUTH_|TWILIO_|DEVICE_|VOICE_NOTES_|EXPO_ACCESS_TOKEN|CORS_ORIGINS|API_PUBLIC_BASE_URL)'

check_file "voice-gateway" "${SCRIPT_DIR}/.env.prod.voice-gateway" "${GATEWAY_FORBIDDEN}" '^$'
check_file "reminder-worker" "${SCRIPT_DIR}/.env.prod.reminder-worker" "${WORKER_FORBIDDEN}" '^$'
check_file "insights-worker" "${SCRIPT_DIR}/.env.prod.insights-worker" "${WORKER_FORBIDDEN}" '^$'
check_file "digest-worker" "${SCRIPT_DIR}/.env.prod.digest-worker" "${WORKER_FORBIDDEN}" '^(EXPO_ACCESS_TOKEN)$'

echo "[service-env-scope] service env scope passed"
