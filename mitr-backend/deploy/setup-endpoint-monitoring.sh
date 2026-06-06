#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_FILE="${SCRIPT_DIR}/cloudwatch-endpoint-monitor.yml"

AWS_REGION="${AWS_REGION:-ap-south-1}"
STACK_NAME="${STACK_NAME:-mitr-prod-endpoint-monitoring}"
BASE_URL="${BASE_URL:-https://api.heyreca.com}"
ALERT_TOPIC_NAME="${ALERT_TOPIC_NAME:-mitr-prod-alerts}"
SCHEDULE_EXPRESSION="${SCHEDULE_EXPRESSION:-rate(5 minutes)}"
PRODUCTION_LOG_GROUP="${PRODUCTION_LOG_GROUP:-/mitr/prod}"
DEPLOY_LOG_GROUP="${DEPLOY_LOG_GROUP:-/mitr/deploy}"
ROOT_DISK_DEVICE="${ROOT_DISK_DEVICE:-nvme0n1p1}"
ROOT_DISK_FSTYPE="${ROOT_DISK_FSTYPE:-ext4}"

if [[ ! -f "${TEMPLATE_FILE}" ]]; then
  echo "[endpoint-monitor] missing template: ${TEMPLATE_FILE}" >&2
  exit 1
fi

INSTANCE_ID="${INSTANCE_ID:-$(aws ec2 describe-instances \
  --region "${AWS_REGION}" \
  --filters \
    "Name=tag:Name,Values=mitr-prod-01" \
    "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].InstanceId | [0]' \
  --output text)}"

if [[ -z "${INSTANCE_ID}" || "${INSTANCE_ID}" == "None" ]]; then
  echo "[endpoint-monitor] no running EC2 instance tagged Name=mitr-prod-01 was found in ${AWS_REGION}" >&2
  exit 1
fi

INSTANCE_TYPE="${INSTANCE_TYPE:-$(aws ec2 describe-instances \
  --region "${AWS_REGION}" \
  --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].InstanceType' \
  --output text)}"

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
    "ProductionLogGroup=${PRODUCTION_LOG_GROUP}" \
    "DeployLogGroup=${DEPLOY_LOG_GROUP}" \
    "InstanceId=${INSTANCE_ID}" \
    "InstanceType=${INSTANCE_TYPE}" \
    "RootDiskDevice=${ROOT_DISK_DEVICE}" \
    "RootDiskFstype=${ROOT_DISK_FSTYPE}" \
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
  --alarm-name-prefix mitr-prod- \
  --query 'MetricAlarms[].{Name:AlarmName,State:StateValue}' \
  --output table

echo "[endpoint-monitor] service metric filters:"
aws logs describe-metric-filters \
  --region "${AWS_REGION}" \
  --log-group-name "${PRODUCTION_LOG_GROUP}" \
  --filter-name-prefix mitr-prod- \
  --query 'metricFilters[].{Filter:filterName,Pattern:filterPattern,Metric:metricTransformations[0].metricName}' \
  --output table
