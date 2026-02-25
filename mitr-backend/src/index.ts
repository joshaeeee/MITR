import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { registerSessionRoutes } from './routes/session.js';
import { ProfileService } from './services/profile/profile-service.js';
import { SessionStore } from './services/session-store.js';
import { SessionRecoveryService } from './services/long-session/session-recovery-service.js';
import { db, pgPool } from './db/client.js';
import { sql } from 'drizzle-orm';
import { closeReminderQueue } from './services/reminders/queue.js';
import { closeRedisConnections } from './lib/redis.js';

let appRef: FastifyInstance | null = null;
let shutdownInProgress = false;

const shutdown = async (signal: string): Promise<void> => {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  logger.info('Shutdown started', { signal });

  const killTimer = setTimeout(() => {
    logger.error('Forced shutdown after timeout', { signal });
    process.exit(1);
  }, 15_000);
  killTimer.unref();

  try {
    if (appRef) {
      await appRef.close();
    }
    await closeReminderQueue();
    await closeRedisConnections();
    await pgPool.end();
    logger.info('Shutdown complete', { signal });
    process.exit(0);
  } catch (error) {
    logger.error('Shutdown failed', { signal, error: (error as Error).message });
    process.exit(1);
  }
};

const bootstrap = async (): Promise<void> => {
  const app = Fastify({ logger: false });
  appRef = app;
  const store = new SessionStore();
  const profiles = new ProfileService();
  const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);

  await app.register(cors, {
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    methods: ['GET', 'POST', 'OPTIONS']
  });

  registerSessionRoutes(app, store, profiles);

  await db.execute(sql`select 1`);
  const recovery = new SessionRecoveryService();
  await recovery.recoverAtStartup();

  await app.listen({ host: '0.0.0.0', port: env.PORT });
  logger.info(`Mitr API listening on :${env.PORT}`);
};

bootstrap().catch((error) => {
  logger.error('Failed to start Mitr backend', error);
  process.exit(1);
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
