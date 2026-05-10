import { db } from '../../db/client.js';
import { auditEvents } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';

export const recordAuditEvent = async (input: {
  actorUserId?: string;
  scope: string;
  action: string;
  payload?: Record<string, unknown>;
}): Promise<void> => {
  try {
    await db.insert(auditEvents).values({
      actorUserId: input.actorUserId,
      scope: input.scope,
      action: input.action,
      payload: input.payload ?? {}
    });
  } catch (error) {
    logger.warn('Audit event write failed', {
      action: input.action,
      scope: input.scope,
      error: (error as Error).message
    });
  }
};
