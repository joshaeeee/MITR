#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "[generate-prod-secrets] node is required" >&2
  exit 1
fi

node <<'NODE'
const { randomBytes } = require('node:crypto');

const internalServiceToken = randomBytes(32).toString('hex');
const shortCodePepper = randomBytes(32).toString('hex');
const voiceNotesEncryptionKey = randomBytes(32).toString('base64');

console.log('# Generated production secret values. Store these in prod env files or a secret manager.');
console.log('# Do not commit real values.');
console.log(`INTERNAL_SERVICE_TOKEN=${internalServiceToken}`);
console.log(`MITR_BACKEND_INTERNAL_TOKEN=${internalServiceToken}`);
console.log(`SHORT_CODE_PEPPER=${shortCodePepper}`);
console.log(`VOICE_NOTES_ENCRYPTION_KEY_B64=${voiceNotesEncryptionKey}`);
NODE
