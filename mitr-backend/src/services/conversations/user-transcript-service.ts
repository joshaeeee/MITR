import { db } from '../../db/client.js';
import { userInputTranscripts } from '../../db/schema.js';
import { logger } from '../../lib/logger.js';
import { scheduleInsightIngestJob } from '../insights/queue.js';

export class UserTranscriptService {
  async appendFinalUserTranscript(input: {
    sessionId: string;
    userId: string;
    transcript: string;
    language?: string | null;
  }): Promise<void> {
    const transcript = input.transcript.trim();
    if (!transcript) return;

    const [inserted] = await db
      .insert(userInputTranscripts)
      .values({
        sessionId: input.sessionId,
        userId: input.userId,
        transcript,
        language: input.language ?? null
      })
      .returning({
        id: userInputTranscripts.id,
        createdAt: userInputTranscripts.createdAt
      });

    try {
      await scheduleInsightIngestJob({
        transcriptId: inserted.id,
        userId: input.userId,
        sessionId: input.sessionId,
        transcript,
        language: input.language ?? null,
        transcribedAtIso: inserted.createdAt.toISOString()
      });
    } catch (error) {
      logger.warn('Failed to enqueue insight ingest job', {
        transcriptId: inserted.id,
        userId: input.userId,
        sessionId: input.sessionId,
        error: (error as Error).message
      });
    }
  }
}
