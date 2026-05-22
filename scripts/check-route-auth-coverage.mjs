#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const routesDir = path.join(root, 'mitr-backend', 'src', 'routes');

const authGuardPatterns = [
  /\bguard\b/,
  /\bauthGuard\b/,
  /\bdeviceGuard\b/,
  /\brequireAuth\b/,
  /\brequireInternalServiceAuth\b/,
  /\brequireInternalOrDeviceAuth\b/
];

const intentionallyPublic = new Set([
  'GET /auth/swiggy/dev-authorize',
  'GET /auth/swiggy/callback',
  'GET /onboarding/questions',
  'GET /healthz'
]);

const intentionallyTokenOrRateLimited = new Set([
  'POST /auth/otp/start',
  'POST /auth/otp/verify',
  'POST /auth/email/signup',
  'POST /auth/email/login',
  'POST /auth/session/refresh',
  'POST /auth/oauth/apple',
  'POST /auth/oauth/google',
  'POST /devices/claim/complete',
  'POST /devices/bootstrap/complete',
  'PUT /voice-notes/upload/:voiceNoteId'
]);

const routeRegex = /app\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]\s*,\s*(.*)$/;
const failures = [];
let routeCount = 0;

for (const fileName of readdirSync(routesDir).filter((file) => file.endsWith('.ts')).sort()) {
  const filePath = path.join(routesDir, fileName);
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);

  lines.forEach((line, index) => {
    const match = routeRegex.exec(line);
    if (!match) return;

    routeCount += 1;
    const [, rawMethod, routePath, routeOptions] = match;
    const routeKey = `${rawMethod.toUpperCase()} ${routePath}`;
    const location = `${path.relative(root, filePath)}:${index + 1}`;
    const hasPreHandler = routeOptions.includes('preHandler');
    const hasAuthGuard = authGuardPatterns.some((pattern) => pattern.test(routeOptions));

    if (hasAuthGuard) return;
    if (hasPreHandler && intentionallyTokenOrRateLimited.has(routeKey)) return;
    if (!hasPreHandler && intentionallyPublic.has(routeKey)) return;

    failures.push(`${location} ${routeKey} lacks an approved auth/internal/device guard`);
  });
}

if (failures.length > 0) {
  console.error('[route-auth] failed');
  for (const failure of failures) {
    console.error(`[route-auth] ${failure}`);
  }
  process.exit(1);
}

console.log(`[route-auth] passed (${routeCount} routes checked)`);
