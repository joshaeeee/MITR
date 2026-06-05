#!/usr/bin/env bash
set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-south-1}"
INSTANCE_ID="${INSTANCE_ID:-}"
PROJECT_TAG="${PROJECT_TAG:-MITR}"
ENVIRONMENT_TAG="${ENVIRONMENT_TAG:-production}"
MONTHLY_BUDGET_USD="${MONTHLY_BUDGET_USD:-25}"
ALERT_EMAIL="${ALERT_EMAIL:-}"

if [[ -z "${INSTANCE_ID}" ]]; then
  echo "[aws-ops] INSTANCE_ID is required" >&2
  exit 1
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
TRAIL_NAME="${TRAIL_NAME:-mitr-management-events}"
TRAIL_BUCKET="${TRAIL_BUCKET:-mitr-cloudtrail-${ACCOUNT_ID}-${AWS_REGION}}"
ALERT_TOPIC_NAME="${ALERT_TOPIC_NAME:-mitr-prod-alerts}"
SNAPSHOT_ROLE_NAME="${SNAPSHOT_ROLE_NAME:-mitr-dlm-ebs-snapshot-role}"
SNAPSHOT_POLICY_DESCRIPTION="${SNAPSHOT_POLICY_DESCRIPTION:-MITR daily encrypted EBS snapshots}"

echo "[aws-ops] account=${ACCOUNT_ID} region=${AWS_REGION} instance=${INSTANCE_ID}"

echo "[aws-ops] setting IAM account password policy"
aws iam update-account-password-policy \
  --minimum-password-length 14 \
  --require-symbols \
  --require-numbers \
  --require-uppercase-characters \
  --require-lowercase-characters \
  --allow-users-to-change-password \
  --max-password-age 90 \
  --password-reuse-prevention 24 \
  --hard-expiry >/dev/null

echo "[aws-ops] ensuring alert SNS topic"
ALERT_TOPIC_ARN="$(aws sns create-topic \
  --name "${ALERT_TOPIC_NAME}" \
  --tags "Key=Project,Value=${PROJECT_TAG}" "Key=Environment,Value=${ENVIRONMENT_TAG}" \
  --query TopicArn \
  --output text)"

if [[ -n "${ALERT_EMAIL}" ]]; then
  if ! aws sns list-subscriptions-by-topic --topic-arn "${ALERT_TOPIC_ARN}" \
    --query "Subscriptions[?Endpoint=='${ALERT_EMAIL}'].SubscriptionArn" \
    --output text | grep -q .; then
    echo "[aws-ops] subscribing ${ALERT_EMAIL} to ${ALERT_TOPIC_NAME}; confirmation email must be accepted"
    aws sns subscribe \
      --topic-arn "${ALERT_TOPIC_ARN}" \
      --protocol email \
      --notification-endpoint "${ALERT_EMAIL}" >/dev/null
  fi
else
  echo "[aws-ops] ALERT_EMAIL not set; alarms will target ${ALERT_TOPIC_ARN} but no email subscription was added"
fi

echo "[aws-ops] ensuring CloudTrail S3 bucket ${TRAIL_BUCKET}"
if ! aws s3api head-bucket --bucket "${TRAIL_BUCKET}" >/dev/null 2>&1; then
  aws s3api create-bucket \
    --bucket "${TRAIL_BUCKET}" \
    --region "${AWS_REGION}" \
    --create-bucket-configuration "LocationConstraint=${AWS_REGION}" >/dev/null
fi

aws s3api put-public-access-block \
  --bucket "${TRAIL_BUCKET}" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws s3api put-bucket-versioning \
  --bucket "${TRAIL_BUCKET}" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket "${TRAIL_BUCKET}" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

TRAIL_BUCKET_POLICY="$(mktemp)"
trap 'rm -f "${TRAIL_BUCKET_POLICY}"' EXIT
cat > "${TRAIL_BUCKET_POLICY}" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AWSCloudTrailAclCheck",
      "Effect": "Allow",
      "Principal": { "Service": "cloudtrail.amazonaws.com" },
      "Action": "s3:GetBucketAcl",
      "Resource": "arn:aws:s3:::${TRAIL_BUCKET}"
    },
    {
      "Sid": "AWSCloudTrailWrite",
      "Effect": "Allow",
      "Principal": { "Service": "cloudtrail.amazonaws.com" },
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::${TRAIL_BUCKET}/AWSLogs/${ACCOUNT_ID}/*",
      "Condition": {
        "StringEquals": {
          "s3:x-amz-acl": "bucket-owner-full-control"
        }
      }
    }
  ]
}
JSON
aws s3api put-bucket-policy --bucket "${TRAIL_BUCKET}" --policy "file://${TRAIL_BUCKET_POLICY}"

echo "[aws-ops] ensuring multi-region CloudTrail ${TRAIL_NAME}"
if aws cloudtrail get-trail --name "${TRAIL_NAME}" >/dev/null 2>&1; then
  aws cloudtrail update-trail \
    --name "${TRAIL_NAME}" \
    --s3-bucket-name "${TRAIL_BUCKET}" \
    --is-multi-region-trail \
    --enable-log-file-validation >/dev/null
else
  aws cloudtrail create-trail \
    --name "${TRAIL_NAME}" \
    --s3-bucket-name "${TRAIL_BUCKET}" \
    --is-multi-region-trail \
    --enable-log-file-validation \
    --tags-list "Key=Project,Value=${PROJECT_TAG}" "Key=Environment,Value=${ENVIRONMENT_TAG}" >/dev/null
fi
aws cloudtrail start-logging --name "${TRAIL_NAME}"

echo "[aws-ops] ensuring GuardDuty"
if ! aws guardduty list-detectors --query 'DetectorIds[0]' --output text | grep -vq '^None$'; then
  aws guardduty create-detector \
    --enable \
    --finding-publishing-frequency FIFTEEN_MINUTES \
    --tags "Project=${PROJECT_TAG},Environment=${ENVIRONMENT_TAG}" >/dev/null
fi

echo "[aws-ops] ensuring CloudWatch alarms"
alarm_actions=(--alarm-actions "${ALERT_TOPIC_ARN}" --ok-actions "${ALERT_TOPIC_ARN}")
INSTANCE_TYPE="$(aws ec2 describe-instances \
  --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].InstanceType' \
  --output text)"
ROOT_DISK_DEVICE="${ROOT_DISK_DEVICE:-$(aws cloudwatch list-metrics \
  --namespace Mitr/EC2 \
  --metric-name disk_used_percent \
  --dimensions "Name=InstanceId,Value=${INSTANCE_ID}" "Name=path,Value=/" \
  --query "Metrics[0].Dimensions[?Name=='device'].Value | [0]" \
  --output text 2>/dev/null || true)}"
ROOT_DISK_FSTYPE="${ROOT_DISK_FSTYPE:-$(aws cloudwatch list-metrics \
  --namespace Mitr/EC2 \
  --metric-name disk_used_percent \
  --dimensions "Name=InstanceId,Value=${INSTANCE_ID}" "Name=path,Value=/" \
  --query "Metrics[0].Dimensions[?Name=='fstype'].Value | [0]" \
  --output text 2>/dev/null || true)}"
ROOT_DISK_DEVICE="${ROOT_DISK_DEVICE:-nvme0n1p1}"
ROOT_DISK_FSTYPE="${ROOT_DISK_FSTYPE:-ext4}"

aws cloudwatch put-metric-alarm \
  --alarm-name mitr-prod-ec2-status-check-failed \
  --alarm-description "MITR EC2 instance status check failed" \
  --namespace AWS/EC2 \
  --metric-name StatusCheckFailed \
  --dimensions "Name=InstanceId,Value=${INSTANCE_ID}" \
  --statistic Maximum \
  --period 60 \
  --evaluation-periods 2 \
  --datapoints-to-alarm 2 \
  --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data notBreaching \
  "${alarm_actions[@]}"

aws cloudwatch put-metric-alarm \
  --alarm-name mitr-prod-ec2-cpu-high \
  --alarm-description "MITR EC2 CPU >80% for 10 minutes" \
  --namespace AWS/EC2 \
  --metric-name CPUUtilization \
  --dimensions "Name=InstanceId,Value=${INSTANCE_ID}" \
  --statistic Average \
  --period 300 \
  --evaluation-periods 2 \
  --datapoints-to-alarm 2 \
  --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching \
  "${alarm_actions[@]}"

aws cloudwatch put-metric-alarm \
  --alarm-name mitr-prod-ec2-memory-high \
  --alarm-description "MITR EC2 memory >85% for 10 minutes" \
  --namespace Mitr/EC2 \
  --metric-name mem_used_percent \
  --dimensions "Name=InstanceId,Value=${INSTANCE_ID}" "Name=InstanceType,Value=${INSTANCE_TYPE}" \
  --statistic Average \
  --period 300 \
  --evaluation-periods 2 \
  --datapoints-to-alarm 2 \
  --threshold 85 \
  --comparison-operator GreaterThanThreshold \
  --treat-missing-data missing \
  "${alarm_actions[@]}"

aws cloudwatch put-metric-alarm \
  --alarm-name mitr-prod-ec2-disk-root-high \
  --alarm-description "MITR EC2 root disk >80%" \
  --namespace Mitr/EC2 \
  --metric-name disk_used_percent \
  --dimensions "Name=InstanceId,Value=${INSTANCE_ID}" "Name=InstanceType,Value=${INSTANCE_TYPE}" "Name=path,Value=/" "Name=device,Value=${ROOT_DISK_DEVICE}" "Name=fstype,Value=${ROOT_DISK_FSTYPE}" \
  --statistic Average \
  --period 300 \
  --evaluation-periods 1 \
  --datapoints-to-alarm 1 \
  --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --treat-missing-data missing \
  "${alarm_actions[@]}"

echo "[aws-ops] ensuring DLM role ${SNAPSHOT_ROLE_NAME}"
if ! aws iam get-role --role-name "${SNAPSHOT_ROLE_NAME}" >/dev/null 2>&1; then
  aws iam create-role \
    --role-name "${SNAPSHOT_ROLE_NAME}" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"dlm.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    --tags "Key=Project,Value=${PROJECT_TAG}" "Key=Environment,Value=${ENVIRONMENT_TAG}" >/dev/null
fi
aws iam attach-role-policy \
  --role-name "${SNAPSHOT_ROLE_NAME}" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole >/dev/null || true
SNAPSHOT_ROLE_ARN="$(aws iam get-role --role-name "${SNAPSHOT_ROLE_NAME}" --query 'Role.Arn' --output text)"

if ! aws dlm get-lifecycle-policies \
  --query "Policies[?Description=='${SNAPSHOT_POLICY_DESCRIPTION}'].PolicyId" \
  --output text | grep -q .; then
  echo "[aws-ops] creating daily EBS snapshot policy"
  aws dlm create-lifecycle-policy \
    --description "${SNAPSHOT_POLICY_DESCRIPTION}" \
    --state ENABLED \
    --execution-role-arn "${SNAPSHOT_ROLE_ARN}" \
    --policy-details "{
      \"ResourceTypes\": [\"VOLUME\"],
      \"TargetTags\": [{\"Key\":\"Project\",\"Value\":\"${PROJECT_TAG}\"},{\"Key\":\"Environment\",\"Value\":\"${ENVIRONMENT_TAG}\"}],
      \"Schedules\": [{
        \"Name\": \"daily-7-day-retention\",
        \"CreateRule\": {\"Interval\": 24, \"IntervalUnit\": \"HOURS\", \"Times\": [\"20:30\"]},
        \"RetainRule\": {\"Count\": 7},
        \"CopyTags\": true
      }]
    }" \
    --tags "Project=${PROJECT_TAG},Environment=${ENVIRONMENT_TAG}" >/dev/null
fi

echo "[aws-ops] ensuring EC2 volume tags for DLM"
VOLUME_IDS="$(aws ec2 describe-instances \
  --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].BlockDeviceMappings[].Ebs.VolumeId' \
  --output text)"
if [[ -n "${VOLUME_IDS}" ]]; then
  aws ec2 create-tags \
    --resources ${VOLUME_IDS} \
    --tags "Key=Project,Value=${PROJECT_TAG}" "Key=Environment,Value=${ENVIRONMENT_TAG}"
fi

if [[ -n "${MONTHLY_BUDGET_USD}" && -n "${ALERT_EMAIL}" ]]; then
  echo "[aws-ops] ensuring monthly budget ${MONTHLY_BUDGET_USD} USD"
  if ! aws budgets describe-budget --account-id "${ACCOUNT_ID}" --budget-name mitr-monthly-cost >/dev/null 2>&1; then
    aws budgets create-budget \
      --account-id "${ACCOUNT_ID}" \
      --budget "{
        \"BudgetName\":\"mitr-monthly-cost\",
        \"BudgetLimit\":{\"Amount\":\"${MONTHLY_BUDGET_USD}\",\"Unit\":\"USD\"},
        \"TimeUnit\":\"MONTHLY\",
        \"BudgetType\":\"COST\"
      }" \
      --notifications-with-subscribers "[{
        \"Notification\":{\"NotificationType\":\"ACTUAL\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":80,\"ThresholdType\":\"PERCENTAGE\"},
        \"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"${ALERT_EMAIL}\"}]
      },{
        \"Notification\":{\"NotificationType\":\"FORECASTED\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":100,\"ThresholdType\":\"PERCENTAGE\"},
        \"Subscribers\":[{\"SubscriptionType\":\"EMAIL\",\"Address\":\"${ALERT_EMAIL}\"}]
      }]" >/dev/null
  fi
else
  echo "[aws-ops] budget skipped; set ALERT_EMAIL to create budget notifications"
fi

echo "[aws-ops] complete"
