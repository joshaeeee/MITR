#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1}"
MAX_WAIT_SECONDS="${MAX_WAIT_SECONDS:-120}"
SLEEP_SECONDS="${SLEEP_SECONDS:-4}"

deadline=$((SECONDS + MAX_WAIT_SECONDS))

check_endpoint() {
  local path="$1"
  curl -fsS --max-time 5 "${BASE_URL}${path}" >/dev/null
}

echo "[healthcheck] waiting for ${BASE_URL}/healthz and /health/latency"

while (( SECONDS < deadline )); do
  if check_endpoint "/healthz" && check_endpoint "/health/latency"; then
    echo "[healthcheck] OK"
    exit 0
  fi
  sleep "${SLEEP_SECONDS}"
done

echo "[healthcheck] FAILED after ${MAX_WAIT_SECONDS}s"
exit 1
