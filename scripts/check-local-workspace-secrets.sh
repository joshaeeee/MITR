#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

files_file="$(mktemp)"
matches_file="$(mktemp)"
trap 'rm -f "${files_file}" "${matches_file}"' EXIT

{
  git ls-files -oi --exclude-standard 2>/dev/null || true
  find . -name '.env*' -type f -print 2>/dev/null | sed 's#^\./##'
} \
  | sort -u \
  | grep -Ev '(^|/)(\.git|node_modules|dist|build|build-|managed_components|\.venv|__pycache__|target|\.cache)/' \
  | grep -Ev '\.(aiff|bin|jpg|jpeg|mp3|mp4|png|wav|webm|whl)$' \
  > "${files_file}"

scan_pattern() {
  local pattern="$1"
  local label="$2"
  if [[ ! -s "${files_file}" ]]; then
    return 0
  fi

  while IFS= read -r file; do
    [[ -f "${file}" ]] || continue
    if grep -EIq "${pattern}" "${file}" 2>/dev/null; then
      printf '%s\t%s\n' "${label}" "${file}" >> "${matches_file}"
    fi
  done < "${files_file}"
}

scan_pattern 'sk-(proj-)?[A-Za-z0-9_-]{20,}' 'OpenAI API key'
scan_pattern 'gh[pousr]_[A-Za-z0-9_]{20,}' 'GitHub token'
scan_pattern 'AIza[0-9A-Za-z_-]{35}' 'Google API key'
scan_pattern 'AKIA[0-9A-Z]{16}' 'AWS access key id'
scan_pattern '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----' 'private key material'
scan_pattern 'VOICE_NOTES_ENCRYPTION_KEY_B64=[A-Za-z0-9+/=]{20,}' 'voice-note encryption key'

scan_sensitive_env_assignments() {
  if [[ ! -s "${files_file}" ]]; then
    return 0
  fi

  while IFS= read -r file; do
    [[ -f "${file}" ]] || continue
    while IFS= read -r line || [[ -n "${line}" ]]; do
      [[ "${line}" =~ ^[[:space:]]*# ]] && continue
      [[ "${line}" =~ ^[[:space:]]*$ ]] && continue
      [[ "${line}" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue

      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      value="${value%%#*}"
      value="$(printf '%s' "${value}" | sed -E 's/^[[:space:]]+|[[:space:]]+$//g; s/^["'\'']|["'\'']$//g')"
      [[ -n "${value}" ]] || continue

      if [[ ! "${key}" =~ (^|_)(API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SERVICE_TOKEN|CLIENT_SECRET|CLIENT_ID|ACCOUNT_SID|PASSWORD|ENCRYPTION_KEY(_B64)?|PRIVATE_KEY|SECRET|PEPPER)$ ]]; then
        continue
      fi

      normalized="$(printf '%s' "${value}" | tr '[:upper:]' '[:lower:]')"
      if [[ "${normalized}" =~ ^(<.*>|replace-me|replaceme|changeme|change_me|placeholder|dummy|none|null|false|true|test)$ ]]; then
        continue
      fi
      if [[ "${normalized}" == *example.com* || "${normalized}" == *localhost* || "${normalized}" == *127.0.0.1* ]]; then
        continue
      fi
      if [[ "${normalized}" =~ ^(test-|dev-|local-) ]]; then
        continue
      fi
      if (( ${#value} < 8 )); then
        continue
      fi

      printf 'sensitive env value\t%s\n' "${file}" >> "${matches_file}"
      break
    done < "${file}"
  done < "${files_file}"
}

scan_sensitive_env_assignments

if [[ -s "${matches_file}" ]]; then
  echo "[local-secret-scan] possible secrets found in ignored/local files:" >&2
  sort -u "${matches_file}" | while IFS=$'\t' read -r label file; do
    printf '[local-secret-scan] %s: %s\n' "${label}" "${file}" >&2
  done
  echo "[local-secret-scan] rotate exposed keys and remove them from the workspace before launch" >&2
  exit 1
fi

echo "[local-secret-scan] passed"
