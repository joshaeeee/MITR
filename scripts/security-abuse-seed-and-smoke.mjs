#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const apiBase = process.env.API_BASE ?? 'http://localhost:8081';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const unique = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const password = 'River#Temple42';

const redact = (value) =>
  String(value).replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]');

const request = async (method, pathName, token, body) => {
  const response = await fetch(`${apiBase}${pathName}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }

  if (!response.ok) {
    throw new Error(`${method} ${pathName} failed with ${response.status}: ${redact(text).slice(0, 500)}`);
  }

  return json;
};

const signup = async (label) => {
  const email = `security-smoke+${unique}-${label}@example.com`;
  const result = await request('POST', '/auth/email/signup', null, {
    email,
    password,
    name: `Security Smoke ${label.toUpperCase()}`
  });
  return {
    email,
    userId: result.user.id,
    token: result.session.accessToken
  };
};

const verifyReachable = async () => {
  const response = await fetch(`${apiBase}/healthz`);
  await response.arrayBuffer();
};

const main = async () => {
  try {
    await verifyReachable();
  } catch (error) {
    console.error(`[security-abuse-seed] API is not reachable at ${apiBase}`);
    console.error(`[security-abuse-seed] ${error.message}`);
    process.exit(1);
  }

  console.log(`[security-abuse-seed] creating throwaway users against ${apiBase}`);
  const userA = await signup('a');
  const userB = await signup('b');

  const familyA = await request('GET', '/family/me', userA.token);
  const familyB = await request('GET', '/family/me', userB.token);
  const shortSession = await request('POST', '/session/start', userA.token, {});

  await request('PATCH', '/elder/profile', userA.token, {
    name: 'Security Smoke Elder A',
    ageRange: '70-80',
    language: 'hi-IN',
    city: 'Delhi',
    timezone: 'Asia/Kolkata'
  });

  const invitedMember = await request('POST', '/family/invite', userA.token, {
    displayName: 'Security Smoke Pending Member',
    email: `security-smoke+${unique}-invitee@example.com`,
    role: 'member'
  });

  const careItem = await request('POST', '/care/items', userA.token, {
    section: 'repeated_reminders',
    type: 'reminder',
    title: 'Security smoke care item',
    enabled: true,
    scheduledAt: '09:00',
    repeatRule: 'daily'
  });

  const routines = await request('GET', '/care/routines', userA.token);
  const routine = routines.items?.[0];
  if (!routine?.id) {
    throw new Error('Expected at least one routine for user A');
  }

  const alerts = await request('GET', '/alerts', userA.token);
  const alert = alerts.items?.[0];
  if (!alert?.id) {
    throw new Error('Expected at least one alert for user A');
  }

  const longSession = await request('POST', '/long-session/start', userA.token, {
    mode: 'companion_long',
    targetDurationSec: 300,
    language: 'hi-IN',
    topic: 'security smoke test'
  });

  const pairing = await request('POST', '/devices/pairing/start', userA.token, {
    deviceId: `security-smoke-${unique}`,
    displayName: 'Security Smoke Device',
    metadata: { purpose: 'security-abuse-smoke' }
  });

  const env = {
    ...process.env,
    API_BASE: apiBase,
    USER_A_TOKEN: userA.token,
    USER_B_TOKEN: userB.token,
    USER_A_ID: userA.userId,
    USER_B_FAMILY_ID: familyB.familyId,
    USER_A_MEMBER_ID: invitedMember.id,
    USER_A_ALERT_ID: alert.id,
    USER_A_CARE_ITEM_ID: careItem.id,
    USER_A_ROUTINE_ID: routine.id,
    USER_A_SESSION_ID: shortSession.sessionId,
    USER_A_LONG_SESSION_ID: longSession.session.longSessionId,
    USER_A_PAIRING_ID: pairing.pairingId
  };

  console.log('[security-abuse-seed] seeded resources');
  console.log(
    JSON.stringify(
      {
        userA: { id: userA.userId, email: userA.email, familyId: familyA.familyId },
        userB: { id: userB.userId, email: userB.email, familyId: familyB.familyId },
        ids: {
          memberId: invitedMember.id,
          alertId: alert.id,
          careItemId: careItem.id,
          routineId: routine.id,
          sessionId: shortSession.sessionId,
          longSessionId: longSession.session.longSessionId,
          pairingId: pairing.pairingId
        }
      },
      null,
      2
    )
  );

  console.log('[security-abuse-seed] running cross-user abuse smoke checks');
  const result = spawnSync('bash', ['scripts/security-abuse-smoke.sh'], {
    cwd: root,
    env,
    stdio: 'inherit'
  });
  process.exit(result.status ?? 1);
};

main().catch((error) => {
  console.error(`[security-abuse-seed] ${redact(error.stack ?? error.message)}`);
  process.exit(1);
});
