import dotenv from 'dotenv';
import { Redis } from 'ioredis';
import { db } from '../src/db/client.js';
import {
  alerts,
  authIdentities,
  authPasswords,
  careReminders,
  careRoutines,
  concernSignals,
  elderDevices,
  elderProfiles,
  escalationPolicies,
  familyAccounts,
  familyMembers,
  insightSnapshots,
  nudges,
  userProfiles,
  users
} from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { logger } from '../src/lib/logger.js';

dotenv.config({ path: '.env' });

type LegacyAuthUser = {
  id: string;
  phone?: string;
  email?: string;
  name?: string;
  providers: Array<'phone' | 'email' | 'apple' | 'google'>;
  createdAt: number;
  updatedAt: number;
};

const decodeLegacyPassword = (salt: string, hash: string): string | null => {
  if (!hash || hash.length < 3) return null;
  const payload = hash.slice(2);
  try {
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    const prefix = `${salt}:`;
    if (!decoded.startsWith(prefix)) return null;
    return decoded.slice(prefix.length);
  } catch {
    return null;
  }
};

const upsertUserFromLegacy = async (user: LegacyAuthUser) => {
  const [existing] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
  if (!existing) {
    await db.insert(users).values({
      id: user.id,
      externalId: user.id,
      displayName: user.name ?? null,
      createdAt: new Date(user.createdAt)
    });
  }

  if (user.email) {
    const providerUserId = user.email.toLowerCase();
    const [identity] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.providerUserId, providerUserId))
      .limit(1);
    if (!identity) {
      await db.insert(authIdentities).values({
        userId: user.id,
        provider: 'email',
        providerUserId,
        email: providerUserId,
        phone: user.phone
      });
    }
  }

  if (user.phone) {
    const [identity] = await db
      .select()
      .from(authIdentities)
      .where(eq(authIdentities.providerUserId, user.phone))
      .limit(1);
    if (!identity) {
      await db.insert(authIdentities).values({
        userId: user.id,
        provider: 'phone',
        providerUserId: user.phone,
        email: user.email?.toLowerCase(),
        phone: user.phone
      });
    }
  }
};

const run = async () => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL is required for migration script');
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });

  logger.info('Redis->Postgres migration started');

  const userKeys = await redis.keys('auth:user:*');
  for (const key of userKeys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    const parsed = JSON.parse(raw) as LegacyAuthUser;
    await upsertUserFromLegacy(parsed);

    if (parsed.email) {
      const credentialRaw = await redis.get(`auth:password:${parsed.email.toLowerCase()}`);
      if (credentialRaw) {
        try {
          const credential = JSON.parse(credentialRaw) as { salt: string; hash: string };
          const password = decodeLegacyPassword(credential.salt, credential.hash);
          if (password) {
            const [existing] = await db.select().from(authPasswords).where(eq(authPasswords.userId, parsed.id)).limit(1);
            if (!existing) {
              // storing legacy-transcoded value is outside this script; next login/reset flow can rotate it.
              const legacyWrapped = `legacy:${credential.salt}:${password}`;
              await db.insert(authPasswords).values({ userId: parsed.id, passwordHash: legacyWrapped });
            }
          }
        } catch {
          // ignore malformed credential payload
        }
      }
    }
  }

  const familyRaw = await redis.get('family:store:v1');
  if (familyRaw) {
    const state = JSON.parse(familyRaw) as Record<string, any[]>;

    for (const family of state.families ?? []) {
      const [existing] = await db.select().from(familyAccounts).where(eq(familyAccounts.id, family.id)).limit(1);
      if (!existing) {
        await db.insert(familyAccounts).values({
          id: family.id,
          ownerUserId: family.ownerUserId,
          createdAt: new Date(family.createdAt ?? Date.now())
        });
      }
    }

    for (const member of state.members ?? []) {
      const [existing] = await db.select().from(familyMembers).where(eq(familyMembers.id, member.id)).limit(1);
      if (!existing) {
        await db.insert(familyMembers).values({
          id: member.id,
          familyId: member.familyId,
          userId: member.userId,
          role: member.role,
          displayName: member.displayName,
          email: member.email,
          phone: member.phone,
          invitedAt: new Date(member.invitedAt ?? Date.now()),
          acceptedAt: member.acceptedAt ? new Date(member.acceptedAt) : null
        });
      }
    }

    for (const elder of state.elders ?? []) {
      const [existing] = await db.select().from(elderProfiles).where(eq(elderProfiles.id, elder.id)).limit(1);
      if (!existing) {
        await db.insert(elderProfiles).values({
          id: elder.id,
          familyId: elder.familyId,
          name: elder.name,
          ageRange: elder.ageRange,
          language: elder.language,
          city: elder.city,
          timezone: elder.timezone,
          createdAt: new Date(elder.createdAt ?? Date.now()),
          updatedAt: new Date(elder.updatedAt ?? Date.now())
        });
      }
    }

    for (const device of state.devices ?? []) {
      const [existing] = await db.select().from(elderDevices).where(eq(elderDevices.id, device.id)).limit(1);
      if (!existing) {
        await db.insert(elderDevices).values({
          id: device.id,
          elderId: device.elderId,
          serialNumber: device.serialNumber,
          firmwareVersion: device.firmwareVersion,
          wifiConnected: Boolean(device.wifiConnected),
          linkedAt: new Date(device.linkedAt ?? Date.now()),
          updatedAt: new Date(device.linkedAt ?? Date.now())
        });
      }
    }

    for (const item of state.careReminders ?? []) {
      const [existing] = await db.select().from(careReminders).where(eq(careReminders.id, item.id)).limit(1);
      if (!existing) {
        await db.insert(careReminders).values({
          id: item.id,
          elderId: item.elderId,
          title: item.title,
          description: item.description,
          scheduledTime: item.scheduledTime,
          enabled: Boolean(item.enabled),
          updatedAt: new Date(item.updatedAt ?? Date.now())
        });
      }
    }

    for (const item of state.routines ?? []) {
      const [existing] = await db.select().from(careRoutines).where(eq(careRoutines.id, item.id)).limit(1);
      if (!existing) {
        await db.insert(careRoutines).values({
          id: item.id,
          elderId: item.elderId,
          key: item.key,
          title: item.title,
          enabled: Boolean(item.enabled),
          schedule: item.schedule,
          updatedAt: new Date(item.updatedAt ?? Date.now())
        });
      }
    }

    for (const item of state.nudges ?? []) {
      const [existing] = await db.select().from(nudges).where(eq(nudges.id, item.id)).limit(1);
      if (!existing) {
        await db.insert(nudges).values({
          id: item.id,
          elderId: item.elderId,
          createdByUserId: item.createdByUserId,
          type: item.type,
          text: item.text,
          voiceUrl: item.voiceUrl,
          priority: item.priority,
          deliveryState: item.deliveryState,
          scheduledAt: new Date(item.scheduledFor ?? Date.now()),
          createdAt: new Date(item.createdAt ?? Date.now()),
          updatedAt: new Date(item.updatedAt ?? Date.now())
        });
      }
    }

    for (const item of state.alerts ?? []) {
      const [existing] = await db.select().from(alerts).where(eq(alerts.id, item.id)).limit(1);
      if (!existing) {
        await db.insert(alerts).values({
          id: item.id,
          elderId: item.elderId,
          concernSignalId: item.concernSignalId,
          severity: item.severity,
          status: item.status,
          title: item.title,
          details: item.details,
          createdAt: new Date(item.createdAt ?? Date.now()),
          acknowledgedAt: item.acknowledgedAt ? new Date(item.acknowledgedAt) : null,
          resolvedAt: item.resolvedAt ? new Date(item.resolvedAt) : null,
          updatedAt: new Date(item.updatedAt ?? Date.now())
        });
      }
    }

    for (const item of state.concerns ?? []) {
      const [existing] = await db.select().from(concernSignals).where(eq(concernSignals.id, item.id)).limit(1);
      if (!existing) {
        await db.insert(concernSignals).values({
          id: item.id,
          elderId: item.elderId,
          type: item.type,
          severity: item.severity,
          confidence: item.confidence,
          message: item.message,
          status: 'open',
          createdAt: new Date(item.createdAt ?? Date.now())
        });
      }
    }

    for (const item of state.insights ?? []) {
      await db.insert(insightSnapshots).values({
        elderId: item.elderId,
        payload: item,
        ts: new Date(item.generatedAt ?? Date.now())
      });
    }

    for (const item of state.policies ?? []) {
      const [existing] = await db
        .select()
        .from(escalationPolicies)
        .where(eq(escalationPolicies.elderId, item.elderId))
        .limit(1);
      if (!existing) {
        await db.insert(escalationPolicies).values({
          elderId: item.elderId,
          quietHoursStart: item.quietHoursStart,
          quietHoursEnd: item.quietHoursEnd,
          stage1NudgeDelayMin: item.stage1NudgeDelayMin,
          stage2FamilyAlertDelayMin: item.stage2FamilyAlertDelayMin,
          stage3EmergencyDelayMin: item.stage3EmergencyDelayMin,
          enabledTriggers: item.enabledTriggers,
          updatedAt: new Date(item.updatedAt ?? Date.now())
        });
      }
    }
  }

  const profileKeys = await redis.keys('profile:*');
  for (const key of profileKeys) {
    const raw = await redis.get(key);
    if (!raw) continue;
    try {
      const payload = JSON.parse(raw) as { userId: string; answers: Record<string, string>; updatedAt: number };
      const [existing] = await db.select().from(userProfiles).where(eq(userProfiles.userId, payload.userId)).limit(1);
      if (!existing) {
        await db.insert(userProfiles).values({
          userId: payload.userId,
          answers: payload.answers ?? {},
          updatedAt: new Date(payload.updatedAt ?? Date.now())
        });
      }
    } catch {
      // ignore malformed profile payload
    }
  }

  await redis.quit();
  logger.info('Redis->Postgres migration complete');
};

run().catch((error) => {
  logger.error('Redis->Postgres migration failed', { error: (error as Error).message });
  process.exit(1);
});
