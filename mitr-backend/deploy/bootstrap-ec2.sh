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
  gnupg \
  jq \
  htop \
  python3 \
  unzip \
  unattended-upgrades

if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  . /etc/os-release
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${VERSION_CODENAME}
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF

  apt-get update
  apt-get install -y --no-install-recommends \
    containerd.io \
    docker-buildx-plugin \
    docker-ce \
    docker-ce-cli \
    docker-compose-plugin
fi

if ! command -v aws >/dev/null 2>&1; then
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "${tmp_dir}"' EXIT
  curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip \
    -o "${tmp_dir}/awscliv2.zip"
  unzip -q "${tmp_dir}/awscliv2.zip" -d "${tmp_dir}"
  "${tmp_dir}/aws/install"
fi

systemctl enable --now docker
systemctl enable --now unattended-upgrades

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
echo "4) attach the EC2 IAM role and populate SSM path /mitr/prod"
echo "5) cd MITR/mitr-backend && bash deploy/deploy.sh"
