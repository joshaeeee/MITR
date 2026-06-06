#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.prod.yml"
ENV_FILE="${SCRIPT_DIR}/.env.prod"
HEALTHCHECK_SCRIPT="${SCRIPT_DIR}/healthcheck.sh"
USE_SSM_ENV="${USE_SSM_ENV:-true}"
SSM_ENV_PATH="${SSM_ENV_PATH:-/mitr/prod}"
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

if [[ "${USE_SSM_ENV}" == "true" ]]; then
  echo "[deploy] syncing production env from SSM Parameter Store (${SSM_ENV_PATH})"
  AWS_REGION="${AWS_REGION:-ap-south-1}" bash "${SCRIPT_DIR}/sync-env-from-ssm.sh" "${SSM_ENV_PATH}" "${ENV_FILE}"
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[deploy] missing ${ENV_FILE}. Copy .env.prod.template and fill it."
  exit 1
fi

set_env_value() {
  local key="$1"
  local value="$2"
  local tmp_file="${ENV_FILE}.tmp"

  awk -v k="${key}" -v v="${value}" -F= '
    BEGIN { updated=0 }
    $1 == k {
      if (!updated) {
        print k "=" v
        updated=1
      }
      next
    }
    { print }
    END {
      if (!updated) print k "=" v
    }
  ' "${ENV_FILE}" > "${tmp_file}"
  install -m 600 "${tmp_file}" "${ENV_FILE}"
  rm -f "${tmp_file}"
}

# CI supplies immutable image references after the SSM environment has synced.
# This prevents stale image values in Parameter Store from overriding the build
# that triggered the deployment.
if [[ -n "${DEPLOY_API_IMAGE:-}" ]]; then
  set_env_value API_IMAGE "${DEPLOY_API_IMAGE}"
fi
if [[ -n "${DEPLOY_PIPECAT_GATEWAY_IMAGE:-}" ]]; then
  set_env_value PIPECAT_GATEWAY_IMAGE "${DEPLOY_PIPECAT_GATEWAY_IMAGE}"
fi
if [[ -n "${DEPLOY_REMINDER_IMAGE:-}" ]]; then
  set_env_value REMINDER_IMAGE "${DEPLOY_REMINDER_IMAGE}"
fi

login_ecr_registries() {
  if ! command -v aws >/dev/null 2>&1; then
    return
  fi

  local image registry
  local -a images=(
    "$(grep -E '^API_IMAGE=' "${ENV_FILE}" | tail -1 | cut -d= -f2- || true)"
    "$(grep -E '^PIPECAT_GATEWAY_IMAGE=' "${ENV_FILE}" | tail -1 | cut -d= -f2- || true)"
    "$(grep -E '^REMINDER_IMAGE=' "${ENV_FILE}" | tail -1 | cut -d= -f2- || true)"
  )
  local -a registries=()

  for image in "${images[@]}"; do
    [[ "${image}" == *.dkr.ecr.*.amazonaws.com/* ]] || continue
    registry="${image%%/*}"
    if [[ ! " ${registries[*]} " =~ " ${registry} " ]]; then
      registries+=("${registry}")
    fi
  done

  for registry in "${registries[@]}"; do
    echo "[deploy] logging into ECR registry ${registry}"
    aws ecr get-login-password --region "${AWS_REGION:-ap-south-1}" | docker login --username AWS --password-stdin "${registry}" >/dev/null
  done
}

bash "${SCRIPT_DIR}/bootstrap-service-env-files.sh" "${ENV_FILE}"

for worker_env in \
  "${SCRIPT_DIR}/.env.prod.pipecat-gateway" \
  "${SCRIPT_DIR}/.env.prod.reminder-worker" \
  "${SCRIPT_DIR}/.env.prod.insights-worker" \
  "${SCRIPT_DIR}/.env.prod.digest-worker"
do
  if [[ ! -f "${worker_env}" ]]; then
    echo "[deploy] missing ${worker_env}. It should be generated from deploy/.env.prod by bootstrap-service-env-files.sh."
    exit 1
  fi
done

bash "${SCRIPT_DIR}/check-service-env-scope.sh"
export VALIDATE_OPENAI_API_KEY="${VALIDATE_OPENAI_API_KEY:-true}"
bash "${SCRIPT_DIR}/preflight-prod-env.sh" "${ENV_FILE}"

echo "[deploy] validating docker compose configuration"
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" config >/dev/null

if [[ -n "${GHCR_USERNAME:-}" && -n "${GHCR_TOKEN:-}" ]]; then
  echo "[deploy] logging into ghcr.io as ${GHCR_USERNAME}"
  echo "${GHCR_TOKEN}" | docker login ghcr.io -u "${GHCR_USERNAME}" --password-stdin
fi

login_ecr_registries

cd "${SCRIPT_DIR}"

if [[ -x "${SCRIPT_DIR}/setup-https.sh" ]]; then
  bash "${SCRIPT_DIR}/setup-https.sh"
fi

if [[ -x "${SCRIPT_DIR}/configure-nginx.sh" ]]; then
  bash "${SCRIPT_DIR}/configure-nginx.sh"
  if docker inspect mitr-nginx >/dev/null 2>&1; then
    docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d --force-recreate --no-deps nginx
    docker exec mitr-nginx nginx -t
  fi
fi

running_image() {
  local container="$1"
  docker inspect --format='{{.Config.Image}}' "${container}" 2>/dev/null || true
}

dump_deploy_diagnostics() {
  echo "[deploy] docker compose status"
  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" ps || true

  for container in mitr-api mitr-pipecat-gateway mitr-reminder-worker mitr-insights-worker mitr-digest-worker mitr-nginx; do
    echo "[deploy] diagnostics for ${container}"
    docker inspect --format='state={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}} exit={{.State.ExitCode}} error={{.State.Error}}' "${container}" 2>/dev/null || true
    docker logs --tail=80 "${container}" 2>&1 || true
  done

  if docker inspect mitr-api >/dev/null 2>&1; then
    echo "[deploy] internal API readiness snapshot"
    docker exec mitr-api node -e "import('./dist/src/services/health/health-status.js').then(async (m) => { console.log(JSON.stringify(await m.getApiHealthStatus(), null, 2)); }).catch((error) => { console.error(error && error.stack ? error.stack : String(error)); process.exit(1); })" 2>&1 || true
  fi
}

PREV_API_IMAGE="$(running_image mitr-api)"
PREV_PIPECAT_GATEWAY_IMAGE="$(running_image mitr-pipecat-gateway)"
PREV_REMINDER_IMAGE="$(running_image mitr-reminder-worker)"

echo "[deploy] previous images:"
echo "  api=${PREV_API_IMAGE:-<none>}"
echo "  pipecat-gateway=${PREV_PIPECAT_GATEWAY_IMAGE:-<none>}"
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
if ! docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d --remove-orphans; then
  echo "[deploy] docker compose startup failed"
  dump_deploy_diagnostics
  exit 1
fi

chmod +x "${HEALTHCHECK_SCRIPT}"
if BASE_URL="${HEALTH_BASE_URL:-http://127.0.0.1}" "${HEALTHCHECK_SCRIPT}"; then
  echo "[deploy] healthcheck passed"
  docker image prune -f >/dev/null 2>&1 || true
  exit 0
fi

echo "[deploy] healthcheck failed, attempting rollback"
if [[ "${RUN_DB_MIGRATIONS}" == "true" && "${ALLOW_IMAGE_ROLLBACK_AFTER_MIGRATIONS}" != "true" ]]; then
  echo "[deploy] automatic image rollback is disabled after migrations because schema changes may be incompatible"
  dump_deploy_diagnostics
  exit 1
fi

if [[ -n "${PREV_API_IMAGE}" && -n "${PREV_PIPECAT_GATEWAY_IMAGE}" && -n "${PREV_REMINDER_IMAGE}" ]]; then
  API_IMAGE="${PREV_API_IMAGE}" \
  PIPECAT_GATEWAY_IMAGE="${PREV_PIPECAT_GATEWAY_IMAGE}" \
  REMINDER_IMAGE="${PREV_REMINDER_IMAGE}" \
  docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d --remove-orphans

  if BASE_URL="${HEALTH_BASE_URL:-http://127.0.0.1}" "${HEALTHCHECK_SCRIPT}"; then
    echo "[deploy] rollback successful"
  else
    echo "[deploy] rollback failed"
    dump_deploy_diagnostics
    exit 1
  fi
else
  echo "[deploy] rollback unavailable (previous image refs missing)"
  dump_deploy_diagnostics
  exit 1
fi
