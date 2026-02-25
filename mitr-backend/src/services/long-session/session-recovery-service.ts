import { logger } from '../../lib/logger.js';
import { env } from '../../config/env.js';
import { SessionDirectorService } from './session-director-service.js';
import { longSessionMetrics } from './long-session-metrics.js';

export class SessionRecoveryService {
  constructor(private readonly director = new SessionDirectorService()) {}

  async recoverAtStartup(): Promise<void> {
    const staleAfterMs = env.LONG_SESSION_STALE_MS;
    const startedAt = Date.now();

    const recovered = await this.director.recoverStaleRunningBlocks(staleAfterMs);
    longSessionMetrics.addOrphanRunningBlocks(recovered.blocksFailed);

    logger.info('Long-session recovery completed', {
      staleAfterMs,
      sessionsRecovered: recovered.sessionsRecovered,
      blocksFailed: recovered.blocksFailed,
      elapsedMs: Date.now() - startedAt,
      env: env.NODE_ENV
    });
  }
}
