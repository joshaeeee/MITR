#!/usr/bin/env bash
set -euo pipefail

SDKCONFIG="${1:-sdkconfig}"

read_config() {
  local key="$1"
  grep -E "^${key}=" "${SDKCONFIG}" 2>/dev/null | tail -1 | cut -d= -f2- | sed 's/^"//; s/"$//' || true
}

if [[ ! -f "${SDKCONFIG}" ]]; then
  echo "Missing firmware config: ${SDKCONFIG}" >&2
  exit 1
fi

BACKEND_URL="$(read_config CONFIG_MITR_DEVICE_BACKEND_BASE_URL)"
GATEWAY_URL="$(read_config CONFIG_MITR_GATEWAY_WS_URL)"
ACCESS_TOKEN="$(read_config CONFIG_MITR_DEVICE_ACCESS_TOKEN)"
PAIRING_TOKEN="$(read_config CONFIG_MITR_DEVICE_PAIRING_TOKEN)"
WIFI_PASSWORD="$(read_config CONFIG_LK_EXAMPLE_WIFI_PASSWORD)"

failed=false

if [[ "${BACKEND_URL}" != https://* ]]; then
  echo "Production firmware backend URL must use https://, got: ${BACKEND_URL:-<empty>}" >&2
  failed=true
fi

if [[ "${GATEWAY_URL}" != wss://* ]]; then
  echo "Production firmware gateway URL must use wss://, got: ${GATEWAY_URL:-<empty>}" >&2
  failed=true
fi

if [[ -n "${ACCESS_TOKEN}" || -n "${PAIRING_TOKEN}" ]]; then
  echo "Production firmware must not bake device access or pairing tokens into sdkconfig." >&2
  failed=true
fi

if [[ -n "${WIFI_PASSWORD}" ]]; then
  echo "Production firmware must not bake a Wi-Fi password into sdkconfig." >&2
  failed=true
fi

if [[ "${failed}" == "true" ]]; then
  exit 1
fi

echo "Production firmware config guard passed: ${SDKCONFIG}"
