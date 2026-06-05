#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.prod"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.prod.yml"
CERTBOT_WEBROOT="/opt/mitr/certbot-www"
HTTP_CONF="${SCRIPT_DIR}/nginx.http.conf"
TARGET_CONF="${SCRIPT_DIR}/nginx.conf"

get_env() {
  local key="$1"
  local value
  value="$(grep -E "^${key}=" "${ENV_FILE}" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  printf '%s' "${value}"
}

ENABLE_HTTPS="$(get_env ENABLE_HTTPS)"
PUBLIC_HOSTNAME="$(get_env PUBLIC_HOSTNAME)"
TLS_ADDITIONAL_HOSTNAMES="$(get_env TLS_ADDITIONAL_HOSTNAMES)"
TLS_CERT_NAME="$(get_env TLS_CERT_NAME)"
TLS_EMAIL="$(get_env TLS_EMAIL)"

if [[ "${ENABLE_HTTPS}" != "true" ]]; then
  echo "[https] ENABLE_HTTPS is not true; skipping"
  exit 0
fi

if [[ -z "${PUBLIC_HOSTNAME}" || -z "${TLS_EMAIL}" ]]; then
  echo "[https] PUBLIC_HOSTNAME and TLS_EMAIL must be set"
  exit 1
fi

CERTBOT_DOMAINS=("${PUBLIC_HOSTNAME}")
if [[ -n "${TLS_ADDITIONAL_HOSTNAMES}" ]]; then
  IFS=',' read -r -a ADDITIONAL_HOSTS <<< "${TLS_ADDITIONAL_HOSTNAMES}"
  for host in "${ADDITIONAL_HOSTS[@]}"; do
    host="$(printf '%s' "${host}" | xargs)"
    if [[ -n "${host}" ]]; then
      CERTBOT_DOMAINS+=("${host}")
    fi
  done
fi

CERTBOT_DOMAIN_ARGS=()
for host in "${CERTBOT_DOMAINS[@]}"; do
  CERTBOT_DOMAIN_ARGS+=("-d" "${host}")
done

CERTBOT_CERT_NAME="${TLS_CERT_NAME:-${PUBLIC_HOSTNAME}}"
CERT_DIR="/etc/letsencrypt/live/${CERTBOT_CERT_NAME}"

cert_ready() {
  sudo test -f "${CERT_DIR}/fullchain.pem" && sudo test -f "${CERT_DIR}/privkey.pem"
}

if ! command -v certbot >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y certbot
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y certbot
  else
    echo "[https] Cannot install certbot: no apt-get or dnf found"
    exit 1
  fi
fi

sudo mkdir -p "${CERTBOT_WEBROOT}"
sudo chown -R "${USER}:${USER}" "${CERTBOT_WEBROOT}"

if cert_ready; then
  echo "[https] existing certificate is ready for ${CERTBOT_CERT_NAME}"
  exit 0
fi

if [[ ! -f "${HTTP_CONF}" ]]; then
  echo "[https] missing ${HTTP_CONF}; cannot bootstrap certbot HTTP challenge"
  exit 1
fi

cp "${HTTP_CONF}" "${TARGET_CONF}"
echo "[https] bootstrapped HTTP nginx config for certbot challenge"
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d --force-recreate --no-deps nginx

sudo certbot certonly \
  --webroot \
  --webroot-path "${CERTBOT_WEBROOT}" \
  --non-interactive \
  --agree-tos \
  --expand \
  --cert-name "${CERTBOT_CERT_NAME}" \
  --email "${TLS_EMAIL}" \
  "${CERTBOT_DOMAIN_ARGS[@]}" \
  --keep-until-expiring

bash "${SCRIPT_DIR}/configure-nginx.sh"
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d --force-recreate --no-deps nginx

sudo install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
sudo tee /etc/letsencrypt/renewal-hooks/deploy/mitr-nginx-reload >/dev/null <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
docker exec mitr-nginx nginx -s reload
EOF
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/mitr-nginx-reload

if command -v systemctl >/dev/null 2>&1 && sudo systemctl list-unit-files certbot.timer >/dev/null 2>&1; then
  sudo systemctl enable --now certbot.timer >/dev/null 2>&1 || true
  echo "[https] using certbot.timer for renewal"
else
  sudo mkdir -p /etc/cron.d
  sudo tee /etc/cron.d/mitr-certbot-renew >/dev/null <<EOF
17 3 * * * root certbot renew --quiet --webroot -w ${CERTBOT_WEBROOT} --deploy-hook "docker exec mitr-nginx nginx -s reload"
EOF
  sudo chmod 644 /etc/cron.d/mitr-certbot-renew
  echo "[https] installed cron renewal at /etc/cron.d/mitr-certbot-renew"
fi

echo "[https] HTTPS configured for ${PUBLIC_HOSTNAME}"
