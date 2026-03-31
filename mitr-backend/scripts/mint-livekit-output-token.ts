import 'dotenv/config';
import { AccessToken, VideoGrant } from 'livekit-server-sdk';

type Args = {
  room: string;
  identity: string;
  ttlSec?: number;
};

const readArg = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
};

const parseArgs = (): Args => {
  const room = readArg('--room')?.trim();
  const identity = readArg('--identity')?.trim() ?? 'esp32-speaker';
  const ttlSecRaw = readArg('--ttl-sec')?.trim();

  if (!room) {
    throw new Error('Missing required argument: --room <livekit-room-name>');
  }

  const ttlSec = ttlSecRaw ? Number.parseInt(ttlSecRaw, 10) : undefined;
  if (ttlSecRaw && (!Number.isFinite(ttlSec) || ttlSec! <= 0)) {
    throw new Error('Invalid --ttl-sec value. Expected a positive integer.');
  }

  return { room, identity, ttlSec };
};

const main = async (): Promise<void> => {
  const livekitUrl = process.env.LIVEKIT_URL?.trim();
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();

  if (!livekitUrl || !apiKey || !apiSecret) {
    throw new Error('LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be set.');
  }

  const args = parseArgs();

  const at = new AccessToken(apiKey, apiSecret, {
    identity: args.identity,
    ttl: args.ttlSec ?? (Number.parseInt(process.env.LIVEKIT_TOKEN_TTL_SEC ?? '3600', 10) || 3600),
    metadata: JSON.stringify({
      role: 'audio_output_device',
      device: 'esp32-s3',
    }),
  });

  const grant: VideoGrant = {
    room: args.room,
    roomJoin: true,
    canPublish: false,
    canSubscribe: true,
    canPublishData: false,
  };
  at.addGrant(grant);

  const participantToken = await at.toJwt();

  process.stdout.write(
    `${JSON.stringify(
      {
        serverUrl: livekitUrl,
        roomName: args.room,
        identity: args.identity,
        participantToken,
      },
      null,
      2,
    )}\n`,
  );
};

void main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
