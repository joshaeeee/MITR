#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.prod"
HTTP_CONF="${SCRIPT_DIR}/nginx.http.conf"
HTTPS_TEMPLATE="${SCRIPT_DIR}/nginx.https.conf.template"
TARGET_CONF="${SCRIPT_DIR}/nginx.conf"

get_env() {
  local key="$1"
  local value
  value="$(grep -E "^${key}=" "${ENV_FILE}" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  printf '%s' "${value}"
}

ENABLE_HTTPS="$(get_env ENABLE_HTTPS)"
PUBLIC_HOSTNAME="$(get_env PUBLIC_HOSTNAME)"
CERT_DIR="/etc/letsencrypt/live/${PUBLIC_HOSTNAME}"

if [[ "${ENABLE_HTTPS}" == "true" && -n "${PUBLIC_HOSTNAME}" && -f "${CERT_DIR}/fullchain.pem" && -f "${CERT_DIR}/privkey.pem" ]]; then
  sed "s#__PUBLIC_HOSTNAME__#${PUBLIC_HOSTNAME}#g" "${HTTPS_TEMPLATE}" > "${TARGET_CONF}"
  echo "[nginx] configured HTTPS for ${PUBLIC_HOSTNAME}"
else
  cp "${HTTP_CONF}" "${TARGET_CONF}"
  echo "[nginx] configured HTTP"
fi
