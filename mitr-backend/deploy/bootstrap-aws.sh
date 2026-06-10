#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_NAME="${STACK_NAME:-mitr-production-infrastructure}"
AWS_REGION="${AWS_REGION:-ap-south-1}"
INSTANCE_ID="${1:-}"
PUBLIC_API_BASE_URL="${2:-}"

if [[ -z "${INSTANCE_ID}" ]]; then
  echo "Usage: AWS_REGION=ap-south-1 $0 <instance-id> [https://api.example.com]" >&2
  exit 1
fi

for command in aws gh; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "${command} is required" >&2
    exit 1
  fi
done

aws sts get-caller-identity >/dev/null
gh auth status >/dev/null

create_oidc_provider=true
stack_provider_status="$(
  aws cloudformation describe-stack-resource \
    --region "${AWS_REGION}" \
    --stack-name "${STACK_NAME}" \
    --logical-resource-id GitHubOidcProvider \
    --query "StackResourceDetail.ResourceStatus" \
    --output text 2>/dev/null || true
)"
if [[ -z "${stack_provider_status}" || "${stack_provider_status}" == "DELETE_COMPLETE" ]]; then
  oidc_provider_arn="$(
    aws iam list-open-id-connect-providers \
      --query "OpenIDConnectProviderList[?contains(Arn, 'token.actions.githubusercontent.com')].Arn | [0]" \
      --output text
  )"
  if [[ -n "${oidc_provider_arn}" && "${oidc_provider_arn}" != "None" ]]; then
    create_oidc_provider=false
  fi
fi

aws cloudformation deploy \
  --region "${AWS_REGION}" \
  --stack-name "${STACK_NAME}" \
  --template-file "${SCRIPT_DIR}/aws-infrastructure.yml" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    "InstanceId=${INSTANCE_ID}" \
    "CreateGitHubOidcProvider=${create_oidc_provider}"

instance_profile="$(
  aws cloudformation describe-stacks \
    --region "${AWS_REGION}" \
    --stack-name "${STACK_NAME}" \
    --query "Stacks[0].Outputs[?OutputKey=='Ec2InstanceProfileName'].OutputValue" \
    --output text
)"
deploy_role_arn="$(
  aws cloudformation describe-stacks \
    --region "${AWS_REGION}" \
    --stack-name "${STACK_NAME}" \
    --query "Stacks[0].Outputs[?OutputKey=='GitHubDeployRoleArn'].OutputValue" \
    --output text
)"
api_repository_uri="$(
  aws cloudformation describe-stacks \
    --region "${AWS_REGION}" \
    --stack-name "${STACK_NAME}" \
    --query "Stacks[0].Outputs[?OutputKey=='ApiRepositoryUri'].OutputValue" \
    --output text
)"
voice_gateway_repository_uri="$(
  aws cloudformation describe-stacks \
    --region "${AWS_REGION}" \
    --stack-name "${STACK_NAME}" \
    --query "Stacks[0].Outputs[?OutputKey=='VoiceGatewayRepositoryUri'].OutputValue" \
    --output text
)"

association_id="$(
  aws ec2 describe-iam-instance-profile-associations \
    --region "${AWS_REGION}" \
    --filters "Name=instance-id,Values=${INSTANCE_ID}" \
    --query "IamInstanceProfileAssociations[?State!='disassociated'] | [0].AssociationId" \
    --output text
)"
if [[ -n "${association_id}" && "${association_id}" != "None" ]]; then
  aws ec2 replace-iam-instance-profile-association \
    --region "${AWS_REGION}" \
    --association-id "${association_id}" \
    --iam-instance-profile "Name=${instance_profile}" >/dev/null
else
  aws ec2 associate-iam-instance-profile \
    --region "${AWS_REGION}" \
    --instance-id "${INSTANCE_ID}" \
    --iam-instance-profile "Name=${instance_profile}" >/dev/null
fi

aws ec2 modify-instance-metadata-options \
  --region "${AWS_REGION}" \
  --instance-id "${INSTANCE_ID}" \
  --http-endpoint enabled \
  --http-tokens required \
  --http-put-response-hop-limit 1 >/dev/null

aws ec2 enable-ebs-encryption-by-default \
  --region "${AWS_REGION}" >/dev/null

gh secret set AWS_DEPLOY_ROLE_ARN \
  --repo joshaeeee/MITR \
  --env Production \
  --body "${deploy_role_arn}"
gh secret set AWS_REGION \
  --repo joshaeeee/MITR \
  --env Production \
  --body "${AWS_REGION}"
gh secret set EC2_INSTANCE_ID \
  --repo joshaeeee/MITR \
  --env Production \
  --body "${INSTANCE_ID}"
gh secret set ECR_API_REPOSITORY \
  --repo joshaeeee/MITR \
  --env Production \
  --body "${api_repository_uri}"
gh secret set ECR_VOICE_GATEWAY_REPOSITORY \
  --repo joshaeeee/MITR \
  --env Production \
  --body "${voice_gateway_repository_uri}"

if [[ -n "${PUBLIC_API_BASE_URL}" ]]; then
  gh secret set PUBLIC_API_BASE_URL \
    --repo joshaeeee/MITR \
    --env Production \
    --body "${PUBLIC_API_BASE_URL}"
fi

echo "AWS infrastructure is ready."
echo "Instance profile: ${instance_profile}"
echo "GitHub deploy role: ${deploy_role_arn}"
echo "API ECR repository: ${api_repository_uri}"
echo "Voice gateway ECR repository: ${voice_gateway_repository_uri}"
