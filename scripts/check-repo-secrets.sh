#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if ! command -v git >/dev/null 2>&1; then
  echo "[secret-scan] git not found" >&2
  exit 1
fi

files_file="$(mktemp)"
matches_file="$(mktemp)"
trap 'rm -f "${files_file}" "${matches_file}"' EXIT

{
  git ls-files -co --exclude-standard \
    | grep -Ev '(^|/)(node_modules|dist|build|build-|managed_components|\.venv|__pycache__)/' \
    || true
} > "${files_file}"

grep_files() {
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

grep_files 'sk-(proj-)?[A-Za-z0-9_-]{20,}' 'OpenAI API key'
grep_files 'gh[pousr]_[A-Za-z0-9_]{20,}' 'GitHub token'
grep_files 'AIza[0-9A-Za-z_-]{35}' 'Google API key'
grep_files 'AKIA[0-9A-Z]{16}' 'AWS access key id'
grep_files '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----' 'private key material'
grep_files 'CONFIG_(MITR_DEVICE_(ACCESS_TOKEN|PAIRING_TOKEN)|LK_EXAMPLE_WIFI_PASSWORD)="[^"]+"' 'firmware-baked device token or Wi-Fi password'
grep_files 'VOICE_NOTES_ENCRYPTION_KEY_B64=[A-Za-z0-9+/=]{20,}' 'voice-note encryption key'

scan_sensitive_env_assignments() {
  if [[ ! -s "${files_file}" ]]; then
    return 0
  fi

  while IFS= read -r file; do
    [[ -f "${file}" ]] || continue
    case "${file}" in
      *.env|*.env.*|*sdkconfig*) ;;
      *) continue ;;
    esac
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
  echo "[secret-scan] possible secrets found in tracked/untracked files:" >&2
  sort -u "${matches_file}" | while IFS=$'\t' read -r label file; do
    printf '[secret-scan] %s: %s\n' "${label}" "${file}" >&2
  done
  echo "[secret-scan] rotate exposed keys and remove them from the workspace before launch" >&2
  exit 1
fi

echo "[secret-scan] passed"
