#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8');

const extractFunctionBody = (source, functionName) => {
  const patterns = [
    new RegExp(`async\\s+${functionName}\\s*\\(`),
    new RegExp(`const\\s+${functionName}\\s*=\\s*async\\s*\\(`)
  ];
  const matchIndex = patterns
    .map((pattern) => {
      const match = pattern.exec(source);
      return match ? match.index : -1;
    })
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  if (matchIndex === undefined) return null;

  const paramsStart = source.indexOf('(', matchIndex);
  if (paramsStart < 0) return null;

  let parenDepth = 0;
  let paramsEnd = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') parenDepth += 1;
    if (char === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        paramsEnd = index;
        break;
      }
    }
  }
  if (paramsEnd < 0) return null;

  let bodyStart = -1;
  for (let index = paramsEnd + 1; index < source.length; index += 1) {
    if (source[index] !== '{') continue;
    let previousIndex = index - 1;
    while (previousIndex > paramsEnd && /\s/.test(source[previousIndex])) previousIndex -= 1;
    const previous = source[previousIndex];
    if (previous === ')' || previous === '>') {
      bodyStart = index;
      break;
    }
  }
  if (bodyStart < 0) return null;

  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }
  return null;
};

const requireContains = (relativePath, needle, description) => {
  const source = read(relativePath);
  if (!source.includes(needle)) {
    failures.push(`${relativePath}: ${description}`);
  }
};

const requireNotContains = (relativePath, needle, description) => {
  const source = read(relativePath);
  if (source.includes(needle)) {
    failures.push(`${relativePath}: ${description}`);
  }
};

const requireFunctionContains = (relativePath, functionName, needles, description) => {
  const source = read(relativePath);
  const body = extractFunctionBody(source, functionName);
  if (!body) {
    failures.push(`${relativePath}: missing ${functionName} for ${description}`);
    return;
  }
  for (const needle of needles) {
    if (!body.includes(needle)) {
      failures.push(`${relativePath}: ${functionName} missing ${needle} (${description})`);
    }
  }
};

const requireMinOccurrences = (relativePath, needle, min, description) => {
  const source = read(relativePath);
  const count = source.split(needle).length - 1;
  if (count < min) {
    failures.push(`${relativePath}: expected at least ${min} occurrences of ${needle}; found ${count} (${description})`);
  }
};

const familyRepository = 'mitr-backend/src/services/family/family-repository.ts';
const deviceControl = 'mitr-backend/src/services/device/device-control-service.ts';
const deviceRoutes = 'mitr-backend/src/routes/device.ts';
const authRoutes = 'mitr-backend/src/routes/auth.ts';
const authService = 'mitr-backend/src/services/auth/auth-service.ts';
const oauthVerifier = 'mitr-backend/src/services/auth/oauth-verifier.ts';
const sessionRoutes = 'mitr-backend/src/routes/session.ts';
const sessionDirector = 'mitr-backend/src/services/long-session/session-director-service.ts';
const agentRoutes = 'mitr-backend/src/routes/agent.ts';
const nudgesRoutes = 'mitr-backend/src/routes/nudges.ts';
const voiceNotesService = 'mitr-backend/src/services/nudges/voice-notes-service.ts';
const rateLimit = 'mitr-backend/src/lib/rate-limit.ts';
const shortCodeHash = 'mitr-backend/src/lib/short-code-hash.ts';
const backendIndex = 'mitr-backend/src/index.ts';
const reminderWorker = 'mitr-backend/src/workers/reminder-worker.ts';
const insightsWorker = 'mitr-backend/src/workers/insights-worker.ts';
const digestWorker = 'mitr-backend/src/workers/digest-worker.ts';
const insightsPipeline = 'mitr-backend/src/services/insights/insights-pipeline-service.ts';
const recommendationFeedback = 'mitr-backend/src/services/insights/recommendation-feedback-service.ts';
const gatewayAuth = 'mitr-backend/pipecat-gateway/mitr_pipecat_gateway/auth.py';
const webSimulator = 'mitr-backend/tools/web-sim/index.html';

requireFunctionContains(
  familyRepository,
  'getFamilyByUser',
  ['eq(familyMembers.userId, userId)', 'isNotNull(familyMembers.acceptedAt)'],
  'pending family invites must not grant family access'
);
requireFunctionContains(
  familyRepository,
  'getMemberByUser',
  ['eq(familyMembers.userId, userId)', 'isNotNull(familyMembers.acceptedAt)'],
  'pending family invites must not grant member access'
);
requireFunctionContains(
  familyRepository,
  'setMemberRole',
  [
    'eq(familyMembers.id, memberId)',
    'eq(familyMembers.familyId, familyId)',
    'Only accepted app users can be promoted to owner',
    'Family must have at least one owner'
  ],
  'family role changes must be scoped and preserve at least one owner'
);
requireFunctionContains(
  familyRepository,
  'removeMember',
  ['eq(familyMembers.id, memberId)', 'eq(familyMembers.familyId, familyId)', 'Family must have at least one owner'],
  'family member removal must be scoped and preserve at least one owner'
);
requireFunctionContains(
  familyRepository,
  'updateAlertStatus',
  ['eq(alerts.id, alertId)', 'eq(alerts.elderId, elder.id)'],
  'alert acknowledge/resolve must be scoped to the caller elder'
);
requireFunctionContains(
  familyRepository,
  'acknowledgeNudge',
  ['eq(nudges.id, nudgeId)', 'eq(nudges.elderId, elder.id)'],
  'nudge acknowledgement must be scoped to the caller elder'
);
requireFunctionContains(
  familyRepository,
  'markNudgeDelivered',
  ['eq(nudges.id, nudgeId)', 'eq(nudges.elderId, elder.id)'],
  'single nudge delivery must be scoped to the caller elder'
);
requireFunctionContains(
  familyRepository,
  'markNudgesDelivered',
  ['inArray(nudges.id, dedupedIds)', 'eq(nudges.elderId, elder.id)'],
  'bulk nudge delivery must be scoped to the caller elder'
);
requireFunctionContains(
  familyRepository,
  'patchRoutine',
  ['eq(careRoutines.id, routineId)', 'eq(careRoutines.elderId, elder.id)'],
  'routine updates must be scoped to the caller elder'
);
requireFunctionContains(
  familyRepository,
  'patchCarePlanItem',
  ['eq(carePlanItems.elderId, elder.id)', 'eq(careReminders.elderId, elder.id)', 'eq(careRoutines.elderId, elder.id)'],
  'care plan updates must be scoped to the caller elder across planner and legacy rows'
);
requireFunctionContains(
  familyRepository,
  'deleteCarePlanItem',
  ['eq(carePlanItems.elderId, elder.id)', 'eq(careReminders.elderId, elder.id)', 'eq(careRoutines.elderId, elder.id)'],
  'care plan deletes must be scoped to the caller elder across planner and legacy rows'
);
requireFunctionContains(
  familyRepository,
  'patchCareReminder',
  ['eq(careReminders.id, reminderId)', 'eq(careReminders.elderId, elder.id)'],
  'legacy care reminder updates must be scoped to the caller elder'
);
requireFunctionContains(
  familyRepository,
  'deleteCareReminder',
  ['eq(careReminders.id, reminderId)', 'eq(careReminders.elderId, elder.id)'],
  'legacy care reminder deletes must be scoped to the caller elder'
);

requireFunctionContains(
  insightsPipeline,
  'updateConcernStatus',
  ['eq(concernSignals.id, signalId)', 'eq(concernSignals.elderId, elder.id)'],
  'insight concern review/resolve must be scoped to the caller elder'
);
requireFunctionContains(
  insightsPipeline,
  'explanations',
  ['eq(insightEvidenceSpans.elderId, elder.id)'],
  'insight explanation evidence must be scoped to the caller elder'
);
requireFunctionContains(
  recommendationFeedback,
  'addFeedback',
  ['eq(insightRecommendations.id, input.recommendationId)', 'eq(insightRecommendations.elderId, elder.id)'],
  'insight recommendation feedback must be scoped to the caller elder'
);

requireFunctionContains(
  sessionRoutes,
  'requireOwnedLongSession',
  ['session.userId !== userId', "reply.status(404).send({ error: 'Long session not found' })"],
  'long-session route access must check ownership before read/mutate'
);
requireContains(
  sessionRoutes,
  'session.userId !== request.auth!.user.id',
  'short session termination must verify the session belongs to the caller'
);
requireMinOccurrences(
  sessionRoutes,
  'requireOwnedLongSession(reply, request.auth!.user.id',
  4,
  'long-session read/next/stop/summary routes must all enforce ownership'
);
requireFunctionContains(
  sessionDirector,
  'completeBlock',
  ['block.longSessionId !== input.longSessionId', 'Long session block does not belong to session'],
  'long-session block completion must reject block/session mismatch'
);
requireContains(
  authRoutes,
  'const refreshLimit = createRateLimit',
  'refresh token route must have a dedicated rate limiter'
);
requireContains(
  authRoutes,
  "app.post('/auth/session/refresh', { preHandler: refreshLimit }",
  'refresh token route must use the refresh rate limiter'
);
requireContains(
  authRoutes,
  'refreshToken: z.string().min(32)',
  'refresh token route should reject trivially short token guesses'
);
requireContains(
  authRoutes,
  'token: z.string().min(20).max(8192)',
  'OAuth route should reject trivially short and oversized ID tokens'
);
requireContains(
  authRoutes,
  'code: z.string().regex(/^\\d{6}$/)',
  'OTP verification route must require the generated six-digit OTP format'
);
requireContains(
  oauthVerifier,
  "candidate.kty === 'RSA'",
  'OAuth verifier must only accept RSA JWK signing keys'
);
requireContains(
  oauthVerifier,
  "(!candidate.use || candidate.use === 'sig')",
  'OAuth verifier must only accept JWKs intended for signatures'
);
requireContains(
  oauthVerifier,
  "(!candidate.alg || candidate.alg === 'RS256')",
  'OAuth verifier must only accept RS256 JWKs'
);
requireContains(
  authService,
  'const safeStringEquals =',
  'legacy password verification must use a timing-safe comparison helper'
);
requireContains(
  authService,
  'safeStringEquals(password, legacyPasswordParts.join',
  'legacy password verification must use timing-safe comparison'
);
requireContains(
  authService,
  "hashShortCode('otp', code)",
  'OTP codes must be stored with the server-side short-code pepper'
);
requireContains(
  authService,
  'returning({ id: otpChallenges.id })',
  'OTP challenges must be atomically consumed before issuing a session'
);
requireContains(
  authService,
  'and(eq(otpChallenges.id, challenge.id), isNull(otpChallenges.consumedAt))',
  'OTP consumption must reject concurrent replay'
);
requireContains(
  authService,
  'returning({ id: authSessions.id })',
  'refresh token rotation must atomically revoke the current session before issuing a replacement'
);
requireContains(
  authService,
  'and(eq(authSessions.id, current.id), isNull(authSessions.revokedAt))',
  'refresh token rotation must reject concurrent replay'
);
requireContains(
  shortCodeHash,
  "createHmac('sha256'",
  'short low-entropy codes must use keyed HMAC hashing'
);
requireContains(
  shortCodeHash,
  'SHORT_CODE_PEPPER',
  'short-code HMAC hashing must use a server-side pepper'
);
requireNotContains(
  authService,
  'legacyPassword === password',
  'legacy password verification must not use direct string equality'
);

requireContains(
  agentRoutes,
  "app.post('/internal/pipecat/tool', { preHandler: requireInternalServiceAuth }",
  'Pipecat tool bridge must require internal service auth'
);
requireContains(
  agentRoutes,
  'deviceControl.verifyPipecatToolContext(parsed.data.context)',
  'Pipecat tool bridge must verify user/family/elder/device context'
);
requireFunctionContains(
  deviceControl,
  'verifyPipecatToolContext',
  [
    'input.familyId && input.familyId !== family.id',
    'input.elderId && input.elderId !== elder?.id',
    'deviceFamilyMatches',
    'return false'
  ],
  'Pipecat tool context must reject cross-family, cross-elder, and cross-device calls'
);
requireFunctionContains(
  deviceControl,
  'startPairing',
  [
    'Device is already claimed by another family',
    'pairing.familyId !== familyContext.familyId',
    'Device is already in a pairing flow for another family',
    'eq(devicePairings.familyId, familyContext.familyId)'
  ],
  'device pairing must not let one family revoke or hijack another family pairing'
);
requireContains(
  deviceRoutes,
  'claimCode: z.string().regex(/^\\d{6}$/)',
  'public device claim completion must require a six-digit claim code in its request schema'
);
requireContains(
  deviceRoutes,
  'pairingToken: z.string().min(32)',
  'public device bootstrap completion must require a high-entropy pairing token in its request schema'
);
requireContains(
  deviceRoutes,
  "key: bodyFieldsKey(['deviceId', 'claimCode'])",
  'public device claim completion must rate-limit by both device ID and claim code'
);
requireContains(
  deviceRoutes,
  "key: bodyFieldsKey(['deviceId', 'pairingToken'])",
  'public device bootstrap completion must rate-limit by both device ID and pairing token'
);
requireFunctionContains(
  deviceControl,
  'completeClaim',
  [
    "hashShortCode('device-claim', input.claimCode)",
    'eq(deviceClaims.codeHash, codeHash)',
    'isNull(deviceClaims.consumedAt)',
    'and(eq(deviceClaims.id, claim.id), isNull(deviceClaims.consumedAt))',
    'returning({ id: deviceClaims.id })',
    'claim.expiresAt.getTime() <= Date.now()',
    'throw new Error(\'Invalid or expired claim code\')'
  ],
  'device claim completion must validate and consume a hashed claim code'
);
requireFunctionContains(
  deviceControl,
  'startClaim',
  ["hashShortCode('device-claim', claimCode)"],
  'device claim codes must be stored with the server-side short-code pepper'
);
requireFunctionContains(
  deviceControl,
  'completeBootstrap',
  [
    'hashOpaqueToken(input.pairingToken)',
    'eq(devicePairings.pairingTokenHash, tokenHash)',
    'pairing.expiresAt.getTime() <= Date.now()',
    'deviceId !== pairing.deviceId',
    "status: 'completed'"
  ],
  'device bootstrap completion must validate a hashed pairing token and matching device ID'
);

requireContains(
  nudgesRoutes,
  "env.NODE_ENV === 'production'",
  'voice note upload URLs must ignore forwarded host headers in production'
);
requireContains(
  nudgesRoutes,
  "reply.header('cache-control', 'private, no-store')",
  'voice note file responses must be private and non-cacheable'
);
requireContains(
  nudgesRoutes,
  'token: z.string().min(10)',
  'public voice-note upload route must require an upload token in the query schema'
);
requireContains(
  nudgesRoutes,
  '.regex(/^audio\\/[a-z0-9.+-]+(?:;[a-z0-9=._+ -]+)*$/i)',
  'voice-note upload URLs must only accept audio MIME types'
);
requireContains(
  nudgesRoutes,
  'parsedQuery.data.token',
  'public voice-note upload route must pass the upload token to the service verifier'
);
requireContains(
  voiceNotesService,
  'tokenHash: hashUploadToken(token)',
  'voice note upload tokens must be stored hashed in pending upload state'
);
requireContains(
  voiceNotesService,
  'safeTokenHashEquals(token, pending.tokenHash)',
  'voice note upload token verification must compare against the stored token hash'
);
requireContains(
  voiceNotesService,
  'timingSafeEqual',
  'voice note upload token hashes must use timing-safe comparison'
);
requireNotContains(
  voiceNotesService,
  'pending.token !== token',
  'voice note upload token comparison must not use direct string inequality'
);
requireNotContains(
  voiceNotesService,
  'token: string;',
  'voice note pending upload state must not store raw upload tokens'
);
requireContains(
  backendIndex,
  'if (!origin) return callback(null, env.CORS_ALLOW_MISSING_ORIGIN)',
  'missing-Origin CORS behavior must be an explicit environment decision'
);
for (const workerPath of [reminderWorker, insightsWorker, digestWorker]) {
  requireContains(
    workerPath,
    'validateWorkerEnv();',
    'worker entrypoints must validate worker-scoped production env at startup'
  );
}
requireContains(
  rateLimit,
  'rateLimitKeyDigest(discriminator)',
  'rate limit bucket keys must hash discriminators before storing user-controlled values'
);
requireContains(
  rateLimit,
  'export const bodyFieldsKey',
  'rate limit helpers must support composite public-token discriminators'
);
requireContains(
  rateLimit,
  "createHash('sha256')",
  'rate limit bucket key hashing must use a cryptographic digest'
);

requireContains(
  gatewayAuth,
  'AUTH_TOKEN_SUBPROTOCOL_PREFIX = "mitr-token-"',
  'browser Pipecat gateway auth must support token transport outside the URL query'
);
requireNotContains(
  gatewayAuth,
  'query_params.get("accessToken"',
  'Pipecat gateway must not accept bearer tokens in WebSocket URL query strings'
);
requireContains(
  gatewayAuth,
  'select_websocket_subprotocol',
  'gateway must select a known audio WebSocket subprotocol when browser clients request one'
);
requireContains(
  webSimulator,
  'new WebSocket(wsUrl.toString(), ["mitr-pcm16", `mitr-token-${token}`])',
  'web simulator must send bearer token via WebSocket subprotocol, not URL query string'
);
requireNotContains(
  webSimulator,
  'searchParams.set("accessToken"',
  'web simulator must not put bearer access tokens in WebSocket URLs'
);

if (failures.length > 0) {
  console.error('[rbac-invariants] failed');
  for (const failure of failures) {
    console.error(`[rbac-invariants] ${failure}`);
  }
  process.exit(1);
}

console.log('[rbac-invariants] passed');
