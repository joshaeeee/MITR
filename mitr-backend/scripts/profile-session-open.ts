import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { devices as devicesTable } from '../src/db/schema.js';
import { AuthService } from '../src/services/auth/auth-service.js';
import { DeviceControlService } from '../src/services/device/device-control-service.js';

type Args = {
  userId?: string;
  email?: string;
  deviceId: string;
  iterations: number;
};

const readArg = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
};

const usage = (): string => `Usage:
  pnpm tsx scripts/profile-session-open.ts --device-id mitr-esp32-002 --email tester@gmail.com [--iterations 25]

The device must already be claimed (run scripts/smoke-device-flow.ts first if needed).

Captures the 'session_open_perf' JSON log lines emitted by openDeviceSession()
and prints p50/p95/max for totalMs and every stage, split by path
(reuse / supersede / fresh).`;

const parseArgs = (): Args => {
  const deviceId = readArg('--device-id')?.trim();
  const userId = readArg('--user-id')?.trim();
  const email = readArg('--email')?.trim();
  const iterRaw = readArg('--iterations')?.trim();
  if (!deviceId) throw new Error(`Missing --device-id\n\n${usage()}`);
  if (!userId && !email) throw new Error(`Provide one of --user-id or --email\n\n${usage()}`);
  const iterations = iterRaw ? Number.parseInt(iterRaw, 10) : 25;
  if (!Number.isFinite(iterations) || iterations < 1) {
    throw new Error('iterations must be a positive integer');
  }
  return { userId, email, deviceId, iterations };
};

type PerfEvent = {
  event: 'session_open_perf';
  deviceId: string;
  bootId: string;
  path: 'reuse' | 'supersede' | 'fresh';
  totalMs: number;
  slow: boolean;
  stages: Record<string, number>;
};

const captured: PerfEvent[] = [];
const originalLog = console.log;
console.log = (...args: unknown[]) => {
  if (args.length === 1 && typeof args[0] === 'string') {
    try {
      const parsed = JSON.parse(args[0]) as PerfEvent;
      if (parsed?.event === 'session_open_perf') {
        captured.push(parsed);
        return;
      }
    } catch {
      // not our JSON, fall through
    }
  }
  originalLog(...args);
};

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
};

const summarize = (events: PerfEvent[], label: string): void => {
  if (events.length === 0) {
    originalLog(`\n[${label}] no samples`);
    return;
  }
  const totals = events.map((e) => e.totalMs);
  const stageNames = new Set<string>();
  events.forEach((e) => Object.keys(e.stages).forEach((k) => stageNames.add(k)));

  originalLog(`\n[${label}] n=${events.length}`);
  originalLog(`  total      p50=${percentile(totals, 50)}ms  p95=${percentile(totals, 95)}ms  max=${Math.max(...totals)}ms`);
  for (const stage of [...stageNames].sort()) {
    const stageVals = events.map((e) => e.stages[stage] ?? 0).filter((v) => v > 0);
    if (stageVals.length === 0) continue;
    originalLog(
      `    ${stage.padEnd(28)} p50=${String(percentile(stageVals, 50)).padStart(6)}ms  p95=${String(percentile(stageVals, 95)).padStart(6)}ms  max=${String(Math.max(...stageVals)).padStart(6)}ms  hits=${stageVals.length}/${events.length}`
    );
  }
};

const main = async (): Promise<void> => {
  const args = parseArgs();
  const auth = new AuthService();
  const deviceService = new DeviceControlService();

  const user = args.userId
    ? { id: args.userId }
    : await auth.getUserByEmail(args.email!);
  if (!user) throw new Error(`No user found for ${args.email}. Run pnpm seed:dev-account first.`);

  // Look up the device row directly — must already be claimed
  const [deviceRow] = await db
    .select()
    .from(devicesTable)
    .where(and(eq(devicesTable.deviceId, args.deviceId), isNull(devicesTable.revokedAt)))
    .limit(1);
  if (!deviceRow) {
    throw new Error(
      `Device ${args.deviceId} not found (or revoked). Run scripts/smoke-device-flow.ts first to claim it.`
    );
  }
  if (deviceRow.userId !== user.id && deviceRow.claimedByUserId !== user.id) {
    throw new Error(`Device ${args.deviceId} is not owned by user ${user.id}`);
  }

  const deviceAuthRecord = {
    id: deviceRow.id,
    deviceId: deviceRow.deviceId,
    userId: deviceRow.userId,
    familyId: deviceRow.familyId,
    elderId: deviceRow.elderId,
    claimedByUserId: deviceRow.claimedByUserId,
    displayName: deviceRow.displayName,
    hardwareRev: deviceRow.hardwareRev,
    firmwareVersion: deviceRow.firmwareVersion,
    metadataJson: (deviceRow.metadataJson ?? {}) as Record<string, unknown>
  };

  originalLog(`Profiling openDeviceSession for ${args.deviceId} × ${args.iterations} iterations per path...`);

  // Phase 1 — establish a bootId so subsequent calls hit the REUSE path
  const reuseBootId = randomUUID().replace(/-/g, '');
  await deviceService.openDeviceSession({ device: deviceAuthRecord, bootId: reuseBootId });
  // Drop the warmup event so it doesn't skew samples (TLS warm-up, etc.)
  captured.length = 0;

  // Phase 1 — REUSE: same bootId, hits the early-return reuse branch
  for (let i = 0; i < args.iterations; i++) {
    await deviceService.openDeviceSession({ device: deviceAuthRecord, bootId: reuseBootId });
  }

  // Phase 2 — SUPERSEDE: each call uses a fresh bootId, ending the previous session
  for (let i = 0; i < args.iterations; i++) {
    await deviceService.openDeviceSession({ device: deviceAuthRecord, bootId: randomUUID().replace(/-/g, '') });
  }

  const reuseEvents = captured.filter((e) => e.path === 'reuse');
  const supersedeEvents = captured.filter((e) => e.path === 'supersede');
  const freshEvents = captured.filter((e) => e.path === 'fresh');

  originalLog(`\nCaptured ${captured.length} session_open_perf events:`);
  summarize(reuseEvents, 'REUSE');
  summarize(supersedeEvents, 'SUPERSEDE');
  summarize(freshEvents, 'FRESH');

  const slowCount = captured.filter((e) => e.slow).length;
  originalLog(`\n${slowCount}/${captured.length} requests > 500ms`);

  // Dump raw JSON in case caller wants full data
  if (process.argv.includes('--raw')) {
    originalLog('\n--- raw events ---');
    captured.forEach((e) => originalLog(JSON.stringify(e)));
  }

  process.exit(0);
};

void main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n${(error as Error).stack ?? ''}\n`);
  process.exit(1);
});
