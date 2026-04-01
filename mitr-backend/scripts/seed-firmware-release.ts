import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { firmwareReleases } from '../src/db/schema.js';

type Args = {
  hardwareRev: string;
  version: string;
  rolloutChannel: 'dev' | 'pilot' | 'ga';
  downloadUrl?: string;
  releaseNotes?: string;
  mandatory: boolean;
  activate: boolean;
};

const readArg = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
};

const parseBoolFlag = (flag: string): boolean => process.argv.includes(flag);

const usage = (): string => `Usage:
  pnpm tsx scripts/seed-firmware-release.ts --hardware-rev esp32-s3-wroom --version v0.1.0 [options]

Required:
  --hardware-rev <hardware-rev>
  --version <firmware-version>

Optional:
  --rollout-channel <dev|pilot|ga>   default: dev
  --download-url <https-url>
  --release-notes <text>
  --mandatory
  --inactive`;

const parseArgs = (): Args => {
  const hardwareRev = readArg('--hardware-rev')?.trim();
  const version = readArg('--version')?.trim();
  const rolloutChannel = (readArg('--rollout-channel')?.trim() as Args['rolloutChannel'] | undefined) ?? 'dev';

  if (!hardwareRev || !version) {
    throw new Error(`${usage()}`);
  }
  if (!['dev', 'pilot', 'ga'].includes(rolloutChannel)) {
    throw new Error(`Invalid rollout channel: ${rolloutChannel}`);
  }

  return {
    hardwareRev,
    version,
    rolloutChannel,
    downloadUrl: readArg('--download-url')?.trim(),
    releaseNotes: readArg('--release-notes')?.trim(),
    mandatory: parseBoolFlag('--mandatory'),
    activate: !parseBoolFlag('--inactive')
  };
};

const main = async (): Promise<void> => {
  const args = parseArgs();

  const [existing] = await db
    .select()
    .from(firmwareReleases)
    .where(and(eq(firmwareReleases.hardwareRev, args.hardwareRev), eq(firmwareReleases.version, args.version)))
    .limit(1);

  if (existing) {
    const [updated] = await db
      .update(firmwareReleases)
      .set({
        rolloutChannel: args.rolloutChannel,
        downloadUrl: args.downloadUrl ?? existing.downloadUrl,
        releaseNotes: args.releaseNotes ?? existing.releaseNotes,
        isMandatory: args.mandatory,
        isActive: args.activate,
        publishedAt: new Date()
      })
      .where(eq(firmwareReleases.id, existing.id))
      .returning();

    process.stdout.write(`${JSON.stringify({ action: 'updated', release: updated }, null, 2)}\n`);
    return;
  }

  const [created] = await db
    .insert(firmwareReleases)
    .values({
      hardwareRev: args.hardwareRev,
      version: args.version,
      rolloutChannel: args.rolloutChannel,
      downloadUrl: args.downloadUrl ?? null,
      releaseNotes: args.releaseNotes ?? null,
      isMandatory: args.mandatory,
      isActive: args.activate
    })
    .returning();

  process.stdout.write(`${JSON.stringify({ action: 'created', release: created }, null, 2)}\n`);
};

void main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
