#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_CONFIG_SOURCE="${SCRIPT_DIR}/cloudwatch-agent.json"
AGENT_CONFIG_TARGET="/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.json"
PACKAGE_URL="https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb"

if [[ ! -f "${AGENT_CONFIG_SOURCE}" ]]; then
  echo "[cloudwatch] missing agent config at ${AGENT_CONFIG_SOURCE}"
  exit 1
fi

TOKEN="$(curl -fsS -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 21600' || true)"
if [[ -z "${TOKEN}" ]]; then
  echo "[cloudwatch] unable to query EC2 metadata token"
  exit 1
fi

ROLE_NAME="$(curl -fsS -H "X-aws-ec2-metadata-token: ${TOKEN}" http://169.254.169.254/latest/meta-data/iam/security-credentials/ || true)"
if [[ -z "${ROLE_NAME}" ]]; then
  echo "[cloudwatch] no EC2 instance profile is attached yet"
  echo "[cloudwatch] attach an IAM role with CloudWatchAgentServerPolicy, then rerun this script"
  exit 1
fi

echo "[cloudwatch] detected EC2 IAM role: ${ROLE_NAME}"

TMP_DEB="$(mktemp /tmp/amazon-cloudwatch-agent.XXXXXX.deb)"
trap 'rm -f "${TMP_DEB}"' EXIT

echo "[cloudwatch] downloading CloudWatch Agent package"
curl -fsSL "${PACKAGE_URL}" -o "${TMP_DEB}"

echo "[cloudwatch] installing CloudWatch Agent"
sudo dpkg -i -E "${TMP_DEB}"

echo "[cloudwatch] installing agent config"
sudo mkdir -p "$(dirname "${AGENT_CONFIG_TARGET}")"
sudo cp "${AGENT_CONFIG_SOURCE}" "${AGENT_CONFIG_TARGET}"

echo "[cloudwatch] starting agent"
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 -s \
  -c "file:${AGENT_CONFIG_TARGET}"

echo "[cloudwatch] agent status"
sudo systemctl --no-pager --full status amazon-cloudwatch-agent || true
