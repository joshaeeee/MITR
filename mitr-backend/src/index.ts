import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { registerSessionRoutes } from './routes/session.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerFamilyRoutes } from './routes/family.js';
import { registerElderRoutes } from './routes/elder.js';
import { registerNudgesRoutes } from './routes/nudges.js';
import { registerInsightsRoutes } from './routes/insights.js';
import { registerAlertsRoutes } from './routes/alerts.js';
import { registerCareRoutes } from './routes/care.js';
import { registerDeviceRoutes } from './routes/device.js';
import { registerAgentRoutes } from './routes/agent.js';
import { ProfileService } from './services/profile/profile-service.js';
import { SessionStore } from './services/session-store.js';
import { SessionRecoveryService } from './services/long-session/session-recovery-service.js';
import { db, pgPool } from './db/client.js';
import { sql } from 'drizzle-orm';
import { closeReminderQueue } from './services/reminders/queue.js';
import { closeRedisConnections } from './lib/redis.js';
import { AuthService } from './services/auth/auth-service.js';

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
  const auth = new AuthService();
  const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);

  await app.register(cors, {
    origin: (origin, callback) => {
      // Native mobile requests often have no Origin header.
      if (!origin) return callback(null, true);
      if (corsOrigins.length === 0) return callback(null, true);
      if (corsOrigins.includes('*')) return callback(null, true);
      if (corsOrigins.includes(origin)) return callback(null, true);
      // Expo dev clients can send exp:// origins.
      if (origin.startsWith('exp://')) return callback(null, true);
      return callback(new Error('CORS origin not allowed'), false);
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']
  });

  registerAuthRoutes(app, auth);
  registerFamilyRoutes(app, auth);
  registerElderRoutes(app, auth);
  registerNudgesRoutes(app, auth);
  registerInsightsRoutes(app, auth);
  registerAlertsRoutes(app, auth);
  registerCareRoutes(app, auth);
  registerDeviceRoutes(app, auth);
  registerAgentRoutes(app, auth);
  registerSessionRoutes(app, store, profiles, auth);

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
