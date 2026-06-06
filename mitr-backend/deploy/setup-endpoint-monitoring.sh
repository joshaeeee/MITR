#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_FILE="${SCRIPT_DIR}/cloudwatch-endpoint-monitor.yml"

AWS_REGION="${AWS_REGION:-ap-south-1}"
STACK_NAME="${STACK_NAME:-mitr-prod-endpoint-monitoring}"
BASE_URL="${BASE_URL:-https://api.heyreca.com}"
ALERT_TOPIC_NAME="${ALERT_TOPIC_NAME:-mitr-prod-alerts}"
SCHEDULE_EXPRESSION="${SCHEDULE_EXPRESSION:-rate(5 minutes)}"

if [[ ! -f "${TEMPLATE_FILE}" ]]; then
  echo "[endpoint-monitor] missing template: ${TEMPLATE_FILE}" >&2
  exit 1
fi

ALERT_TOPIC_ARN="${ALERT_TOPIC_ARN:-$(aws sns list-topics \
  --region "${AWS_REGION}" \
  --query "Topics[?ends_with(TopicArn, ':${ALERT_TOPIC_NAME}')].TopicArn | [0]" \
  --output text)}"

if [[ -z "${ALERT_TOPIC_ARN}" || "${ALERT_TOPIC_ARN}" == "None" ]]; then
  echo "[endpoint-monitor] SNS topic ${ALERT_TOPIC_NAME} was not found in ${AWS_REGION}" >&2
  exit 1
fi

echo "[endpoint-monitor] validating CloudFormation template"
aws cloudformation validate-template \
  --region "${AWS_REGION}" \
  --template-body "file://${TEMPLATE_FILE}" >/dev/null

echo "[endpoint-monitor] deploying ${STACK_NAME}"
aws cloudformation deploy \
  --region "${AWS_REGION}" \
  --stack-name "${STACK_NAME}" \
  --template-file "${TEMPLATE_FILE}" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    "BaseUrl=${BASE_URL}" \
    "AlertTopicArn=${ALERT_TOPIC_ARN}" \
    "ScheduleExpression=${SCHEDULE_EXPRESSION}" \
  --tags Project=MITR Environment=production

RESULT_FILE="$(mktemp)"
trap 'rm -f "${RESULT_FILE}"' EXIT

echo "[endpoint-monitor] invoking monitor once for verification"
aws lambda invoke \
  --region "${AWS_REGION}" \
  --function-name mitr-prod-endpoint-monitor \
  --cli-binary-format raw-in-base64-out \
  --payload '{}' \
  "${RESULT_FILE}" >/dev/null
cat "${RESULT_FILE}"
echo

echo "[endpoint-monitor] dashboard: MITR-Production"
echo "[endpoint-monitor] alarms:"
aws cloudwatch describe-alarms \
  --region "${AWS_REGION}" \
  --alarm-name-prefix mitr-prod-endpoint- \
  --query 'MetricAlarms[].{Name:AlarmName,State:StateValue}' \
  --output table

