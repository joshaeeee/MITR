#!/usr/bin/env node

import { randomBytes, randomUUID } from 'node:crypto';

if (!process.argv.includes('--execute')) {
  process.stdout.write(
    'Usage: INTERNAL_SERVICE_TOKEN=<token> node scripts/production-api-audit.mjs --execute\n'
  );
  process.exit(0);
}

const API_BASE = (process.env.API_BASE || 'https://api.heyreca.com').replace(/\/+$/, '');
const INTERNAL_API_BASE = (process.env.INTERNAL_API_BASE || API_BASE).replace(/\/+$/, '');
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN?.trim() || '';
const REQUEST_TIMEOUT_MS = Number(process.env.AUDIT_TIMEOUT_MS || 20_000);
const MAX_REQUESTS = Math.min(Number(process.env.AUDIT_MAX_REQUESTS || 250), 259);

const ROUTES = [
  'GET /livez',
  'POST /auth/otp/start',
  'POST /auth/otp/verify',
  'POST /auth/email/signup',
  'POST /auth/email/login',
  'POST /auth/oauth/apple',
  'POST /auth/oauth/google',
  'POST /auth/session/refresh',
  'POST /auth/logout',
  'GET /auth/me',
  'POST /auth/swiggy/start',
  'GET /auth/swiggy/status',
  'POST /auth/swiggy/logout',
  'GET /auth/swiggy/dev-authorize',
  'GET /auth/swiggy/callback',
  'GET /family/me',
  'GET /family/members',
  'POST /family/invite',
  'POST /family/invite/accept',
  'PATCH /family/members/:id/role',
  'DELETE /family/members/:id',
  'GET /elder/profile',
  'PATCH /elder/profile',
  'GET /elder/journey',
  'PATCH /elder/journey',
  'GET /elder/device/status',
  'POST /elder/device/link',
  'POST /elder/device/unlink',
  'POST /nudges/send',
  'POST /nudges/schedule',
  'GET /nudges/history',
  'POST /voice-notes/upload-url',
  'PUT /voice-notes/upload/:voiceNoteId',
  'GET /voice-notes/files/:fileName',
  'POST /voice-notes/send',
  'GET /insights/overview',
  'GET /insights/timeline',
  'GET /insights/topics',
  'GET /insights/concerns',
  'POST /insights/concerns/:id/review',
  'POST /insights/concerns/:id/resolve',
  'GET /insights/sessions',
  'GET /insights/explanations',
  'POST /insights/checkin',
  'GET /insights/pipeline/health',
  'GET /insights/digest/today',
  'GET /insights/daily',
  'GET /insights/daily/range',
  'GET /insights/recommendations/active',
  'POST /insights/recommendations/:id/feedback',
  'PATCH /insights/recommendations/:id/confirm-action',
  'GET /alerts',
  'GET /alerts/:id',
  'POST /alerts/:id/ack',
  'POST /alerts/:id/resolve',
  'GET /escalation/policy',
  'PATCH /escalation/policy',
  'GET /care/reminders',
  'GET /care/items',
  'POST /care/items',
  'PATCH /care/items/:id',
  'DELETE /care/items/:id',
  'POST /care/reminders',
  'PATCH /care/reminders/:id',
  'DELETE /care/reminders/:id',
  'GET /care/routines',
  'PATCH /care/routines/:id',
  'GET /device/status',
  'POST /device/link',
  'POST /device/unlink',
  'POST /devices/claim/start',
  'POST /devices/pairing/start',
  'GET /devices/pairing/:pairingId',
  'GET /devices/claimed',
  'POST /devices/claim/complete',
  'POST /devices/bootstrap/complete',
  'POST /devices/session/open',
  'POST /devices/token',
  'POST /devices/gateway/auth',
  'POST /devices/token/refresh',
  'POST /devices/heartbeat',
  'POST /devices/telemetry',
  'POST /devices/session/end',
  'POST /devices/revoke',
  'GET /agent/conversations',
  'GET /agent/memories',
  'GET /agent/tasks',
  'POST /internal/pipecat/tool',
  'GET /home/summary',
  'GET /notifications/preferences',
  'PATCH /notifications/preferences',
  'POST /notifications/push-token',
  'GET /internal/device-sessions/active',
  'GET /internal/device-sessions/:sessionId',
  'POST /internal/device-sessions/:sessionId/wake-detected',
  'POST /internal/device-sessions/:sessionId/agent-ready',
  'POST /internal/device-sessions/:sessionId/agent-error',
  'POST /internal/device-conversations/:conversationId/conversation-active',
  'POST /internal/device-conversations/:conversationId/user-activity',
  'POST /internal/device-conversations/:conversationId/conversation-ended',
  'POST /internal/device-conversations/:conversationId/conversation-error',
  'POST /session/start',
  'POST /session/end',
  'POST /session/events/pull',
  'GET /events/stream',
  'POST /pipecat/connect',
  'POST /pipecat/gateway/auth',
  'GET /onboarding/questions',
  'GET /onboarding/status',
  'POST /onboarding/submit',
  'GET /healthz',
  'GET /health/latency',
  'POST /long-session/start',
  'POST /long-session/next',
  'POST /long-session/stop',
  'GET /long-session/:id',
  'GET /long-session/:id/summary'
];

if (ROUTES.length !== 117 || new Set(ROUTES).size !== ROUTES.length) {
  throw new Error(`Route manifest must contain 117 unique routes; found ${ROUTES.length}`);
}

const startedAt = new Date();
const runId = `${Date.now()}-${randomBytes(4).toString('hex')}`;
const ownerEmail = `mitr.audit.${runId}@example.com`;
const inviteeEmail = `mitr.audit.invitee.${runId}@example.com`;
const password = `Z9!${randomBytes(18).toString('base64url')}`;
const deviceId = `mitr-audit-${runId}`;
const pairedDeviceId = `mitr-audit-paired-${runId}`;
const bootId = randomUUID().replaceAll('-', '');
const secondBootId = randomUUID().replaceAll('-', '');
const today = new Date().toISOString().slice(0, 10);
const attempts = [];
const routeResults = new Map();
const secrets = new Set([password, INTERNAL_SERVICE_TOKEN].filter(Boolean));
let requestCount = 0;

const state = {
  owner: {},
  invitee: {},
  webSessionId: '',
  longSessionId: '',
  careItemId: '',
  careReminderId: '',
  routineId: '',
  familyMemberId: '',
  claimCode: '',
  deviceToken: '',
  pairedDeviceToken: '',
  pairingId: '',
  pairingToken: '',
  deviceSessionId: '',
  conversationId: '',
  secondConversationId: ''
};

const tokenKeys = /(?:authorization|password|token|secret|claimcode|code)$/i;

const addSecret = (value) => {
  if (typeof value === 'string' && value.length >= 6) secrets.add(value);
  return value;
};

const redactString = (value) => {
  let redacted = value;
  for (const secret of secrets) {
    if (secret && redacted.includes(secret)) redacted = redacted.replaceAll(secret, '[REDACTED]');
  }
  return redacted.length > 800 ? `${redacted.slice(0, 800)}...[truncated]` : redacted;
};

const redact = (value, key = '') => {
  if (tokenKeys.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .map(([childKey, childValue]) => [childKey, redact(childValue, childKey)])
    );
  }
  return value;
};

const authHeaders = (accessToken) =>
  accessToken ? { authorization: `Bearer ${accessToken}` } : {};

const internalHeaders = () =>
  INTERNAL_SERVICE_TOKEN ? { 'x-internal-service-token': INTERNAL_SERVICE_TOKEN } : {};

const readBody = async (response) => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const audit = async ({
  route,
  path,
  method,
  expected = [200],
  mode = 'success',
  note,
  headers = {},
  body,
  contentType = 'application/json',
  recordRoute = true,
  baseUrl = API_BASE
}) => {
  if (!ROUTES.includes(route)) throw new Error(`Unknown route manifest entry: ${route}`);
  if (requestCount >= MAX_REQUESTS) throw new Error(`Request budget exhausted at ${requestCount}/${MAX_REQUESTS}`);
  requestCount += 1;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const before = performance.now();
  let result;

  try {
    const requestHeaders = {
      accept: 'application/json',
      'user-agent': 'mitr-production-api-audit/1.0',
      ...headers
    };
    const init = {
      method,
      headers: requestHeaders,
      redirect: 'manual',
      signal: controller.signal
    };
    if (body !== undefined) {
      requestHeaders['content-type'] = contentType;
      init.body = contentType === 'application/json' ? JSON.stringify(body) : body;
    }

    const response = await fetch(`${baseUrl}${path}`, init);
    const responseBody = await readBody(response);
    result = {
      route,
      requestPath: path,
      mode,
      status: expected.includes(response.status) ? 'pass' : 'fail',
      httpStatus: response.status,
      expectedStatuses: expected,
      durationMs: Math.round(performance.now() - before),
      note: note || null,
      response: redact(responseBody)
    };
    result.rawBody = responseBody;
  } catch (error) {
    result = {
      route,
      requestPath: path,
      mode,
      status: 'fail',
      httpStatus: null,
      expectedStatuses: expected,
      durationMs: Math.round(performance.now() - before),
      note: note || null,
      error: error instanceof Error ? error.message : String(error),
      rawBody: null
    };
  } finally {
    clearTimeout(timer);
  }

  attempts.push({ ...result, rawBody: undefined });
  if (recordRoute && !routeResults.has(route)) {
    routeResults.set(route, { ...result, rawBody: undefined });
  }
  return result;
};

const contract = (args) => audit({ ...args, mode: 'contract' });
const cleanup = (args) => audit({ ...args, mode: 'cleanup', recordRoute: false });
const bodyOf = (result) => (result?.rawBody && typeof result.rawBody === 'object' ? result.rawBody : {});
const accessTokenOf = (result) => addSecret(bodyOf(result)?.session?.accessToken || '');
const refreshTokenOf = (result) => addSecret(bodyOf(result)?.session?.refreshToken || '');
const randomMissingId = () => randomUUID();
const internalExpected = INTERNAL_SERVICE_TOKEN ? [200] : [401, 503];

const main = async () => {
  await audit({ route: 'GET /livez', path: '/livez', method: 'GET' });
  await audit({ route: 'GET /healthz', path: '/healthz', method: 'GET', expected: [200] });
  await audit({ route: 'GET /onboarding/questions', path: '/onboarding/questions', method: 'GET' });

  await contract({
    route: 'POST /auth/otp/start',
    path: '/auth/otp/start',
    method: 'POST',
    body: { phone: '' },
    expected: [400],
    note: 'Invalid body prevents OTP creation or delivery.'
  });
  await contract({
    route: 'POST /auth/otp/verify',
    path: '/auth/otp/verify',
    method: 'POST',
    body: { challengeId: 'audit-does-not-exist', code: '000000' },
    expected: [400],
    note: 'Nonexistent challenge; no OTP is sent.'
  });

  const signup = await audit({
    route: 'POST /auth/email/signup',
    path: '/auth/email/signup',
    method: 'POST',
    body: { email: ownerEmail, password, name: `Production Audit ${runId}` }
  });
  state.owner.userId = bodyOf(signup)?.user?.id || '';
  state.owner.signupAccessToken = accessTokenOf(signup);
  state.owner.signupRefreshToken = refreshTokenOf(signup);

  const login = await audit({
    route: 'POST /auth/email/login',
    path: '/auth/email/login',
    method: 'POST',
    body: { email: ownerEmail, password }
  });
  state.owner.loginAccessToken = accessTokenOf(login);

  await contract({
    route: 'POST /auth/oauth/apple',
    path: '/auth/oauth/apple',
    method: 'POST',
    body: { token: 'not-a-real-apple-id-token-audit' },
    expected: [401],
    note: 'Synthetic invalid token; no real OAuth login.'
  });
  await contract({
    route: 'POST /auth/oauth/google',
    path: '/auth/oauth/google',
    method: 'POST',
    body: { token: 'not-a-real-google-id-token-audit' },
    expected: [401],
    note: 'Synthetic invalid token; no real OAuth login.'
  });

  const refreshed = state.owner.signupRefreshToken
    ? await audit({
        route: 'POST /auth/session/refresh',
        path: '/auth/session/refresh',
        method: 'POST',
        body: { refreshToken: state.owner.signupRefreshToken }
      })
    : await contract({
        route: 'POST /auth/session/refresh',
        path: '/auth/session/refresh',
        method: 'POST',
        body: { refreshToken: 'x'.repeat(32) },
        expected: [401],
        note: 'Signup dependency failed; exercised invalid refresh contract.'
      });
  state.owner.accessToken = accessTokenOf(refreshed) || state.owner.loginAccessToken;
  state.owner.refreshToken = refreshTokenOf(refreshed);
  const ownerAuth = () => authHeaders(state.owner.accessToken);

  await audit({ route: 'GET /auth/me', path: '/auth/me', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await contract({
    route: 'POST /auth/swiggy/start',
    path: '/auth/swiggy/start',
    method: 'POST',
    expected: [401],
    note: 'Missing auth deliberately prevents starting a real provider OAuth flow.'
  });
  await audit({
    route: 'GET /auth/swiggy/status',
    path: '/auth/swiggy/status',
    method: 'GET',
    headers: ownerAuth(),
    expected: state.owner.accessToken ? [200] : [401]
  });
  await audit({
    route: 'POST /auth/swiggy/logout',
    path: '/auth/swiggy/logout',
    method: 'POST',
    headers: ownerAuth(),
    expected: state.owner.accessToken ? [200] : [401]
  });
  await contract({
    route: 'GET /auth/swiggy/dev-authorize',
    path: '/auth/swiggy/dev-authorize',
    method: 'GET',
    expected: [400],
    note: 'Missing state prevents authorization.'
  });
  await contract({
    route: 'GET /auth/swiggy/callback',
    path: '/auth/swiggy/callback',
    method: 'GET',
    expected: [400, 302, 303, 307, 308],
    note: 'Missing code and state; redirects are not followed.'
  });

  await audit({ route: 'GET /family/me', path: '/family/me', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await audit({ route: 'GET /family/members', path: '/family/members', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  const invite = await audit({
    route: 'POST /family/invite',
    path: '/family/invite',
    method: 'POST',
    headers: ownerAuth(),
    body: { displayName: `Audit Invitee ${runId}`, email: inviteeEmail, role: 'member' },
    expected: state.owner.accessToken ? [200] : [401]
  });
  state.familyMemberId = bodyOf(invite)?.id || '';

  const inviteeSignup = await cleanup({
    route: 'POST /auth/email/signup',
    path: '/auth/email/signup',
    method: 'POST',
    body: { email: inviteeEmail, password, name: `Audit Invitee ${runId}` },
    expected: [200],
    note: 'Auxiliary isolated user for invite acceptance and member cleanup.'
  });
  state.invitee.accessToken = accessTokenOf(inviteeSignup);
  const accept = await audit({
    route: 'POST /family/invite/accept',
    path: '/family/invite/accept',
    method: 'POST',
    headers: authHeaders(state.invitee.accessToken),
    expected: state.invitee.accessToken ? [200] : [401]
  });
  state.familyMemberId = bodyOf(accept)?.id || state.familyMemberId;
  await audit({
    route: 'PATCH /family/members/:id/role',
    path: `/family/members/${state.familyMemberId || randomMissingId()}/role`,
    method: 'PATCH',
    headers: ownerAuth(),
    body: { role: 'member' },
    expected: state.familyMemberId ? [200] : state.owner.accessToken ? [404] : [401],
    mode: state.familyMemberId ? 'success' : 'contract',
    note: state.familyMemberId ? null : 'No accepted member was available; nonexistent member contract.'
  });
  await audit({
    route: 'DELETE /family/members/:id',
    path: `/family/members/${state.familyMemberId || randomMissingId()}`,
    method: 'DELETE',
    headers: ownerAuth(),
    expected: state.familyMemberId ? [200] : state.owner.accessToken ? [404] : [401],
    mode: state.familyMemberId ? 'cleanup' : 'contract',
    note: state.familyMemberId ? 'Removes the auxiliary invited member.' : 'No accepted member was available.'
  });

  await audit({ route: 'GET /elder/profile', path: '/elder/profile', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await audit({
    route: 'PATCH /elder/profile',
    path: '/elder/profile',
    method: 'PATCH',
    headers: ownerAuth(),
    body: { name: `Audit Elder ${runId}`, ageRange: '70-79', language: 'hi-IN', city: 'Dehradun', timezone: 'Asia/Kolkata' },
    expected: state.owner.accessToken ? [200] : [401]
  });
  await audit({ route: 'GET /elder/journey', path: '/elder/journey', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await audit({
    route: 'PATCH /elder/journey',
    path: '/elder/journey',
    method: 'PATCH',
    headers: ownerAuth(),
    body: { communicationStyle: 'warm', proactiveLevel: 'low', privacyLevel: 'minimal', onboardingUseCases: ['production-api-audit'] },
    expected: state.owner.accessToken ? [200] : [401, 404]
  });
  await audit({ route: 'GET /elder/device/status', path: '/elder/device/status', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await audit({
    route: 'POST /elder/device/link',
    path: '/elder/device/link',
    method: 'POST',
    headers: ownerAuth(),
    body: { serialNumber: `ELDER-${runId}`, firmwareVersion: 'audit' },
    expected: state.owner.accessToken ? [200] : [401]
  });
  await audit({
    route: 'POST /elder/device/unlink',
    path: '/elder/device/unlink',
    method: 'POST',
    headers: ownerAuth(),
    expected: state.owner.accessToken ? [200] : [401]
  });

  await audit({
    route: 'GET /onboarding/status',
    path: '/onboarding/status',
    method: 'GET',
    headers: ownerAuth(),
    expected: state.owner.accessToken ? [200] : [401]
  });
  await audit({
    route: 'POST /onboarding/submit',
    path: '/onboarding/submit',
    method: 'POST',
    headers: ownerAuth(),
    body: {
      answers: {
        elderName: `Audit Elder ${runId}`,
        elderAgeRange: '70-79',
        elderLanguage: 'hi-IN',
        elderCity: 'Dehradun',
        preferredAddress: 'Ji',
        proactiveLevel: 'low',
        firstUseCases: 'production-api-audit',
        boundaries: 'external outreach'
      }
    },
    expected: state.owner.accessToken ? [200] : [401]
  });

  await contract({
    route: 'POST /nudges/send',
    path: '/nudges/send',
    method: 'POST',
    headers: ownerAuth(),
    body: {},
    expected: state.owner.accessToken ? [400] : [401],
    note: 'Empty nudge prevents external delivery.'
  });
  await contract({
    route: 'POST /nudges/schedule',
    path: '/nudges/schedule',
    method: 'POST',
    headers: ownerAuth(),
    body: { scheduledFor: new Date(Date.now() + 86_400_000).toISOString() },
    expected: state.owner.accessToken ? [400] : [401],
    note: 'No message content prevents enqueueing a future nudge.'
  });
  await audit({ route: 'GET /nudges/history', path: '/nudges/history', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await contract({
    route: 'POST /voice-notes/upload-url',
    path: '/voice-notes/upload-url',
    method: 'POST',
    headers: ownerAuth(),
    body: { mimeType: 'text/plain' },
    expected: state.owner.accessToken ? [400] : [401],
    note: 'Invalid MIME type prevents upload allocation.'
  });
  await contract({
    route: 'PUT /voice-notes/upload/:voiceNoteId',
    path: `/voice-notes/upload/not-a-uuid?token=${'x'.repeat(12)}`,
    method: 'PUT',
    body: Buffer.from('audit'),
    contentType: 'audio/aac',
    expected: [400],
    note: 'Invalid UUID prevents storing audio.'
  });
  await contract({
    route: 'GET /voice-notes/files/:fileName',
    path: '/voice-notes/files/audit-missing.aac',
    method: 'GET',
    headers: ownerAuth(),
    expected: state.owner.accessToken ? [404] : [401],
    note: 'Synthetic nonexistent file.'
  });
  await contract({
    route: 'POST /voice-notes/send',
    path: '/voice-notes/send',
    method: 'POST',
    headers: ownerAuth(),
    body: { fileUrl: 'not-a-url' },
    expected: state.owner.accessToken ? [400] : [401],
    note: 'Invalid URL prevents voice-note delivery.'
  });

  await audit({ route: 'GET /insights/overview', path: '/insights/overview', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await audit({ route: 'GET /insights/timeline', path: '/insights/timeline?range=7d', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await audit({ route: 'GET /insights/topics', path: '/insights/topics?range=7d', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await audit({ route: 'GET /insights/concerns', path: '/insights/concerns?status=open', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await contract({
    route: 'POST /insights/concerns/:id/review',
    path: `/insights/concerns/${randomMissingId()}/review`,
    method: 'POST',
    headers: ownerAuth(),
    expected: state.owner.accessToken ? [404] : [401],
    note: 'No production concern is mutated.'
  });
  await contract({
    route: 'POST /insights/concerns/:id/resolve',
    path: `/insights/concerns/${randomMissingId()}/resolve`,
    method: 'POST',
    headers: ownerAuth(),
    expected: state.owner.accessToken ? [404] : [401],
    note: 'No production concern is mutated.'
  });
  await audit({ route: 'GET /insights/sessions', path: '/insights/sessions', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await audit({ route: 'GET /insights/explanations', path: `/insights/explanations?signalId=${randomMissingId()}`, method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await audit({
    route: 'POST /insights/checkin',
    path: '/insights/checkin',
    method: 'POST',
    headers: ownerAuth(),
    body: { period: 'day', matched: true, concernLevel: 'none', notes: 'isolated production API audit' },
    expected: state.owner.accessToken ? [200] : [401]
  });
  await audit({ route: 'GET /insights/pipeline/health', path: '/insights/pipeline/health', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await audit({ route: 'GET /insights/digest/today', path: '/insights/digest/today', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await audit({ route: 'GET /insights/daily', path: `/insights/daily?date=${today}`, method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await audit({ route: 'GET /insights/daily/range', path: `/insights/daily/range?from=${today}&to=${today}`, method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await audit({ route: 'GET /insights/recommendations/active', path: '/insights/recommendations/active', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await contract({
    route: 'POST /insights/recommendations/:id/feedback',
    path: `/insights/recommendations/${randomMissingId()}/feedback`,
    method: 'POST',
    headers: ownerAuth(),
    body: {},
    expected: state.owner.accessToken ? [400] : [401],
    note: 'Invalid body prevents feedback creation.'
  });
  await contract({
    route: 'PATCH /insights/recommendations/:id/confirm-action',
    path: `/insights/recommendations/${randomMissingId()}/confirm-action`,
    method: 'PATCH',
    headers: ownerAuth(),
    body: {},
    expected: state.owner.accessToken ? [400] : [401],
    note: 'Invalid body prevents recommendation mutation.'
  });

  await audit({ route: 'GET /alerts', path: '/alerts', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await contract({ route: 'GET /alerts/:id', path: `/alerts/${randomMissingId()}`, method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [404] : [401], note: 'Synthetic nonexistent alert.' });
  await contract({ route: 'POST /alerts/:id/ack', path: `/alerts/${randomMissingId()}/ack`, method: 'POST', headers: ownerAuth(), expected: state.owner.accessToken ? [404] : [401], note: 'Synthetic nonexistent alert.' });
  await contract({ route: 'POST /alerts/:id/resolve', path: `/alerts/${randomMissingId()}/resolve`, method: 'POST', headers: ownerAuth(), expected: state.owner.accessToken ? [404] : [401], note: 'Synthetic nonexistent alert.' });
  await audit({ route: 'GET /escalation/policy', path: '/escalation/policy', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await audit({
    route: 'PATCH /escalation/policy',
    path: '/escalation/policy',
    method: 'PATCH',
    headers: ownerAuth(),
    body: { quietHoursStart: '22:00', quietHoursEnd: '07:00', stage1NudgeDelayMin: 30, enabledTriggers: [] },
    expected: state.owner.accessToken ? [200] : [401]
  });

  await audit({ route: 'GET /care/reminders', path: '/care/reminders', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await audit({ route: 'GET /care/items', path: '/care/items', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  const careItem = await audit({
    route: 'POST /care/items',
    path: '/care/items',
    method: 'POST',
    headers: ownerAuth(),
    body: { section: 'one_off_plans', type: 'plan', title: `Audit item ${runId}`, enabled: false, metadata: { source: 'production-api-audit' } },
    expected: state.owner.accessToken ? [200] : [401]
  });
  state.careItemId = bodyOf(careItem)?.id || '';
  await audit({
    route: 'PATCH /care/items/:id',
    path: `/care/items/${state.careItemId || randomMissingId()}`,
    method: 'PATCH',
    headers: ownerAuth(),
    body: { title: `Audit item updated ${runId}` },
    expected: state.careItemId ? [200] : state.owner.accessToken ? [404] : [401],
    mode: state.careItemId ? 'success' : 'contract'
  });
  await audit({
    route: 'DELETE /care/items/:id',
    path: `/care/items/${state.careItemId || randomMissingId()}`,
    method: 'DELETE',
    headers: ownerAuth(),
    expected: state.careItemId ? [200] : state.owner.accessToken ? [200, 404] : [401],
    mode: state.careItemId ? 'cleanup' : 'contract'
  });
  const careReminder = await audit({
    route: 'POST /care/reminders',
    path: '/care/reminders',
    method: 'POST',
    headers: ownerAuth(),
    body: { title: `Audit reminder ${runId}`, description: 'isolated API audit', scheduledTime: '23:59', enabled: false },
    expected: state.owner.accessToken ? [200] : [401]
  });
  state.careReminderId = bodyOf(careReminder)?.id || '';
  await audit({
    route: 'PATCH /care/reminders/:id',
    path: `/care/reminders/${state.careReminderId || randomMissingId()}`,
    method: 'PATCH',
    headers: ownerAuth(),
    body: { title: `Audit reminder updated ${runId}`, enabled: false },
    expected: state.careReminderId ? [200] : state.owner.accessToken ? [404] : [401],
    mode: state.careReminderId ? 'success' : 'contract'
  });
  await audit({
    route: 'DELETE /care/reminders/:id',
    path: `/care/reminders/${state.careReminderId || randomMissingId()}`,
    method: 'DELETE',
    headers: ownerAuth(),
    expected: state.careReminderId ? [200] : state.owner.accessToken ? [200, 404] : [401],
    mode: state.careReminderId ? 'cleanup' : 'contract'
  });
  const routines = await audit({ route: 'GET /care/routines', path: '/care/routines', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  state.routineId = bodyOf(routines)?.items?.[0]?.id || '';
  await audit({
    route: 'PATCH /care/routines/:id',
    path: `/care/routines/${state.routineId || randomMissingId()}`,
    method: 'PATCH',
    headers: ownerAuth(),
    body: { enabled: false },
    expected: state.routineId ? [200] : state.owner.accessToken ? [404] : [401],
    mode: state.routineId ? 'success' : 'contract',
    note: state.routineId ? 'Disables an isolated user routine.' : 'No routine was available.'
  });

  await audit({ route: 'GET /device/status', path: '/device/status', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await audit({
    route: 'POST /device/link',
    path: '/device/link',
    method: 'POST',
    headers: ownerAuth(),
    body: { serialNumber: `LEGACY-${runId}`, firmwareVersion: 'audit' },
    expected: state.owner.accessToken ? [200] : [401]
  });
  await audit({ route: 'POST /device/unlink', path: '/device/unlink', method: 'POST', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });

  const claim = await audit({ route: 'POST /devices/claim/start', path: '/devices/claim/start', method: 'POST', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  state.claimCode = addSecret(bodyOf(claim)?.claimCode || '');
  const claimComplete = await audit({
    route: 'POST /devices/claim/complete',
    path: '/devices/claim/complete',
    method: 'POST',
    body: { claimCode: state.claimCode || '000000', deviceId, displayName: `Audit device ${runId}`, hardwareRev: 'audit', firmwareVersion: 'audit', metadata: { source: 'production-api-audit' } },
    expected: state.claimCode ? [200] : [400],
    mode: state.claimCode ? 'success' : 'contract'
  });
  state.deviceToken = addSecret(bodyOf(claimComplete)?.deviceAccessToken || '');

  const pairing = await audit({
    route: 'POST /devices/pairing/start',
    path: '/devices/pairing/start',
    method: 'POST',
    headers: ownerAuth(),
    body: { deviceId: pairedDeviceId, displayName: `Audit paired device ${runId}`, metadata: { source: 'production-api-audit' } },
    expected: state.owner.accessToken ? [200] : [401]
  });
  state.pairingId = bodyOf(pairing)?.id || bodyOf(pairing)?.pairingId || '';
  state.pairingToken = addSecret(bodyOf(pairing)?.pairingToken || '');
  await audit({
    route: 'GET /devices/pairing/:pairingId',
    path: `/devices/pairing/${state.pairingId || randomMissingId()}`,
    method: 'GET',
    headers: ownerAuth(),
    expected: state.pairingId ? [200] : state.owner.accessToken ? [404] : [401],
    mode: state.pairingId ? 'success' : 'contract'
  });
  const bootstrap = await audit({
    route: 'POST /devices/bootstrap/complete',
    path: '/devices/bootstrap/complete',
    method: 'POST',
    body: { pairingToken: state.pairingToken || 'x'.repeat(32), deviceId: pairedDeviceId, displayName: `Audit paired device ${runId}`, hardwareRev: 'audit', firmwareVersion: 'audit', metadata: { source: 'production-api-audit' } },
    expected: state.pairingToken ? [200] : [400],
    mode: state.pairingToken ? 'success' : 'contract'
  });
  state.pairedDeviceToken = addSecret(bodyOf(bootstrap)?.deviceAccessToken || '');
  await audit({ route: 'GET /devices/claimed', path: '/devices/claimed', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });

  const deviceAuth = () => authHeaders(state.deviceToken);
  const opened = await audit({
    route: 'POST /devices/session/open',
    path: '/devices/session/open',
    method: 'POST',
    headers: deviceAuth(),
    body: { bootId, language: 'hi-IN', firmwareVersion: 'audit', hardwareRev: 'audit', metadata: { source: 'production-api-audit' } },
    expected: state.deviceToken ? [200] : [401]
  });
  state.deviceSessionId = bodyOf(opened)?.sessionId || '';
  const minted = await audit({
    route: 'POST /devices/token',
    path: '/devices/token',
    method: 'POST',
    headers: deviceAuth(),
    body: { bootId, language: 'hi-IN', firmwareVersion: 'audit' },
    expected: state.deviceToken ? [200] : [401]
  });
  state.deviceSessionId = bodyOf(minted)?.sessionId || state.deviceSessionId;
  await audit({
    route: 'POST /devices/gateway/auth',
    path: '/devices/gateway/auth',
    method: 'POST',
    headers: deviceAuth(),
    body: { deviceId, language: 'hi-IN', transport: 'production-api-audit' },
    expected: state.deviceToken ? [200] : [401]
  });
  await audit({
    route: 'POST /devices/token/refresh',
    path: '/devices/token/refresh',
    method: 'POST',
    headers: deviceAuth(),
    body: { sessionId: state.deviceSessionId || randomMissingId(), bootId },
    expected: state.deviceToken && state.deviceSessionId ? [200] : state.deviceToken ? [409, 500] : [401],
    mode: state.deviceSessionId ? 'success' : 'contract'
  });
  await audit({
    route: 'POST /devices/heartbeat',
    path: '/devices/heartbeat',
    method: 'POST',
    headers: deviceAuth(),
    body: { sessionId: state.deviceSessionId || undefined, bootId, firmwareVersion: 'audit', wifiRssiDbm: -55, batteryPct: 95, networkType: 'audit', metadata: { source: 'production-api-audit' } },
    expected: state.deviceToken ? [200] : [401]
  });
  await audit({
    route: 'POST /devices/telemetry',
    path: '/devices/telemetry',
    method: 'POST',
    headers: deviceAuth(),
    body: { sessionId: state.deviceSessionId || undefined, bootId, eventType: 'production_api_audit', level: 'info', payload: { isolated: true } },
    expected: state.deviceToken ? [200] : [401]
  });

  await audit({
    route: 'GET /internal/device-sessions/active',
    path: '/internal/device-sessions/active',
    method: 'GET',
    baseUrl: INTERNAL_API_BASE,
    headers: internalHeaders(),
    expected: internalExpected,
    mode: INTERNAL_SERVICE_TOKEN ? 'success' : 'contract',
    note: INTERNAL_SERVICE_TOKEN ? null : 'INTERNAL_SERVICE_TOKEN not set; authentication contract only.'
  });
  await audit({
    route: 'GET /internal/device-sessions/:sessionId',
    path: `/internal/device-sessions/${state.deviceSessionId || randomMissingId()}`,
    method: 'GET',
    baseUrl: INTERNAL_API_BASE,
    headers: internalHeaders(),
    expected: INTERNAL_SERVICE_TOKEN ? state.deviceSessionId ? [200] : [404] : [401, 503],
    mode: INTERNAL_SERVICE_TOKEN && state.deviceSessionId ? 'success' : 'contract'
  });
  const wake = await audit({
    route: 'POST /internal/device-sessions/:sessionId/wake-detected',
    path: `/internal/device-sessions/${state.deviceSessionId || randomMissingId()}/wake-detected`,
    method: 'POST',
    baseUrl: INTERNAL_API_BASE,
    headers: state.deviceToken ? deviceAuth() : internalHeaders(),
    body: { bootId, wakeId: `audit-${runId}-1`, modelName: 'audit-model', phrase: 'mitr', score: 0.99, detectedAtMs: Date.now() },
    expected: state.deviceToken && state.deviceSessionId ? [200] : INTERNAL_SERVICE_TOKEN ? [200, 404] : [401, 503],
    mode: state.deviceToken && state.deviceSessionId ? 'success' : 'contract'
  });
  state.conversationId = bodyOf(wake)?.conversationId || '';

  await audit({
    route: 'POST /internal/device-sessions/:sessionId/agent-ready',
    path: `/internal/device-sessions/${state.deviceSessionId || randomMissingId()}/agent-ready`,
    method: 'POST',
    baseUrl: INTERNAL_API_BASE,
    headers: internalHeaders(),
    body: { bootId, agentJobId: `audit-${runId}`, participantIdentity: `audit-${runId}`, readyAtMs: Date.now() },
    expected: INTERNAL_SERVICE_TOKEN ? state.deviceSessionId ? [200] : [404] : [401, 503],
    mode: INTERNAL_SERVICE_TOKEN && state.deviceSessionId ? 'success' : 'contract'
  });
  await audit({
    route: 'POST /internal/device-conversations/:conversationId/conversation-active',
    path: `/internal/device-conversations/${state.conversationId || randomMissingId()}/conversation-active`,
    method: 'POST',
    baseUrl: INTERNAL_API_BASE,
    headers: internalHeaders(),
    expected: INTERNAL_SERVICE_TOKEN ? state.conversationId ? [200] : [404] : [401, 503],
    mode: INTERNAL_SERVICE_TOKEN && state.conversationId ? 'success' : 'contract'
  });
  await audit({
    route: 'POST /internal/device-conversations/:conversationId/user-activity',
    path: `/internal/device-conversations/${state.conversationId || randomMissingId()}/user-activity`,
    method: 'POST',
    baseUrl: INTERNAL_API_BASE,
    headers: internalHeaders(),
    body: { activityAtMs: Date.now() },
    expected: INTERNAL_SERVICE_TOKEN ? state.conversationId ? [200] : [404] : [401, 503],
    mode: INTERNAL_SERVICE_TOKEN && state.conversationId ? 'success' : 'contract'
  });
  await audit({
    route: 'POST /internal/device-conversations/:conversationId/conversation-ended',
    path: `/internal/device-conversations/${state.conversationId || randomMissingId()}/conversation-ended`,
    method: 'POST',
    baseUrl: INTERNAL_API_BASE,
    headers: internalHeaders(),
    body: { reason: 'production_api_audit_complete' },
    expected: INTERNAL_SERVICE_TOKEN ? state.conversationId ? [200] : [404] : [401, 503],
    mode: INTERNAL_SERVICE_TOKEN && state.conversationId ? 'success' : 'contract'
  });

  if (INTERNAL_SERVICE_TOKEN && state.deviceToken && state.deviceSessionId && state.conversationId) {
    const secondWake = await cleanup({
      route: 'POST /internal/device-sessions/:sessionId/wake-detected',
      path: `/internal/device-sessions/${state.deviceSessionId}/wake-detected`,
      method: 'POST',
      baseUrl: INTERNAL_API_BASE,
      headers: deviceAuth(),
      body: { bootId, wakeId: `audit-${runId}-2`, modelName: 'audit-model', phrase: 'mitr', score: 0.98, detectedAtMs: Date.now() },
      expected: [200],
      note: 'Creates an isolated second conversation so the error endpoint can be success-tested.'
    });
    state.secondConversationId = bodyOf(secondWake)?.conversationId || '';
  }
  await audit({
    route: 'POST /internal/device-conversations/:conversationId/conversation-error',
    path: `/internal/device-conversations/${state.secondConversationId || randomMissingId()}/conversation-error`,
    method: 'POST',
    baseUrl: INTERNAL_API_BASE,
    headers: internalHeaders(),
    body: { reason: 'production_api_audit_synthetic_error' },
    expected: INTERNAL_SERVICE_TOKEN ? state.secondConversationId ? [200] : [404] : [401, 503],
    mode: INTERNAL_SERVICE_TOKEN && state.secondConversationId ? 'success' : 'contract',
    note: state.secondConversationId ? 'Synthetic error on isolated audit conversation.' : 'No internal token or second conversation; nonexistent resource contract.'
  });
  await audit({
    route: 'POST /internal/device-sessions/:sessionId/agent-error',
    path: `/internal/device-sessions/${state.deviceSessionId || randomMissingId()}/agent-error`,
    method: 'POST',
    baseUrl: INTERNAL_API_BASE,
    headers: internalHeaders(),
    body: { bootId, reason: 'production_api_audit_synthetic_error' },
    expected: INTERNAL_SERVICE_TOKEN ? state.deviceSessionId ? [200] : [404] : [401, 503],
    mode: INTERNAL_SERVICE_TOKEN && state.deviceSessionId ? 'success' : 'contract',
    note: 'Synthetic terminal state on the isolated audit device session.'
  });

  await audit({ route: 'GET /agent/conversations', path: '/agent/conversations?limit=5', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await contract({
    route: 'GET /agent/memories',
    path: '/agent/memories',
    method: 'GET',
    headers: ownerAuth(),
    expected: state.owner.accessToken ? [400] : [401],
    note: 'Missing query prevents paid/external memory search.'
  });
  await audit({ route: 'GET /agent/tasks', path: '/agent/tasks?status=all', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await contract({
    route: 'POST /internal/pipecat/tool',
    path: '/internal/pipecat/tool',
    method: 'POST',
    baseUrl: INTERNAL_API_BASE,
    headers: internalHeaders(),
    body: {
      name: 'production_api_audit_unknown_tool',
      arguments: {},
      context: {
        userId: state.owner.userId || 'audit-missing-user',
        deviceId: state.deviceToken ? deviceId : undefined,
        sessionId: state.deviceSessionId || undefined,
        language: 'hi-IN'
      }
    },
    expected: INTERNAL_SERVICE_TOKEN ? state.owner.userId && state.deviceSessionId ? [404] : [403] : [401, 503],
    note: 'Unknown tool contract prevents paid agent-tool execution.'
  });
  await audit({ route: 'GET /home/summary', path: '/home/summary', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });

  await audit({ route: 'GET /notifications/preferences', path: '/notifications/preferences', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await audit({
    route: 'PATCH /notifications/preferences',
    path: '/notifications/preferences',
    method: 'PATCH',
    headers: ownerAuth(),
    body: { digestEnabled: false, realtimeEnabled: false, timezone: 'Asia/Kolkata', digestHourLocal: 9, digestMinuteLocal: 0 },
    expected: state.owner.accessToken ? [200] : [401]
  });
  await contract({
    route: 'POST /notifications/push-token',
    path: '/notifications/push-token',
    method: 'POST',
    headers: ownerAuth(),
    body: { expoPushToken: '', platform: 'unknown' },
    expected: state.owner.accessToken ? [400] : [401],
    note: 'Empty token prevents registering a delivery target.'
  });

  const webSession = await audit({
    route: 'POST /session/start',
    path: '/session/start',
    method: 'POST',
    headers: ownerAuth(),
    body: {},
    expected: state.owner.accessToken ? [200] : [401]
  });
  state.webSessionId = bodyOf(webSession)?.sessionId || '';
  await audit({
    route: 'POST /session/events/pull',
    path: '/session/events/pull',
    method: 'POST',
    headers: ownerAuth(),
    body: { limit: 5 },
    expected: state.owner.accessToken ? [200] : [401]
  });
  await audit({ route: 'GET /events/stream', path: '/events/stream?limit=5', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });
  await audit({
    route: 'POST /pipecat/connect',
    path: '/pipecat/connect',
    method: 'POST',
    headers: ownerAuth(),
    body: { language: 'hi-IN', participantName: `audit-${runId}`, metadata: { source: 'production-api-audit' } },
    expected: state.owner.accessToken ? [200] : [401]
  });
  await audit({
    route: 'POST /pipecat/gateway/auth',
    path: '/pipecat/gateway/auth',
    method: 'POST',
    headers: ownerAuth(),
    body: { language: 'hi-IN', transport: 'production-api-audit' },
    expected: state.owner.accessToken ? [200] : [401]
  });
  await audit({ route: 'GET /health/latency', path: '/health/latency', method: 'GET', headers: ownerAuth(), expected: state.owner.accessToken ? [200] : [401] });

  const longSession = await audit({
    route: 'POST /long-session/start',
    path: '/long-session/start',
    method: 'POST',
    headers: ownerAuth(),
    body: { mode: 'companion_long', targetDurationSec: 300, topic: 'production API audit', language: 'hi-IN', resumeIfRunning: false, paceMode: 'interactive' },
    expected: state.owner.accessToken ? [200] : [401]
  });
  state.longSessionId =
    bodyOf(longSession)?.session?.longSessionId ||
    bodyOf(longSession)?.id ||
    bodyOf(longSession)?.longSessionId ||
    '';
  await audit({
    route: 'POST /long-session/next',
    path: '/long-session/next',
    method: 'POST',
    headers: ownerAuth(),
    body: { longSessionId: state.longSessionId || 'audit-missing' },
    expected: state.longSessionId ? [200] : state.owner.accessToken ? [404] : [401],
    mode: state.longSessionId ? 'success' : 'contract'
  });
  await audit({
    route: 'GET /long-session/:id',
    path: `/long-session/${state.longSessionId || 'audit-missing'}`,
    method: 'GET',
    headers: ownerAuth(),
    expected: state.longSessionId ? [200] : state.owner.accessToken ? [404] : [401],
    mode: state.longSessionId ? 'success' : 'contract'
  });
  await audit({
    route: 'GET /long-session/:id/summary',
    path: `/long-session/${state.longSessionId || 'audit-missing'}/summary`,
    method: 'GET',
    headers: ownerAuth(),
    expected: state.longSessionId ? [200] : state.owner.accessToken ? [404] : [401],
    mode: state.longSessionId ? 'success' : 'contract'
  });
  await audit({
    route: 'POST /long-session/stop',
    path: '/long-session/stop',
    method: 'POST',
    headers: ownerAuth(),
    body: { longSessionId: state.longSessionId || 'audit-missing', reason: 'production_api_audit_complete' },
    expected: state.longSessionId ? [200] : state.owner.accessToken ? [404] : [401],
    mode: state.longSessionId ? 'cleanup' : 'contract'
  });
  await audit({
    route: 'POST /session/end',
    path: '/session/end',
    method: 'POST',
    headers: ownerAuth(),
    body: { sessionId: state.webSessionId || 'audit-missing' },
    expected: state.webSessionId ? [200] : state.owner.accessToken ? [404] : [401],
    mode: state.webSessionId ? 'cleanup' : 'contract'
  });

  await audit({
    route: 'POST /devices/session/end',
    path: '/devices/session/end',
    method: 'POST',
    headers: deviceAuth(),
    body: { sessionId: state.deviceSessionId || randomMissingId(), bootId, reason: 'production_api_audit_complete' },
    expected: state.deviceToken && state.deviceSessionId ? [200] : state.deviceToken ? [500] : [401],
    mode: state.deviceSessionId ? 'cleanup' : 'contract'
  });
  await audit({
    route: 'POST /devices/revoke',
    path: '/devices/revoke',
    method: 'POST',
    headers: ownerAuth(),
    body: { deviceId },
    expected: state.deviceToken ? [200] : state.owner.accessToken ? [404] : [401],
    mode: state.deviceToken ? 'cleanup' : 'contract'
  });
  if (state.pairedDeviceToken) {
    await cleanup({
      route: 'POST /devices/revoke',
      path: '/devices/revoke',
      method: 'POST',
      headers: ownerAuth(),
      body: { deviceId: pairedDeviceId },
      expected: [200],
      note: 'Revokes the second isolated pairing-flow device.'
    });
  }

  await audit({
    route: 'POST /auth/logout',
    path: '/auth/logout',
    method: 'POST',
    headers: ownerAuth(),
    expected: state.owner.accessToken ? [200] : [401],
    mode: state.owner.accessToken ? 'cleanup' : 'contract'
  });
  for (const token of [state.owner.loginAccessToken, state.invitee.accessToken]) {
    if (!token || token === state.owner.accessToken) continue;
    await cleanup({
      route: 'POST /auth/logout',
      path: '/auth/logout',
      method: 'POST',
      headers: authHeaders(token),
      expected: [200],
      note: 'Revokes an auxiliary audit auth session.'
    });
  }

  const routes = ROUTES.map((route) =>
    routeResults.get(route) || {
      route,
      status: 'skip',
      mode: 'not-run',
      note: 'Route was not reached before the audit stopped.'
    }
  );
  const counts = routes.reduce(
    (summary, result) => {
      summary[result.status] += 1;
      return summary;
    },
    { pass: 0, fail: 0, skip: 0 }
  );
  const contractTested = routes.filter((result) => result.mode === 'contract').map((result) => result.route);
  const output = {
    audit: 'mitr-production-api',
    apiBase: API_BASE,
    internalApiBase: INTERNAL_API_BASE,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    requestCount,
    requestBudget: MAX_REQUESTS,
    routeCount: ROUTES.length,
    coveredRouteCount: routes.filter((result) => result.status !== 'skip').length,
    counts,
    passed: counts.fail === 0 && counts.skip === 0,
    internalServiceTokenProvided: Boolean(INTERNAL_SERVICE_TOKEN),
    isolatedResources: {
      ownerEmail,
      inviteeEmail,
      deviceIds: [deviceId, pairedDeviceId],
      userDeletionAvailable: false
    },
    contractTested,
    routes,
    cleanupAttempts: attempts.filter((attempt) => attempt.mode === 'cleanup'),
    attempts
  };

  process.stdout.write(`${JSON.stringify(redact(output), null, 2)}\n`);
  process.exitCode = output.passed ? 0 : 1;
};

main().catch((error) => {
  const routes = ROUTES.map((route) =>
    routeResults.get(route) || {
      route,
      status: 'skip',
      mode: 'not-run',
      note: 'Route was not reached before the audit stopped.'
    }
  );
  process.stdout.write(
    `${JSON.stringify(
      redact({
        audit: 'mitr-production-api',
        apiBase: API_BASE,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        requestCount,
        requestBudget: MAX_REQUESTS,
        routeCount: ROUTES.length,
        coveredRouteCount: routes.filter((result) => result.status !== 'skip').length,
        counts: routes.reduce(
          (summary, result) => {
            summary[result.status] += 1;
            return summary;
          },
          { pass: 0, fail: 0, skip: 0 }
        ),
        passed: false,
        fatalError: error instanceof Error ? error.message : String(error),
        routes,
        attempts
      }),
      null,
      2
    )}\n`
  );
  process.exitCode = 1;
});
