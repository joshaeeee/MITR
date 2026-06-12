#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env.prod"
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
ROOT_HOSTNAME="$(get_env ROOT_HOSTNAME)"
WEB_HOSTNAME="$(get_env WEB_HOSTNAME)"
TLS_CERT_NAME="$(get_env TLS_CERT_NAME)"
CERT_NAME="${TLS_CERT_NAME:-${PUBLIC_HOSTNAME}}"
CERT_DIR="/etc/letsencrypt/live/${CERT_NAME}"

cert_ready() {
  local cert_dir="$1"
  if command -v sudo >/dev/null 2>&1; then
    sudo test -f "${cert_dir}/fullchain.pem" && sudo test -f "${cert_dir}/privkey.pem"
    return
  fi
  test -f "${cert_dir}/fullchain.pem" && test -f "${cert_dir}/privkey.pem"
}

if [[ "${ENABLE_HTTPS}" == "true" && -z "${PUBLIC_HOSTNAME}" ]]; then
  echo "[nginx] ENABLE_HTTPS=true but PUBLIC_HOSTNAME is empty" >&2
  exit 1
fi

if [[ "${ENABLE_HTTPS}" == "true" ]] && ! cert_ready "${CERT_DIR}"; then
  echo "[nginx] ENABLE_HTTPS=true but certificate files are missing under ${CERT_DIR}" >&2
  echo "[nginx] provision certs before production deploy, or run the HTTP bootstrap config manually outside deploy.sh" >&2
  exit 1
fi

if [[ "${ENABLE_HTTPS}" == "true" ]]; then
  SERVER_NAMES="${PUBLIC_HOSTNAME}"
  if [[ -n "${ROOT_HOSTNAME}" ]]; then
    SERVER_NAMES="${SERVER_NAMES} ${ROOT_HOSTNAME}"
  fi
  if [[ -n "${WEB_HOSTNAME}" ]]; then
    SERVER_NAMES="${SERVER_NAMES} ${WEB_HOSTNAME}"
  fi

  cat > "${TARGET_CONF}" <<EOF
worker_processes auto;

events {
  worker_connections 1024;
}

http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  server_tokens off;

  add_header X-Content-Type-Options nosniff always;
  add_header X-Frame-Options DENY always;
  add_header Referrer-Policy no-referrer always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

  sendfile on;
  tcp_nopush on;
  tcp_nodelay on;
  keepalive_timeout 65;
  keepalive_requests 1000;

  map \$http_upgrade \$connection_upgrade {
    default upgrade;
    '' close;
  }

  resolver 127.0.0.11 valid=30s ipv6=off;
  limit_req_zone \$binary_remote_addr zone=mitr_api_per_ip:10m rate=10r/s;
  limit_req_status 429;

  server {
    listen 80 default_server;
    server_name ${SERVER_NAMES};

    location /.well-known/acme-challenge/ {
      alias /var/www/certbot/.well-known/acme-challenge/;
    }

    location = /healthz {
      set \$mitr_api http://api:8080;
      proxy_pass \$mitr_api;
      proxy_http_version 1.1;
      proxy_set_header Host \$host;
      proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location = /health/latency {
      set \$mitr_api http://api:8080;
      proxy_pass \$mitr_api;
      proxy_http_version 1.1;
      proxy_set_header Host \$host;
      proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location = /connect {
      set \$mitr_voice_gateway http://voice-gateway:7861;
      proxy_pass \$mitr_voice_gateway;
      proxy_http_version 1.1;

      proxy_set_header Host \$host;
      proxy_set_header X-Real-IP \$remote_addr;
      proxy_set_header X-Forwarded-For \$remote_addr;
      proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
      return 301 https://\$host\$request_uri;
    }
  }

  server {
    listen 443 ssl;
    http2 on;
    server_name ${PUBLIC_HOSTNAME};

    client_max_body_size 15m;
    proxy_connect_timeout 15s;
    proxy_send_timeout 60s;
    proxy_read_timeout 60s;
    send_timeout 60s;

    ssl_certificate /etc/letsencrypt/live/${CERT_NAME}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${CERT_NAME}/privkey.pem;
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:10m;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location /.well-known/acme-challenge/ {
      alias /var/www/certbot/.well-known/acme-challenge/;
    }

    location = /ws {
      set \$mitr_voice_gateway http://voice-gateway:7861;
      proxy_pass \$mitr_voice_gateway;
      proxy_http_version 1.1;
      proxy_read_timeout 3600s;
      proxy_send_timeout 3600s;

      proxy_set_header Host \$host;
      proxy_set_header X-Real-IP \$remote_addr;
      proxy_set_header X-Forwarded-For \$remote_addr;
      proxy_set_header X-Forwarded-Proto \$scheme;
      proxy_set_header Upgrade \$http_upgrade;
      proxy_set_header Connection \$connection_upgrade;
    }

    location = /connect {
      set \$mitr_voice_gateway http://voice-gateway:7861;
      proxy_pass \$mitr_voice_gateway;
      proxy_http_version 1.1;

      proxy_set_header Host \$host;
      proxy_set_header X-Real-IP \$remote_addr;
      proxy_set_header X-Forwarded-For \$remote_addr;
      proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location ^~ /internal {
      return 404;
    }

    location / {
      limit_req zone=mitr_api_per_ip burst=60 nodelay;
      set \$mitr_api http://api:8080;
      proxy_pass \$mitr_api;
      proxy_http_version 1.1;

      proxy_set_header Host \$host;
      proxy_set_header X-Real-IP \$remote_addr;
      proxy_set_header X-Forwarded-For \$remote_addr;
      proxy_set_header X-Forwarded-Proto \$scheme;
      proxy_set_header Upgrade \$http_upgrade;
      proxy_set_header Connection \$connection_upgrade;
    }
  }
EOF

  if [[ -n "${ROOT_HOSTNAME}" && -n "${WEB_HOSTNAME}" ]]; then
    cat >> "${TARGET_CONF}" <<EOF

  server {
    listen 443 ssl;
    http2 on;
    server_name ${ROOT_HOSTNAME};

    ssl_certificate /etc/letsencrypt/live/${CERT_NAME}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${CERT_NAME}/privkey.pem;
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:10m;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    return 301 https://${WEB_HOSTNAME}\$request_uri;
  }
EOF
  fi

  if [[ -n "${WEB_HOSTNAME}" ]]; then
    cat >> "${TARGET_CONF}" <<EOF

  server {
    listen 443 ssl;
    http2 on;
    server_name ${WEB_HOSTNAME};

    ssl_certificate /etc/letsencrypt/live/${CERT_NAME}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${CERT_NAME}/privkey.pem;
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:10m;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    root /usr/share/nginx/html;
    index index.html;

    location /.well-known/acme-challenge/ {
      alias /var/www/certbot/.well-known/acme-challenge/;
    }

    location = /privacy-policy {
      try_files /privacy-policy/index.html =404;
    }

    location = /account-deletion {
      try_files /account-deletion/index.html =404;
    }

    location / {
      try_files \$uri \$uri/ /index.html;
    }
  }
EOF
  fi

  cat >> "${TARGET_CONF}" <<'EOF'
}
EOF
  echo "[nginx] configured HTTPS for ${PUBLIC_HOSTNAME}"
else
  cp "${HTTP_CONF}" "${TARGET_CONF}"
  echo "[nginx] configured HTTP"
fi
