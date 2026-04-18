#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.prod.yml"
ENV_FILE="${SCRIPT_DIR}/.env.prod"
HEALTHCHECK_SCRIPT="${SCRIPT_DIR}/healthcheck.sh"
RUN_DB_MIGRATIONS="${RUN_DB_MIGRATIONS:-true}"
ALLOW_IMAGE_ROLLBACK_AFTER_MIGRATIONS="${ALLOW_IMAGE_ROLLBACK_AFTER_MIGRATIONS:-false}"

if ! command -v docker >/dev/null 2>&1; then
  echo "[deploy] docker not found"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "[deploy] docker compose plugin not found"
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[deploy] missing ${ENV_FILE}. Copy .env.prod.template and fill it."
  exit 1
fi

if [[ -n "${GHCR_USERNAME:-}" && -n "${GHCR_TOKEN:-}" ]]; then
  echo "[deploy] logging into ghcr.io as ${GHCR_USERNAME}"
  echo "${GHCR_TOKEN}" | docker login ghcr.io -u "${GHCR_USERNAME}" --password-stdin
fi

cd "${SCRIPT_DIR}"

if [[ -x "${SCRIPT_DIR}/configure-nginx.sh" ]]; then
  bash "${SCRIPT_DIR}/configure-nginx.sh"
fi

running_image() {
  local container="$1"
  docker inspect --format='{{.Config.Image}}' "${container}" 2>/dev/null || true
}

PREV_API_IMAGE="$(running_image mitr-api)"
PREV_AGENT_IMAGE="$(running_image mitr-agent-worker)"
PREV_WAKEWORD_WORKER_IMAGE="$(running_image mitr-wakeword-worker)"
PREV_REMINDER_IMAGE="$(running_image mitr-reminder-worker)"

echo "[deploy] previous images:"
echo "  api=${PREV_API_IMAGE:-<none>}"
echo "  agent=${PREV_AGENT_IMAGE:-<none>}"
echo "  wakeword-worker=${PREV_WAKEWORD_WORKER_IMAGE:-<none>}"
echo "  reminder=${PREV_REMINDER_IMAGE:-<none>}"

echo "[deploy] pulling latest images"
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" pull

if [[ "${RUN_DB_MIGRATIONS}" == "true" ]]; then
  echo "[deploy] baselining drizzle ledger"
  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" run --rm --no-deps api pnpm drizzle:baseline-ledger

  echo "[deploy] applying drizzle migrations"
  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" run --rm --no-deps api pnpm drizzle:migrate
else
  echo "[deploy] skipping database migrations"
fi

echo "[deploy] starting updated stack"
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d --remove-orphans

chmod +x "${HEALTHCHECK_SCRIPT}"
if BASE_URL="${HEALTH_BASE_URL:-http://127.0.0.1}" "${HEALTHCHECK_SCRIPT}"; then
  echo "[deploy] healthcheck passed"
  docker image prune -f >/dev/null 2>&1 || true
  exit 0
fi

echo "[deploy] healthcheck failed, attempting rollback"
if [[ "${RUN_DB_MIGRATIONS}" == "true" && "${ALLOW_IMAGE_ROLLBACK_AFTER_MIGRATIONS}" != "true" ]]; then
  echo "[deploy] automatic image rollback is disabled after migrations because schema changes may be incompatible"
  exit 1
fi

if [[ -n "${PREV_API_IMAGE}" && -n "${PREV_AGENT_IMAGE}" && -n "${PREV_WAKEWORD_WORKER_IMAGE}" && -n "${PREV_REMINDER_IMAGE}" ]]; then
  API_IMAGE="${PREV_API_IMAGE}" \
  AGENT_IMAGE="${PREV_AGENT_IMAGE}" \
  WAKEWORD_WORKER_IMAGE="${PREV_WAKEWORD_WORKER_IMAGE}" \
  REMINDER_IMAGE="${PREV_REMINDER_IMAGE}" \
  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d --remove-orphans

  if BASE_URL="${HEALTH_BASE_URL:-http://127.0.0.1}" "${HEALTHCHECK_SCRIPT}"; then
    echo "[deploy] rollback successful"
  else
    echo "[deploy] rollback failed"
    exit 1
  fi
else
  echo "[deploy] rollback unavailable (previous image refs missing)"
  exit 1
fi
