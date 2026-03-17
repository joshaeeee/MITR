#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/bootstrap-ec2.sh"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates \
  certbot \
  curl \
  git \
  jq \
  htop \
  unzip \
  docker.io \
  docker-compose-plugin

systemctl enable --now docker

if id -nG ubuntu >/dev/null 2>&1; then
  usermod -aG docker ubuntu || true
fi

mkdir -p /opt/mitr
chown -R ubuntu:ubuntu /opt/mitr 2>/dev/null || true

echo "Bootstrap complete."
echo "Next:"
echo "1) su - ubuntu"
echo "2) cd /opt/mitr"
echo "3) git clone https://github.com/joshaeeee/MITR.git"
echo "4) cp mitr-backend/deploy/.env.prod.template mitr-backend/deploy/.env.prod"
echo "5) edit .env.prod with real secrets"
echo "6) cd mitr-backend && bash deploy/deploy.sh"
