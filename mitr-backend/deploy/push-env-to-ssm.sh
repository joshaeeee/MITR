#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${1:-${SCRIPT_DIR}/.env.prod}"
PARAMETER_PATH="${2:-/mitr/prod}"
AWS_REGION="${AWS_REGION:-ap-south-1}"
OVERWRITE="${OVERWRITE:-true}"

if ! command -v aws >/dev/null 2>&1; then
  echo "[ssm-env] aws CLI is required" >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[ssm-env] missing ${ENV_FILE}" >&2
  exit 1
fi

if [[ "${PARAMETER_PATH}" != /* ]]; then
  echo "[ssm-env] parameter path must start with /, got: ${PARAMETER_PATH}" >&2
  exit 1
fi

is_secret_key() {
  local key="$1"
  case "${key}" in
    *SECRET*|*TOKEN*|*PASSWORD*|*PASS*|*PRIVATE_KEY*|*API_KEY*|*AUTH_KEY*|*PEPPER*|*ENCRYPTION_KEY*|POSTGRES_URL|DATABASE_URL|LIVEKIT_API_SECRET|TWILIO_AUTH_TOKEN|SESSION_SECRET)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

tmp_env="$(mktemp)"
trap 'rm -f "${tmp_env}"' EXIT

awk -F= '
  /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
  {
    key=$1
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
    if (key !~ /^[A-Z0-9_]+$/) next
    sub(/^[^=]*=/, "")
    print key "\t" $0
  }
' "${ENV_FILE}" > "${tmp_env}"

count=0
while IFS=$'\t' read -r key value; do
  [[ -n "${key}" ]] || continue
  if [[ -z "${value}" ]]; then
    echo "[ssm-env] skipped ${PARAMETER_PATH%/}/${key} (empty)"
    continue
  fi
  param_name="${PARAMETER_PATH%/}/${key}"
  param_type="String"
  if is_secret_key "${key}"; then
    param_type="SecureString"
  fi

  args=(
    ssm put-parameter
    --region "${AWS_REGION}"
    --name "${param_name}"
    --type "${param_type}"
    --value "${value}"
  )
  if [[ "${OVERWRITE}" == "true" ]]; then
    args+=(--overwrite)
  fi

  aws "${args[@]}" >/dev/null
  count=$((count + 1))
  echo "[ssm-env] stored ${param_name} (${param_type})"
done < "${tmp_env}"

echo "[ssm-env] stored ${count} parameter(s) under ${PARAMETER_PATH} (${AWS_REGION})"
