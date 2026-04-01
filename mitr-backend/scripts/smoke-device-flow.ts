import 'dotenv/config';
import { AuthService } from '../src/services/auth/auth-service.js';
import { DeviceControlService } from '../src/services/device/device-control-service.js';

type Args = {
  userId?: string;
  email?: string;
  deviceId: string;
  displayName?: string;
  language?: string;
  hardwareRev?: string;
  firmwareVersion?: string;
  roomName?: string;
};

const readArg = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
};

const usage = (): string => `Usage:
  pnpm tsx scripts/smoke-device-flow.ts --device-id mitr-esp32-001 --email tester@gmail.com [options]

Required:
  --device-id <device-id>
  one of --user-id <uuid> or --email <email>

Optional:
  --display-name <label>
  --language <hi-IN>
  --hardware-rev <esp32-s3-wroom-revA>
  --firmware-version <v0.1.0>
  --room-name <explicit-room-name>`;

const parseArgs = (): Args => {
  const deviceId = readArg('--device-id')?.trim();
  const userId = readArg('--user-id')?.trim();
  const email = readArg('--email')?.trim();

  if (!deviceId) {
    throw new Error(`Missing required argument: --device-id\n\n${usage()}`);
  }
  if (!userId && !email) {
    throw new Error(`Provide one of --user-id or --email\n\n${usage()}`);
  }

  return {
    userId,
    email,
    deviceId,
    displayName: readArg('--display-name')?.trim(),
    language: readArg('--language')?.trim(),
    hardwareRev: readArg('--hardware-rev')?.trim(),
    firmwareVersion: readArg('--firmware-version')?.trim(),
    roomName: readArg('--room-name')?.trim()
  };
};

const main = async (): Promise<void> => {
  const args = parseArgs();
  const auth = new AuthService();
  const devices = new DeviceControlService();

  const user =
    args.userId
      ? { id: args.userId }
      : await auth.getUserByEmail(args.email!);

  if (!user) {
    throw new Error(`No user found for ${args.email}. Run pnpm seed:dev-account or provide --user-id.`);
  }

  const claim = await devices.startClaim(user.id);
  const completed = await devices.completeClaim({
    claimCode: claim.claimCode,
    deviceId: args.deviceId,
    displayName: args.displayName,
    hardwareRev: args.hardwareRev,
    firmwareVersion: args.firmwareVersion,
    metadata: {
      source: 'smoke-device-flow',
      claimedBy: args.email ?? user.id
    }
  });

  const device = await devices.getDeviceFromAccessToken(completed.deviceAccessToken);
  if (!device) {
    throw new Error('Failed to load newly claimed device');
  }

  const token = await devices.mintLiveKitToken({
    device,
    language: args.language,
    roomName: args.roomName,
    firmwareVersion: args.firmwareVersion,
    hardwareRev: args.hardwareRev,
    metadata: {
      source: 'smoke-device-flow'
    }
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        claim,
        device: {
          deviceId: completed.deviceId,
          deviceAccessToken: completed.deviceAccessToken,
          userId: completed.userId,
          hardwareRev: completed.hardwareRev,
          firmwareVersion: completed.firmwareVersion
        },
        livekit: token
      },
      null,
      2
    )}\n`
  );
};

void main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
