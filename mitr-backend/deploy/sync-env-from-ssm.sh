#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARAMETER_PATH="${1:-/mitr/prod}"
ENV_FILE="${2:-${SCRIPT_DIR}/.env.prod}"
TEMPLATE_FILE="${3:-${SCRIPT_DIR}/.env.prod.template}"
AWS_REGION="${AWS_REGION:-ap-south-1}"

if ! command -v aws >/dev/null 2>&1; then
  echo "[ssm-env] aws CLI is required" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "[ssm-env] python3 is required" >&2
  exit 1
fi

if [[ "${PARAMETER_PATH}" != /* ]]; then
  echo "[ssm-env] parameter path must start with /, got: ${PARAMETER_PATH}" >&2
  exit 1
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "${tmp_dir}"' EXIT

params_tsv="${tmp_dir}/parameters.tsv"
params_json="${tmp_dir}/parameters.json"
ordered_keys="${tmp_dir}/ordered-keys.txt"
seen_keys="${tmp_dir}/seen-keys.txt"
env_tmp="${tmp_dir}/env.out"
touch "${params_tsv}" "${ordered_keys}" "${seen_keys}" "${env_tmp}"

if ! aws ssm get-parameters-by-path \
  --region "${AWS_REGION}" \
  --path "${PARAMETER_PATH}" \
  --recursive \
  --with-decryption \
  --query 'Parameters[*].[Name,Value]' \
  --output json > "${params_json}"
then
  echo "[ssm-env] failed to read ${PARAMETER_PATH} from SSM (${AWS_REGION})" >&2
  exit 1
fi

python3 -c '
import json
import re
import sys

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    parameters = json.load(handle)

for name, value in parameters:
    key = str(name).strip("/").split("/")[-1]
    if not re.fullmatch(r"[A-Z0-9_]+", key):
        raise SystemExit(f"[ssm-env] invalid env key from SSM parameter name: {name}")
    normalized = str(value or "").replace("\r\n", "\\n").replace("\n", "\\n")
    print(f"{key}\t{normalized}")
' "${params_json}" > "${params_tsv}"

if [[ ! -s "${params_tsv}" ]]; then
  echo "[ssm-env] no parameters found under ${PARAMETER_PATH} in ${AWS_REGION}" >&2
  exit 1
fi

if [[ -f "${TEMPLATE_FILE}" ]]; then
  awk -F= '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    {
      key=$1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
      if (key ~ /^[A-Z0-9_]+$/ && !seen[key]++) print key
    }
  ' "${TEMPLATE_FILE}" > "${ordered_keys}"
fi

awk -F'	' '{ print $1 }' "${params_tsv}" | sort -u > "${tmp_dir}/all-keys.txt"
comm -23 "${tmp_dir}/all-keys.txt" <(sort -u "${ordered_keys}") >> "${ordered_keys}" || true

while IFS= read -r key; do
  [[ -n "${key}" ]] || continue
  if grep -qxF "${key}" "${seen_keys}"; then
    continue
  fi
  value="$(awk -F'	' -v k="${key}" '$1 == k { sub(/^[^\t]*\t/, ""); print; found=1; exit } END { if (!found) exit 1 }' "${params_tsv}" || true)"
  if [[ -n "${value}" || "$(awk -F'	' -v k="${key}" '$1 == k { print "yes"; exit }' "${params_tsv}")" == "yes" ]]; then
    printf '%s=%s\n' "${key}" "${value}" >> "${env_tmp}"
    printf '%s\n' "${key}" >> "${seen_keys}"
  fi
done < "${ordered_keys}"

install -m 600 "${env_tmp}" "${ENV_FILE}"
echo "[ssm-env] wrote ${ENV_FILE} from ${PARAMETER_PATH} (${AWS_REGION})"
