#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://localhost:8081}"
USER_A_TOKEN="${USER_A_TOKEN:-}"
USER_B_TOKEN="${USER_B_TOKEN:-}"
INTERNAL_SERVICE_TOKEN="${INTERNAL_SERVICE_TOKEN:-}"
REQUIRE_INTERNAL_SERVICE_CHECK="${REQUIRE_INTERNAL_SERVICE_CHECK:-false}"

failures=0
checks=0
skips=0

redact() {
  sed -E 's/[A-Za-z0-9_-]{24,}/[redacted]/g'
}

curl_status() {
  local method="$1"
  local path="$2"
  local token="${3:-}"
  local body="${4:-}"
  local internal_token="${5:-}"
  local header_args=("-H" "accept: application/json")
  if [ -n "${token}" ]; then
    header_args+=("-H" "authorization: Bearer ${token}")
  fi
  if [ -n "${internal_token}" ]; then
    header_args+=("-H" "x-internal-service-token: ${internal_token}")
  fi

  if [ -n "${body}" ]; then
    header_args+=("-H" "content-type: application/json")
    curl -sS -o /tmp/mitr-security-abuse-response.$$ \
      -w '%{http_code}' \
      -X "${method}" \
      "${header_args[@]}" \
      --data "${body}" \
      "${API_BASE}${path}"
  else
    curl -sS -o /tmp/mitr-security-abuse-response.$$ \
      -w '%{http_code}' \
      -X "${method}" \
      "${header_args[@]}" \
      "${API_BASE}${path}"
  fi
}

expect_status() {
  local name="$1"
  local method="$2"
  local path="$3"
  local token="$4"
  local body="$5"
  local allowed_statuses="$6"
  local internal_token="${7:-}"
  checks=$((checks + 1))
  local status
  status="$(curl_status "${method}" "${path}" "${token}" "${body}" "${internal_token}")"
  if [[ " ${allowed_statuses} " == *" ${status} "* ]]; then
    printf '[security-abuse] ok: %s -> %s\n' "${name}" "${status}"
    return 0
  fi

  failures=$((failures + 1))
  printf '[security-abuse] FAIL: %s -> %s, expected one of: %s\n' "${name}" "${status}" "${allowed_statuses}" >&2
  if [ -s /tmp/mitr-security-abuse-response.$$ ]; then
    sed -n '1,6p' /tmp/mitr-security-abuse-response.$$ | redact >&2
  fi
}

require_user_tokens() {
  if [ -n "${USER_A_TOKEN}" ] && [ -n "${USER_B_TOKEN}" ]; then
    return 0
  fi
  printf '[security-abuse] set USER_A_TOKEN and USER_B_TOKEN to run cross-user checks\n' >&2
  return 1
}

skip_if_empty() {
  local variable_name="$1"
  local value="$2"
  local description="$3"
  if [ -n "${value}" ]; then
    return 1
  fi
  skips=$((skips + 1))
  printf '[security-abuse] skip: %s requires %s\n' "${description}" "${variable_name}"
  return 0
}

is_truthy() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

trap 'rm -f /tmp/mitr-security-abuse-response.$$' EXIT

if is_truthy "${REQUIRE_INTERNAL_SERVICE_CHECK}" && {
  [ -z "${INTERNAL_SERVICE_TOKEN}" ] ||
    [ -z "${USER_A_TOKEN}" ] ||
    [ -z "${USER_B_TOKEN}" ] ||
    [ -z "${USER_A_ID:-}" ] ||
    [ -z "${USER_B_FAMILY_ID:-}" ]
}; then
  printf '[security-abuse] FAIL: REQUIRE_INTERNAL_SERVICE_CHECK=true requires INTERNAL_SERVICE_TOKEN, USER_A_TOKEN, USER_B_TOKEN, USER_A_ID, and USER_B_FAMILY_ID\n' >&2
  exit 1
fi

expect_status "protected route rejects missing bearer token" "GET" "/family/me" "" "" "401"
expect_status "internal Pipecat tool rejects missing internal token" \
  "POST" \
  "/internal/pipecat/tool" \
  "" \
  '{"name":"news_retrieve","arguments":{"query":"test"},"context":{"userId":"00000000-0000-4000-8000-000000000000"}}' \
  "401 503"

if require_user_tokens; then
  expect_status "user A can access own family context" "GET" "/family/me" "${USER_A_TOKEN}" "" "200"
  expect_status "user B can access own family context" "GET" "/family/me" "${USER_B_TOKEN}" "" "200"

  if ! skip_if_empty USER_A_MEMBER_ID "${USER_A_MEMBER_ID:-}" "cross-family member role mutation"; then
    expect_status "user B cannot change user A family member role" \
      "PATCH" \
      "/family/members/${USER_A_MEMBER_ID}/role" \
      "${USER_B_TOKEN}" \
      '{"role":"owner"}' \
      "403 404"
  fi

  if ! skip_if_empty USER_A_ALERT_ID "${USER_A_ALERT_ID:-}" "cross-family alert acknowledgement"; then
    expect_status "user B cannot acknowledge user A alert" \
      "POST" \
      "/alerts/${USER_A_ALERT_ID}/ack" \
      "${USER_B_TOKEN}" \
      "" \
      "403 404"
  fi

  if ! skip_if_empty USER_A_CARE_ITEM_ID "${USER_A_CARE_ITEM_ID:-}" "cross-family care item update"; then
    expect_status "user B cannot patch user A care item" \
      "PATCH" \
      "/care/items/${USER_A_CARE_ITEM_ID}" \
      "${USER_B_TOKEN}" \
      '{"title":"cross-user mutation should fail"}' \
      "403 404"
  fi

  if ! skip_if_empty USER_A_ROUTINE_ID "${USER_A_ROUTINE_ID:-}" "cross-family routine update"; then
    expect_status "user B cannot patch user A routine" \
      "PATCH" \
      "/care/routines/${USER_A_ROUTINE_ID}" \
      "${USER_B_TOKEN}" \
      '{"enabled":false}' \
      "403 404"
  fi

  if ! skip_if_empty USER_A_LONG_SESSION_ID "${USER_A_LONG_SESSION_ID:-}" "cross-user long session read"; then
    expect_status "user B cannot read user A long session" \
      "GET" \
      "/long-session/${USER_A_LONG_SESSION_ID}" \
      "${USER_B_TOKEN}" \
      "" \
      "403 404"
    expect_status "user B cannot stop user A long session" \
      "POST" \
      "/long-session/stop" \
      "${USER_B_TOKEN}" \
      "{\"longSessionId\":\"${USER_A_LONG_SESSION_ID}\",\"reason\":\"abuse-smoke\"}" \
      "403 404"
  fi

  if ! skip_if_empty USER_A_SESSION_ID "${USER_A_SESSION_ID:-}" "cross-user short session termination"; then
    expect_status "user B cannot end user A session" \
      "POST" \
      "/session/end" \
      "${USER_B_TOKEN}" \
      "{\"sessionId\":\"${USER_A_SESSION_ID}\"}" \
      "403 404"
  fi

  if ! skip_if_empty USER_A_PAIRING_ID "${USER_A_PAIRING_ID:-}" "cross-family pairing status read"; then
    expect_status "user B cannot read user A device pairing status" \
      "GET" \
      "/devices/pairing/${USER_A_PAIRING_ID}" \
      "${USER_B_TOKEN}" \
      "" \
      "403 404"
  fi

  if [ -n "${INTERNAL_SERVICE_TOKEN}" ] && [ -n "${USER_A_ID:-}" ] && [ -n "${USER_B_FAMILY_ID:-}" ]; then
    expect_status "internal Pipecat tool rejects mismatched family context" \
      "POST" \
      "/internal/pipecat/tool" \
      "" \
      "{\"name\":\"news_retrieve\",\"arguments\":{\"query\":\"test\"},\"context\":{\"userId\":\"${USER_A_ID}\",\"familyId\":\"${USER_B_FAMILY_ID}\"}}" \
      "403" \
      "${INTERNAL_SERVICE_TOKEN}"
  else
    if is_truthy "${REQUIRE_INTERNAL_SERVICE_CHECK}"; then
      failures=$((failures + 1))
      printf '[security-abuse] FAIL: internal mismatched family check was required but INTERNAL_SERVICE_TOKEN, USER_A_ID, or USER_B_FAMILY_ID is missing\n' >&2
    else
      skips=$((skips + 1))
      printf '[security-abuse] skip: internal mismatched family check requires INTERNAL_SERVICE_TOKEN, USER_A_ID, USER_B_FAMILY_ID\n'
    fi
  fi
elif is_truthy "${REQUIRE_INTERNAL_SERVICE_CHECK}"; then
  failures=$((failures + 1))
  printf '[security-abuse] FAIL: internal mismatched family check requires seeded USER_A_TOKEN and USER_B_TOKEN\n' >&2
fi

printf '[security-abuse] complete: checks=%s skips=%s failures=%s\n' "${checks}" "${skips}" "${failures}"
if [ "${failures}" -gt 0 ]; then
  exit 1
fi
