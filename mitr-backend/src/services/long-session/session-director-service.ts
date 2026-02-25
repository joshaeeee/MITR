import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  longSessionBlocks,
  longSessionEvents,
  longSessions,
  longSessionSummaries
} from '../../db/schema.js';
import {
  buildSatsangLedger,
  SatsangLedgerEntry,
  getSatsangLedgerEntryById
} from '../companion/satsang-ledger.js';
import { logger } from '../../lib/logger.js';

export type LongSessionMode = 'companion_long' | 'satsang_long' | 'story_long';
export type LongSessionStatus = 'running' | 'paused' | 'completed' | 'stopped';
export type LongSessionBlockState = 'queued' | 'running' | 'done' | 'skipped' | 'failed';
export type LongSessionBlockType = 'speak_text' | 'ask_user' | 'listen_user' | 'pause' | 'recap' | 'play_media' | 'close';

export interface LongSessionBlockPayload {
  type: LongSessionBlockType;
  durationHintSec: number;
  language?: string;
  contentSource: 'generated' | 'rag' | 'memory' | 'fixed';
  completionPolicy: 'auto' | 'needs_user_input' | 'timeout';
  interruptPolicy: 'restart' | 'resume' | 'skip';
  phase?: string;
  maxWords?: number;
  prompt?: string;
  fixedText?: string;
  citationRequired?: boolean;
  useRetrieval?: 'religious' | 'story';
  servedIds?: string[];
  shlokaId?: string;
  shlokaReference?: string;
  shlokaText?: string;
  arthHint?: string;
  vyakhyaHint?: string;
}

export interface LongSessionStartInput {
  userId: string;
  mode: LongSessionMode;
  targetDurationSec?: number;
  topic?: string;
  language?: string;
  resumeIfRunning?: boolean;
  paceMode?: 'interactive' | 'continuous';
  targetShlokaCount?: number;
}

interface SatsangMetadata {
  paceMode: 'interactive' | 'continuous';
  targetShlokaCount: number;
  completedShlokas: number;
  activeAdhyaay?: string;
  ledgerShlokaIds?: string[];
  ledgerEntries?: SatsangLedgerEntry[];
  nextLedgerIndex?: number;
  lastCompletedShlokaId?: string;
}

interface SessionMetadata {
  toldStoryIds?: string[];
  servedPassageIds?: string[];
  consecutiveFailures?: number;
  lastCheckpointTs?: string;
  satsang?: SatsangMetadata;
}

export interface LongSessionSnapshot {
  longSessionId: string;
  userId: string;
  mode: LongSessionMode;
  status: LongSessionStatus;
  phase: string;
  targetDurationSec: number;
  elapsedSec: number;
  topic?: string;
  language: string;
  currentBlockId?: string | null;
  version: number;
  metadata: SessionMetadata;
  remainingSec: number;
  lastCheckpointTs?: string;
}

export interface LongSessionBlock {
  id: string;
  longSessionId: string;
  seq: number;
  blockType: LongSessionBlockType;
  state: LongSessionBlockState;
  payload: LongSessionBlockPayload;
}

export class SessionDirectorService {
  private static readonly DEFAULT_TARGET_SEC = 1800;
  private static readonly RESUME_MAX_IDLE_MS = 30 * 60 * 1000;

  async start(input: LongSessionStartInput): Promise<{ session: LongSessionSnapshot; nextBlock: LongSessionBlock }> {
    const targetDurationSec = Math.max(300, Math.min(input.targetDurationSec ?? SessionDirectorService.DEFAULT_TARGET_SEC, 7200));
    const existing = await this.getByUserRunning(input.userId);

    if (existing && input.resumeIfRunning === true) {
      const resumeDecision = await this.canResumeExisting(existing, input);
      if (resumeDecision.canResume) {
        const nextBlock = await this.next(existing.longSessionId);
        if (nextBlock) {
          return { session: existing, nextBlock };
        }
        const resumed = await this.resume(existing.longSessionId);
        if (resumed?.nextBlock) {
          return { session: resumed.session, nextBlock: resumed.nextBlock };
        }
        await this.stop(existing.longSessionId, 'superseded_by_new_start_no_runnable');
      } else {
        await this.stop(existing.longSessionId, resumeDecision.reason);
      }
    } else if (existing) {
      await this.stop(existing.longSessionId, 'superseded_by_new_start');
    }

    const initialPhase = this.initialPhaseForMode(input.mode);
    const satsangConfig = input.mode === 'satsang_long' ? this.resolveSatsangConfig(input) : undefined;
    const satsangLedger =
      input.mode === 'satsang_long' && satsangConfig
        ? await buildSatsangLedger({
            topic: input.topic,
            targetShlokaCount: satsangConfig.targetShlokaCount
          })
        : undefined;
    if (satsangLedger && satsangLedger.ids.length > 0) {
      logger.info('Satsang ledger initialized', {
        userId: input.userId,
        topic: input.topic,
        ids: satsangLedger.ids
      });
    }
    const initialMetadata: SessionMetadata = {
      consecutiveFailures: 0,
      ...(satsangConfig
        ? {
            satsang: {
              paceMode: satsangConfig.paceMode,
              targetShlokaCount: satsangConfig.targetShlokaCount,
              completedShlokas: 0,
              activeAdhyaay: satsangConfig.activeAdhyaay,
              ledgerShlokaIds: satsangLedger?.ids ?? [],
              ledgerEntries: satsangLedger?.entries ?? [],
              nextLedgerIndex: 0
            }
          }
        : {})
    };
    const [created] = await db
      .insert(longSessions)
      .values({
        userId: input.userId,
        mode: input.mode,
        status: 'running',
        phase: initialPhase,
        targetDurationSec,
        elapsedSec: 0,
        topic: input.topic,
        language: input.language ?? 'hi-IN',
        metadataJson: initialMetadata as Record<string, unknown>
      })
      .returning();

    const blocks = this.buildInitialTemplateBlocks({
      mode: input.mode,
      topic: input.topic,
      language: created.language,
      metadata: initialMetadata
    });
    await this.enqueueBlocks(created.id, blocks, 1);
    const nextBlock = await this.next(created.id);
    if (!nextBlock) throw new Error('Failed to fetch first long-session block');

    void this.recordEvent(created.id, 'session_started', {
      mode: created.mode,
      topic: created.topic,
      targetDurationSec: created.targetDurationSec
    }).catch(() => {
      // non-blocking analytics/event write
    });
    const snapshot = this.toSnapshot({
      ...created,
      currentBlockId: nextBlock.id,
      version: (created.version ?? 0) + 1
    });
    return {
      session: snapshot,
      nextBlock
    };
  }

  async get(longSessionId: string): Promise<LongSessionSnapshot | null> {
    const rows = await db.select().from(longSessions).where(eq(longSessions.id, longSessionId)).limit(1);
    const row = rows[0];
    return row ? this.toSnapshot(row) : null;
  }

  async getDetailed(longSessionId: string): Promise<{
    session: LongSessionSnapshot;
    currentBlock: LongSessionBlock | null;
    recentBlocks: LongSessionBlock[];
  } | null> {
    const session = await this.get(longSessionId);
    if (!session) return null;

    const currentBlock = session.currentBlockId ? await this.getBlock(session.currentBlockId) : null;
    const recentRows = await db
      .select()
      .from(longSessionBlocks)
      .where(eq(longSessionBlocks.longSessionId, longSessionId))
      .orderBy(desc(longSessionBlocks.seq))
      .limit(10);

    return {
      session,
      currentBlock,
      recentBlocks: recentRows
        .map((row) => this.toBlock(row))
        .sort((a, b) => a.seq - b.seq)
    };
  }

  async getByUserRunning(userId: string): Promise<LongSessionSnapshot | null> {
    const rows = await db
      .select()
      .from(longSessions)
      .where(and(eq(longSessions.userId, userId), eq(longSessions.status, 'running')))
      .orderBy(desc(longSessions.startedAt))
      .limit(1);
    const row = rows[0];
    return row ? this.toSnapshot(row) : null;
  }

  async listRunningSessions(): Promise<LongSessionSnapshot[]> {
    const rows = await db.select().from(longSessions).where(eq(longSessions.status, 'running')).orderBy(asc(longSessions.startedAt));
    return rows.map((r) => this.toSnapshot(r));
  }

  async next(longSessionId: string): Promise<LongSessionBlock | null> {
    const runningRows = await db
      .select()
      .from(longSessionBlocks)
      .where(and(eq(longSessionBlocks.longSessionId, longSessionId), eq(longSessionBlocks.state, 'running')))
      .orderBy(asc(longSessionBlocks.seq))
      .limit(1);
    const existingRunning = runningRows[0];
    if (existingRunning) {
      await db
        .update(longSessions)
        .set({
          currentBlockId: existingRunning.id,
          updatedAt: new Date()
        })
        .where(eq(longSessions.id, longSessionId));
      return this.toBlock(existingRunning);
    }

    const claimedId = await db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        SELECT id
        FROM ${longSessionBlocks}
        WHERE long_session_id = ${longSessionId} AND state = 'queued'
        ORDER BY seq ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);
      const selectedId = String(rows.rows?.[0]?.id ?? '');
      if (!selectedId) return null;

      await tx
        .update(longSessionBlocks)
        .set({ state: 'running', startedAt: new Date() })
        .where(eq(longSessionBlocks.id, selectedId));

      await tx
        .update(longSessions)
        .set({
          currentBlockId: selectedId,
          updatedAt: new Date(),
          version: sql`${longSessions.version} + 1`
        })
        .where(eq(longSessions.id, longSessionId));

      return selectedId;
    });

    if (!claimedId) return null;
    const row = await this.getBlock(claimedId);
    return row;
  }

  async completeBlock(input: {
    longSessionId: string;
    blockId: string;
    state: Exclude<LongSessionBlockState, 'queued' | 'running'>;
    result?: Record<string, unknown>;
    elapsedDeltaSec?: number;
    recapText?: string;
  }): Promise<LongSessionSnapshot> {
    const block = await this.getBlock(input.blockId);
    if (!block) throw new Error('Long session block not found');

    if (block.state !== 'running' && block.state !== 'queued') {
      const snapshot = await this.get(input.longSessionId);
      if (!snapshot) throw new Error('Long session not found');
      return snapshot;
    }

    const existingRows = await db
      .select()
      .from(longSessions)
      .where(eq(longSessions.id, input.longSessionId))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) throw new Error('Long session not found');

    await db
      .update(longSessionBlocks)
      .set({
        state: input.state,
        resultJson: input.result,
        completedAt: new Date()
      })
      .where(eq(longSessionBlocks.id, input.blockId));

    const elapsedSec = Math.max(existing.elapsedSec + (input.elapsedDeltaSec ?? 0), 0);
    const metadata = this.parseMetadata(existing.metadataJson);
    metadata.lastCheckpointTs = new Date().toISOString();

    if (input.state === 'failed') {
      metadata.consecutiveFailures = (metadata.consecutiveFailures ?? 0) + 1;
    } else {
      metadata.consecutiveFailures = 0;
    }

    this.updateServedMetadata(metadata, input.result, block);

    const shouldComplete = elapsedSec >= existing.targetDurationSec || (metadata.consecutiveFailures ?? 0) >= 3;

    await db
      .update(longSessions)
      .set({
        elapsedSec,
        phase: block.payload.phase ?? existing.phase,
        metadataJson: metadata as Record<string, unknown>,
        currentBlockId: null,
        updatedAt: new Date(),
        version: sql`${longSessions.version} + 1`,
        ...(shouldComplete
          ? {
              status: 'completed' as const,
              endedAt: new Date(),
              endReason: elapsedSec >= existing.targetDurationSec ? 'target_duration_reached' : 'consecutive_block_failures'
            }
          : {})
      })
      .where(eq(longSessions.id, input.longSessionId));

    const summaryText = input.recapText ?? (block.blockType === 'recap' ? String(input.result?.spokenText ?? '').trim() : '');
    if (summaryText) {
      const { keyPoints, openLoops } = this.extractSummaryFields(summaryText);
      await this.writeSummary(input.longSessionId, summaryText, keyPoints, openLoops);
    }

    await this.recordEvent(input.longSessionId, 'block_completed', {
      blockId: input.blockId,
      seq: block.seq,
      blockType: block.blockType,
      state: input.state,
      elapsedSec
    });

    const latestRows = await db
      .select()
      .from(longSessions)
      .where(eq(longSessions.id, input.longSessionId))
      .limit(1);
    const latest = latestRows[0];
    if (!latest) throw new Error('Long session update failed');

    const snapshot = this.toSnapshot(latest);

    if (snapshot.status === 'running') {
      await this.maybeEnqueueRecap(snapshot.longSessionId);
      await this.ensureModeLoopBlocks(snapshot);
    }

    return snapshot;
  }

  async stop(longSessionId: string, reason = 'user_stop'): Promise<LongSessionSnapshot | null> {
    const existingRows = await db.select().from(longSessions).where(eq(longSessions.id, longSessionId)).limit(1);
    const existing = existingRows[0];
    if (!existing) return null;

    await db
      .update(longSessions)
      .set({
        status: 'stopped',
        endedAt: new Date(),
        endReason: reason,
        updatedAt: new Date(),
        version: sql`${longSessions.version} + 1`
      })
      .where(eq(longSessions.id, longSessionId));

    await this.recordEvent(longSessionId, 'session_stopped', { reason });

    const latestRows = await db.select().from(longSessions).where(eq(longSessions.id, longSessionId)).limit(1);
    const latest = latestRows[0];
    return latest ? this.toSnapshot(latest) : null;
  }

  async resume(longSessionId: string): Promise<{ session: LongSessionSnapshot; nextBlock: LongSessionBlock | null } | null> {
    const existingRows = await db.select().from(longSessions).where(eq(longSessions.id, longSessionId)).limit(1);
    const existing = existingRows[0];
    if (!existing) return null;

    await db
      .update(longSessionBlocks)
      .set({ state: 'failed', completedAt: new Date(), resultJson: { reason: 'stale_running_on_resume' } })
      .where(and(eq(longSessionBlocks.longSessionId, longSessionId), eq(longSessionBlocks.state, 'running')));

    await db
      .update(longSessions)
      .set({ status: 'running', updatedAt: new Date(), version: sql`${longSessions.version} + 1` })
      .where(eq(longSessions.id, longSessionId));

    await this.recordEvent(longSessionId, 'session_resumed', { reason: 'manual_resume' });
    await this.maybeEnqueueRecoveryRecap(longSessionId, 'Resuming from previous checkpoint.');

    const nextBlock = await this.next(longSessionId);
    const latestRows = await db.select().from(longSessions).where(eq(longSessions.id, longSessionId)).limit(1);
    const latest = latestRows[0];
    if (!latest) return null;

    return { session: this.toSnapshot(latest), nextBlock };
  }

  async recoverStaleRunningBlocks(staleAfterMs = 45_000): Promise<{ sessionsRecovered: number; blocksFailed: number }> {
    const now = Date.now();
    const staleBefore = new Date(now - staleAfterMs);

    const runningSessions = await db
      .select()
      .from(longSessions)
      .where(eq(longSessions.status, 'running'));

    let sessionsRecovered = 0;
    let blocksFailed = 0;

    for (const session of runningSessions) {
      const staleBlocks = await db
        .select()
        .from(longSessionBlocks)
        .where(
          and(
            eq(longSessionBlocks.longSessionId, session.id),
            eq(longSessionBlocks.state, 'running'),
            lte(longSessionBlocks.startedAt, staleBefore)
          )
        );

      if (staleBlocks.length === 0) continue;

      sessionsRecovered += 1;
      blocksFailed += staleBlocks.length;

      for (const stale of staleBlocks) {
        await db
          .update(longSessionBlocks)
          .set({
            state: 'failed',
            completedAt: new Date(),
            resultJson: { reason: 'stale_after_restart' }
          })
          .where(eq(longSessionBlocks.id, stale.id));

        await this.recordEvent(session.id, 'recovered_block_failed', {
          blockId: stale.id,
          seq: stale.seq,
          reason: 'stale_after_restart'
        });
      }

      await this.maybeEnqueueRecoveryRecap(session.id, 'Pichla hissa ruk gaya tha, hum yahin se aage badhte hain.');
      await this.recordEvent(session.id, 'recovered_session', {
        staleBlocks: staleBlocks.length,
        staleAfterMs
      });
    }

    return { sessionsRecovered, blocksFailed };
  }

  async listSummaries(longSessionId: string): Promise<Array<{
    seq: number;
    summaryText: string;
    keyPoints: string[];
    openLoops: string[];
    createdAt: Date;
  }>> {
    const rows = await db
      .select()
      .from(longSessionSummaries)
      .where(eq(longSessionSummaries.longSessionId, longSessionId))
      .orderBy(asc(longSessionSummaries.seq));

    return rows.map((r) => ({
      seq: r.seq,
      summaryText: r.summaryText,
      keyPoints: Array.isArray(r.keyPointsJson) ? r.keyPointsJson.map(String) : [],
      openLoops: Array.isArray(r.openLoopsJson) ? r.openLoopsJson.map(String) : [],
      createdAt: r.createdAt
    }));
  }

  async maybeEnqueueRecap(longSessionId: string): Promise<void> {
    const sessionRows = await db.select().from(longSessions).where(eq(longSessions.id, longSessionId)).limit(1);
    const session = sessionRows[0];
    // Satsang has its own progression cadence; generic recap insertion causes unnecessary detours.
    if (session?.mode === 'satsang_long') return;

    const doneCountRow = await db
      .select({ count: sql<number>`count(*)` })
      .from(longSessionBlocks)
      .where(
        and(
          eq(longSessionBlocks.longSessionId, longSessionId),
          eq(longSessionBlocks.state, 'done'),
          sql`${longSessionBlocks.blockType} <> 'recap'`
        )
      );

    const doneCount = Number(doneCountRow[0]?.count ?? 0);
    if (doneCount === 0 || doneCount % 3 !== 0) return;

    const queuedRows = await db
      .select()
      .from(longSessionBlocks)
      .where(and(eq(longSessionBlocks.longSessionId, longSessionId), eq(longSessionBlocks.state, 'queued')))
      .orderBy(asc(longSessionBlocks.seq))
      .limit(1);
    const queued = queuedRows[0];
    if (queued && queued.blockType === 'recap') return;

    const seq = await this.nextSeq(longSessionId);
    await this.enqueueBlocks(
      longSessionId,
      [
        {
          type: 'recap',
          durationHintSec: 25,
          contentSource: 'generated',
          completionPolicy: 'auto',
          interruptPolicy: 'resume',
          phase: 'recap',
          maxWords: 80,
          prompt: 'Recap the key points so far in 3 concise lines and include one open question to continue.'
        }
      ],
      seq
    );
  }

  async enqueueRecoveryRecap(longSessionId: string, promptText: string): Promise<void> {
    await this.maybeEnqueueRecoveryRecap(longSessionId, promptText);
  }

  private async maybeEnqueueRecoveryRecap(longSessionId: string, promptText: string): Promise<void> {
    const queuedRows = await db
      .select()
      .from(longSessionBlocks)
      .where(and(eq(longSessionBlocks.longSessionId, longSessionId), eq(longSessionBlocks.state, 'queued')))
      .orderBy(asc(longSessionBlocks.seq))
      .limit(1);

    if (queuedRows[0]?.blockType === 'recap') return;

    const seq = await this.nextSeq(longSessionId);
    await this.enqueueBlocks(
      longSessionId,
      [
        {
          type: 'recap',
          durationHintSec: 20,
          contentSource: 'fixed',
          completionPolicy: 'auto',
          interruptPolicy: 'resume',
          phase: 'recap',
          fixedText: promptText
        }
      ],
      seq
    );
    await this.recordEvent(longSessionId, 'fallback_recap_enqueued', { reason: 'recovery' });
  }

  async ensureModeLoopBlocks(session: LongSessionSnapshot): Promise<void> {
    const queuedRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(longSessionBlocks)
      .where(and(eq(longSessionBlocks.longSessionId, session.longSessionId), eq(longSessionBlocks.state, 'queued')));

    const queuedCount = Number(queuedRows[0]?.count ?? 0);
    if (queuedCount > 0) return;

    const rows = await db.select().from(longSessions).where(eq(longSessions.id, session.longSessionId)).limit(1);
    const row = rows[0];
    if (!row) return;
    const metadata = this.parseMetadata(row.metadataJson);

    if (session.mode === 'satsang_long') {
      const satsang = metadata.satsang ?? {
        paceMode: 'interactive',
        targetShlokaCount: 3,
        completedShlokas: 0
      };
      if (satsang.completedShlokas >= satsang.targetShlokaCount) {
        const seq = await this.nextSeq(session.longSessionId);
        await this.enqueueBlocks(
          session.longSessionId,
          [
            {
              type: 'speak_text',
              durationHintSec: 25,
              language: session.language,
              contentSource: 'generated',
              completionPolicy: 'auto',
              interruptPolicy: 'resume',
              phase: 'sankalp',
              maxWords: 80,
              prompt: 'Satsang closing sankalp dein: aaj seekhe gaye shlokon ka ek daily practice sankalp.'
            },
            {
              type: 'close',
              durationHintSec: 20,
              language: session.language,
              contentSource: 'generated',
              completionPolicy: 'auto',
              interruptPolicy: 'skip',
              phase: 'close',
              maxWords: 70,
              prompt: 'Satsang close with blessing and ask if user wants to continue same adhyaay next session.'
            }
          ],
          seq
        );
        return;
      }
    }

    const remainingSec = Math.max(session.targetDurationSec - session.elapsedSec, 0);
    if (remainingSec <= 0) return;

    if (remainingSec <= 90) {
      const seq = await this.nextSeq(session.longSessionId);
      await this.enqueueBlocks(
        session.longSessionId,
        [
          {
            type: 'close',
            durationHintSec: 25,
            language: session.language,
            contentSource: 'generated',
            completionPolicy: 'auto',
            interruptPolicy: 'skip',
            phase: 'close',
            maxWords: 80,
            prompt: 'Close this session warmly with one concise takeaway and invitation to continue later.'
          }
        ],
        seq
      );
      return;
    }

    const blocks = this.buildContinuationBlocks(session, metadata);
    const seq = await this.nextSeq(session.longSessionId);
    await this.enqueueBlocks(session.longSessionId, blocks, seq);
  }

  private buildInitialTemplateBlocks(input: {
    mode: LongSessionMode;
    topic?: string;
    language: string;
    metadata: SessionMetadata;
  }): LongSessionBlockPayload[] {
    if (input.mode === 'companion_long') {
      return [
        {
          type: 'speak_text',
          durationHintSec: 28,
          language: input.language,
          contentSource: 'generated',
          completionPolicy: 'auto',
          interruptPolicy: 'restart',
          phase: 'opening',
          maxWords: 95,
          prompt: `Start a warm long companion session${input.topic ? ` about ${input.topic}` : ''}. Keep it intimate, calm, and under 95 words.`
        },
        {
          type: 'ask_user',
          durationHintSec: 20,
          language: input.language,
          contentSource: 'fixed',
          completionPolicy: 'needs_user_input',
          interruptPolicy: 'resume',
          phase: 'checkin',
          fixedText: 'Aaj aap kis baat par aaraam se baat karna chahenge?'
        },
        {
          type: 'speak_text',
          durationHintSec: 40,
          language: input.language,
          contentSource: 'generated',
          completionPolicy: 'auto',
          interruptPolicy: 'resume',
          phase: 'topic_expand',
          maxWords: 120,
          prompt: 'Expand the topic empathetically with one real-life example and one practical thought.'
        },
        {
          type: 'speak_text',
          durationHintSec: 30,
          language: input.language,
          contentSource: 'generated',
          completionPolicy: 'auto',
          interruptPolicy: 'resume',
          phase: 'practical_tip',
          maxWords: 95,
          prompt: 'Offer one gentle practical tip and encouragement. Keep it non-medical and emotionally safe.'
        }
      ];
    }

    if (input.mode === 'satsang_long') {
      const satsang = input.metadata.satsang ?? { paceMode: 'interactive', targetShlokaCount: 3, completedShlokas: 0 };
      if (satsang.paceMode === 'continuous') {
        return this.buildSatsangCycleBlocks({
          language: input.language,
          topic: input.topic,
          metadata: input.metadata,
          askQuestion: false,
          includeMiniRecap: false,
          bundleMode: 'continuous',
          includeInvocationLine: true
        });
      }

      return [
        {
          type: 'speak_text',
          durationHintSec: 25,
          language: input.language,
          contentSource: 'generated',
          completionPolicy: 'auto',
          interruptPolicy: 'resume',
          phase: 'invocation',
          maxWords: 90,
          prompt: 'Begin satsang with mangalacharan and set a scripture-centered intention.'
        },
        ...this.buildSatsangCycleBlocks({
          language: input.language,
          topic: input.topic,
          metadata: input.metadata,
          askQuestion: true,
          includeMiniRecap: false,
          bundleMode: 'interactive',
          includeInvocationLine: false
        })
      ];
    }

    return [
      {
        type: 'speak_text',
        durationHintSec: 20,
        language: input.language,
        contentSource: 'generated',
        completionPolicy: 'auto',
        interruptPolicy: 'resume',
        phase: 'setup',
        maxWords: 80,
        prompt: `Begin an immersive Indian story session${input.topic ? ` on ${input.topic}` : ''}. Set tone and characters.`
      },
      {
        type: 'speak_text',
        durationHintSec: 60,
        language: input.language,
        contentSource: 'rag',
        completionPolicy: 'auto',
        interruptPolicy: 'resume',
        phase: 'act1',
        useRetrieval: 'story',
        maxWords: 170,
        prompt: 'Narrate Act 1 from retrieved story source with setting and conflict, not summary.'
      },
      {
        type: 'speak_text',
        durationHintSec: 60,
        language: input.language,
        contentSource: 'generated',
        completionPolicy: 'auto',
        interruptPolicy: 'resume',
        phase: 'act2',
        maxWords: 170,
        prompt: 'Narrate Act 2 with progression and tension while maintaining continuity.'
      },
      {
        type: 'speak_text',
        durationHintSec: 60,
        language: input.language,
        contentSource: 'generated',
        completionPolicy: 'auto',
        interruptPolicy: 'resume',
        phase: 'act3',
        maxWords: 170,
        prompt: 'Narrate Act 3 resolution and emotional closure.'
      },
      {
        type: 'speak_text',
        durationHintSec: 25,
        language: input.language,
        contentSource: 'generated',
        completionPolicy: 'auto',
        interruptPolicy: 'resume',
        phase: 'moral',
        maxWords: 90,
        prompt: 'Give a clear moral and practical life takeaway from the story.'
      },
      {
        type: 'ask_user',
        durationHintSec: 20,
        language: input.language,
        contentSource: 'generated',
        completionPolicy: 'needs_user_input',
        interruptPolicy: 'resume',
        phase: 'reflection',
        maxWords: 60,
        prompt: 'Ask one reflection question from the story and invite response.'
      }
    ];
  }

  private buildContinuationBlocks(session: LongSessionSnapshot, metadata: SessionMetadata): LongSessionBlockPayload[] {
    if (session.mode === 'companion_long') {
      return [
        {
          type: 'speak_text',
          durationHintSec: 35,
          language: session.language,
          contentSource: 'generated',
          completionPolicy: 'auto',
          interruptPolicy: 'resume',
          phase: 'topic_expand',
          maxWords: 120,
          prompt: 'Continue naturally from prior context. Add one concrete relatable example.'
        },
        {
          type: 'speak_text',
          durationHintSec: 25,
          language: session.language,
          contentSource: 'generated',
          completionPolicy: 'auto',
          interruptPolicy: 'resume',
          phase: 'practical_tip',
          maxWords: 95,
          prompt: 'Offer one actionable step the user can do today and ask for comfort level.'
        },
        {
          type: 'ask_user',
          durationHintSec: 20,
          language: session.language,
          contentSource: 'generated',
          completionPolicy: 'needs_user_input',
          interruptPolicy: 'resume',
          phase: 'checkin',
          maxWords: 50,
          prompt: 'Ask one warm check-in question connected to previous points.'
        }
      ];
    }

    if (session.mode === 'satsang_long') {
      const satsang = metadata.satsang ?? { paceMode: 'interactive', targetShlokaCount: 3, completedShlokas: 0 };
      return this.buildSatsangCycleBlocks({
        language: session.language,
        topic: session.topic,
        metadata,
        askQuestion: satsang.paceMode === 'interactive',
        includeMiniRecap: false,
        bundleMode: satsang.paceMode,
        includeInvocationLine: false
      });
    }

    return [
      {
        type: 'speak_text',
        durationHintSec: 60,
        language: session.language,
        contentSource: 'rag',
        completionPolicy: 'auto',
        interruptPolicy: 'resume',
        phase: 'act1',
        useRetrieval: 'story',
        servedIds: metadata.toldStoryIds ?? [],
        maxWords: 170,
        prompt: `Start a different story than previous ones (avoid ids: ${(metadata.toldStoryIds ?? []).slice(-15).join(',') || 'none'}). Narrate Act 1 with details.`
      },
      {
        type: 'speak_text',
        durationHintSec: 60,
        language: session.language,
        contentSource: 'generated',
        completionPolicy: 'auto',
        interruptPolicy: 'resume',
        phase: 'act2',
        maxWords: 170,
        prompt: 'Continue Act 2 with dramatic progression and emotional context.'
      },
      {
        type: 'speak_text',
        durationHintSec: 60,
        language: session.language,
        contentSource: 'generated',
        completionPolicy: 'auto',
        interruptPolicy: 'resume',
        phase: 'act3',
        maxWords: 170,
        prompt: 'Complete Act 3 with resolution and learning.'
      },
      {
        type: 'speak_text',
        durationHintSec: 25,
        language: session.language,
        contentSource: 'generated',
        completionPolicy: 'auto',
        interruptPolicy: 'resume',
        phase: 'moral',
        maxWords: 90,
        prompt: 'Give moral and one practical reflection point.'
      },
      {
        type: 'ask_user',
        durationHintSec: 20,
        language: session.language,
        contentSource: 'generated',
        completionPolicy: 'needs_user_input',
        interruptPolicy: 'resume',
        phase: 'reflection',
        maxWords: 60,
        prompt: 'Ask if user wants next story, deeper explanation, or repeat a part.'
      }
    ];
  }

  private async enqueueBlocks(longSessionId: string, blocks: LongSessionBlockPayload[], startSeq: number): Promise<void> {
    if (blocks.length === 0) return;
    await db.insert(longSessionBlocks).values(
      blocks.map((b, idx) => ({
        longSessionId,
        seq: startSeq + idx,
        blockType: b.type,
        state: 'queued' as const,
        payloadJson: (b as unknown) as Record<string, unknown>
      }))
    );
  }

  private async writeSummary(
    longSessionId: string,
    summaryText: string,
    keyPoints: string[],
    openLoops: string[]
  ): Promise<void> {
    const seqRow = await db
      .select({ max: sql<number>`coalesce(max(${longSessionSummaries.seq}), 0)` })
      .from(longSessionSummaries)
      .where(eq(longSessionSummaries.longSessionId, longSessionId));
    const nextSeq = Number(seqRow[0]?.max ?? 0) + 1;

    await db.insert(longSessionSummaries).values({
      longSessionId,
      seq: nextSeq,
      summaryText,
      keyPointsJson: keyPoints,
      openLoopsJson: openLoops
    });
  }

  private extractSummaryFields(summaryText: string): { keyPoints: string[]; openLoops: string[] } {
    const sentences = summaryText
      .split(/[\n.।!?]+/g)
      .map((s) => s.trim())
      .filter(Boolean);

    const keyPoints = sentences.slice(0, 3);
    const openLoops = sentences.filter((s) => s.includes('?')).slice(0, 2);

    return { keyPoints, openLoops };
  }

  private parseMetadata(value: unknown): SessionMetadata {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const raw = value as Record<string, unknown>;
    return {
      toldStoryIds: Array.isArray(raw.toldStoryIds) ? raw.toldStoryIds.map(String) : [],
      servedPassageIds: Array.isArray(raw.servedPassageIds) ? raw.servedPassageIds.map(String) : [],
      consecutiveFailures: typeof raw.consecutiveFailures === 'number' ? raw.consecutiveFailures : 0,
      lastCheckpointTs: typeof raw.lastCheckpointTs === 'string' ? raw.lastCheckpointTs : undefined,
      satsang:
        raw.satsang && typeof raw.satsang === 'object' && !Array.isArray(raw.satsang)
          ? {
              paceMode: (raw.satsang as Record<string, unknown>).paceMode === 'continuous' ? 'continuous' : 'interactive',
              targetShlokaCount: Math.max(
                2,
                Math.min(8, Number((raw.satsang as Record<string, unknown>).targetShlokaCount ?? 3))
              ),
              completedShlokas: Math.max(
                0,
                Number((raw.satsang as Record<string, unknown>).completedShlokas ?? 0)
              ),
              activeAdhyaay:
                typeof (raw.satsang as Record<string, unknown>).activeAdhyaay === 'string'
                  ? String((raw.satsang as Record<string, unknown>).activeAdhyaay)
                  : undefined,
              ledgerShlokaIds: Array.isArray((raw.satsang as Record<string, unknown>).ledgerShlokaIds)
                ? ((raw.satsang as Record<string, unknown>).ledgerShlokaIds as unknown[]).map(String).filter(Boolean)
                : [],
              ledgerEntries: Array.isArray((raw.satsang as Record<string, unknown>).ledgerEntries)
                ? ((raw.satsang as Record<string, unknown>).ledgerEntries as unknown[])
                    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
                    .map((item) => item as SatsangLedgerEntry)
                : [],
              nextLedgerIndex: Math.max(
                0,
                Number((raw.satsang as Record<string, unknown>).nextLedgerIndex ?? 0)
              ),
              lastCompletedShlokaId:
                typeof (raw.satsang as Record<string, unknown>).lastCompletedShlokaId === 'string'
                  ? String((raw.satsang as Record<string, unknown>).lastCompletedShlokaId)
                  : undefined
            }
          : undefined
    };
  }

  private updateServedMetadata(metadata: SessionMetadata, result: Record<string, unknown> | undefined, block: LongSessionBlock): void {
    const storyId = result && typeof result.storyId === 'string' ? result.storyId : undefined;
    if (storyId) {
      const next = [...(metadata.toldStoryIds ?? []), storyId];
      metadata.toldStoryIds = next.slice(-50);
    }

    const citationId = result && typeof result.citationId === 'string' ? result.citationId : undefined;
    if (citationId) {
      const next = [...(metadata.servedPassageIds ?? []), citationId];
      metadata.servedPassageIds = next.slice(-80);
    }

    if (block.payload.phase === 'shastra_path' && metadata.satsang) {
      const nextCompleted = (metadata.satsang.completedShlokas ?? 0) + 1;
      metadata.satsang.completedShlokas = nextCompleted;
      metadata.satsang.nextLedgerIndex = nextCompleted;

      const shlokaId =
        typeof block.payload.shlokaId === 'string'
          ? block.payload.shlokaId
          : citationId;
      if (shlokaId) {
        metadata.satsang.lastCompletedShlokaId = shlokaId;
        const next = [...(metadata.servedPassageIds ?? []), shlokaId];
        metadata.servedPassageIds = next.slice(-80);
      }
    }
  }

  private buildSatsangCycleBlocks(input: {
    language: string;
    topic?: string;
    metadata: SessionMetadata;
    askQuestion: boolean;
    includeMiniRecap: boolean;
    bundleMode: 'interactive' | 'continuous';
    includeInvocationLine: boolean;
  }): LongSessionBlockPayload[] {
    const satsang = input.metadata.satsang ?? { paceMode: 'interactive', targetShlokaCount: 3, completedShlokas: 0 };
    const ledgerIds = (satsang.ledgerShlokaIds ?? []).filter(Boolean);
    const ledgerEntries = (satsang.ledgerEntries ?? []).filter(Boolean);
    const plannedIds =
      ledgerIds.length > 0
        ? ledgerIds
        : ledgerEntries.map((entry) => entry.id);
    const nextIndex = Math.max(0, Math.min(satsang.nextLedgerIndex ?? satsang.completedShlokas ?? 0, plannedIds.length - 1));
    const shlokaId = plannedIds[nextIndex];
    const shloka =
      shlokaId
        ? (ledgerEntries.find((entry) => entry.id === shlokaId) ?? getSatsangLedgerEntryById(shlokaId))
        : null;

    if (!shloka) {
      return [
        {
          type: 'close',
          durationHintSec: 20,
          language: input.language,
          contentSource: 'generated',
          completionPolicy: 'auto',
          interruptPolicy: 'skip',
          phase: 'close',
          maxWords: 80,
          prompt: 'No shloka available in ledger. Close satsang with blessing and invite user to start fresh topic.'
        }
      ];
    }

    if (input.bundleMode === 'continuous') {
      return [
        {
          type: 'speak_text',
          durationHintSec: 140,
          language: input.language,
          contentSource: 'generated',
          completionPolicy: 'auto',
          interruptPolicy: 'resume',
          phase: 'shastra_path',
          citationRequired: true,
          servedIds: plannedIds,
          shlokaId: shloka.id,
          shlokaReference: shloka.reference,
          shlokaText: shloka.sanskrit,
          arthHint: shloka.arthHint,
          vyakhyaHint: shloka.vyakhyaHint,
          maxWords: 260,
          fixedText: `<shlok>${shloka.sanskrit}</shlok> (${shloka.reference})`,
          prompt: `${
            input.includeInvocationLine
              ? 'Start with one short mangalacharan sentence, then continue naturally. '
              : ''
          }Recite this exact shloka once in Sanskrit with citation ${shloka.reference}. Immediately after that, in the same response, give: (1) saral arth in Hindi in 2-3 lines using this hint: ${shloka.arthHint}; (2) practical vyakhya in 3-4 lines for daily life using this guidance: ${shloka.vyakhyaHint}; (3) one concise daily sankalp line. Do not ask a question. Keep it one cohesive satsang segment.`
        }
      ];
    }

    const blocks: LongSessionBlockPayload[] = [
      {
        type: 'speak_text',
        durationHintSec: 42,
        language: input.language,
        contentSource: 'fixed',
        completionPolicy: 'auto',
        interruptPolicy: 'resume',
        phase: 'shastra_path',
        citationRequired: true,
        servedIds: plannedIds,
        shlokaId: shloka.id,
        shlokaReference: shloka.reference,
        shlokaText: shloka.sanskrit,
        arthHint: shloka.arthHint,
        vyakhyaHint: shloka.vyakhyaHint,
        maxWords: 150,
        fixedText: `<shlok>${shloka.sanskrit}</shlok> (${shloka.reference})`,
        prompt: `Recite exactly this shloka once in Sanskrit and mention its citation ${shloka.reference}. Do not switch to another shloka.`
      },
      {
        type: 'speak_text',
        durationHintSec: 35,
        language: input.language,
        contentSource: 'generated',
        completionPolicy: 'auto',
        interruptPolicy: 'resume',
        phase: 'arth',
        maxWords: 95,
        prompt: `Give saral arth in Hindi for the same shloka (${shloka.reference}) using this hint: ${shloka.arthHint}`
      },
      {
        type: 'speak_text',
        durationHintSec: 50,
        language: input.language,
        contentSource: 'generated',
        completionPolicy: 'auto',
        interruptPolicy: 'resume',
        phase: 'vyakhya',
        maxWords: 145,
        prompt: `Give short practical vyakhya for daily life for this same shloka (${shloka.reference}) using this guidance: ${shloka.vyakhyaHint}`
      }
    ];

    if (input.askQuestion) {
      blocks.push({
        type: 'ask_user',
        durationHintSec: 25,
        language: input.language,
        contentSource: 'generated',
        completionPolicy: 'needs_user_input',
        interruptPolicy: 'resume',
        phase: 'manan',
        maxWords: 60,
        prompt: 'Ask one reflective question for conversation before moving to next shloka.'
      });
    }

    if (input.includeMiniRecap) {
      blocks.push({
        type: 'recap',
        durationHintSec: 20,
        language: input.language,
        contentSource: 'generated',
        completionPolicy: 'auto',
        interruptPolicy: 'resume',
        phase: 'mini_recap',
        maxWords: 70,
        prompt: 'Recap the last 2 shlokas in concise Hindi and transition to the next shloka.'
      });
    }

    return blocks;
  }

  private resolveSatsangConfig(input: LongSessionStartInput): {
    paceMode: 'interactive' | 'continuous';
    targetShlokaCount: number;
    activeAdhyaay?: string;
  } {
    const topic = (input.topic ?? '').trim();
    const parsedCount = this.parseShlokaCount(topic);
    const explicitPace = input.paceMode;
    const inferredPace =
      /continuous|lagatar|लगातार|bina ruk|बिना रुके|non[- ]?stop/i.test(topic) ? 'continuous' : 'interactive';
    const paceMode = explicitPace ?? inferredPace;
    const defaultCount = paceMode === 'continuous' ? 6 : 3;
    const targetShlokaCount = Math.max(2, Math.min(8, input.targetShlokaCount ?? parsedCount ?? defaultCount));
    const activeAdhyaay = this.parseAdhyaay(topic);
    return { paceMode, targetShlokaCount, activeAdhyaay };
  }

  private parseShlokaCount(topic: string): number | undefined {
    const m = topic.match(/(\d{1,2})\s*(?:shloka|shlokas|श्लोक)/i);
    if (!m) return undefined;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : undefined;
  }

  private parseAdhyaay(topic: string): string | undefined {
    const m = topic.match(/(?:adhyaay|adhyay|chapter|अध्याय)\s*([0-9]{1,2})/i);
    if (!m) return undefined;
    return m[1];
  }

  private async recordEvent(longSessionId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
    await db.insert(longSessionEvents).values({
      longSessionId,
      eventType,
      payloadJson: payload
    });
  }

  private async getBlock(blockId: string): Promise<LongSessionBlock | null> {
    const rows = await db.select().from(longSessionBlocks).where(eq(longSessionBlocks.id, blockId)).limit(1);
    const row = rows[0];
    return row ? this.toBlock(row) : null;
  }

  private async nextSeq(longSessionId: string): Promise<number> {
    const maxSeqRow = await db
      .select({ max: sql<number>`coalesce(max(${longSessionBlocks.seq}), 0)` })
      .from(longSessionBlocks)
      .where(eq(longSessionBlocks.longSessionId, longSessionId));

    return Number(maxSeqRow[0]?.max ?? 0) + 1;
  }

  private async canResumeExisting(
    existing: LongSessionSnapshot,
    input: LongSessionStartInput
  ): Promise<{ canResume: true } | { canResume: false; reason: string }> {
    if (existing.mode !== input.mode) {
      return { canResume: false, reason: 'superseded_by_new_mode_start' };
    }

    const requestedTopic = this.normalizeTopic(input.topic);
    const existingTopic = this.normalizeTopic(existing.topic);
    if (requestedTopic && existingTopic && requestedTopic !== existingTopic) {
      return { canResume: false, reason: 'superseded_by_topic_change_start' };
    }
    if (requestedTopic && !existingTopic) {
      return { canResume: false, reason: 'superseded_by_topic_specified_start' };
    }

    const rows = await db
      .select({ updatedAt: longSessions.updatedAt })
      .from(longSessions)
      .where(eq(longSessions.id, existing.longSessionId))
      .limit(1);
    const updatedAt = rows[0]?.updatedAt;
    if (!updatedAt) return { canResume: false, reason: 'superseded_by_resume_lookup_failure' };

    const idleMs = Date.now() - updatedAt.getTime();
    if (idleMs > SessionDirectorService.RESUME_MAX_IDLE_MS) {
      await this.recordEvent(existing.longSessionId, 'resume_rejected_stale', {
        idleMs,
        thresholdMs: SessionDirectorService.RESUME_MAX_IDLE_MS
      });
      return { canResume: false, reason: 'superseded_by_stale_running_session' };
    }

    return { canResume: true };
  }

  private normalizeTopic(topic: string | undefined): string | undefined {
    if (!topic) return undefined;
    const normalized = topic.trim().toLowerCase().replace(/\s+/g, ' ');
    return normalized.length > 0 ? normalized : undefined;
  }

  private initialPhaseForMode(mode: LongSessionMode): string {
    if (mode === 'companion_long') return 'opening';
    if (mode === 'satsang_long') return 'invocation';
    return 'setup';
  }

  private defaultBlockPayload(type: LongSessionBlockType): LongSessionBlockPayload {
    return {
      type,
      durationHintSec: 20,
      contentSource: 'fixed',
      completionPolicy: 'auto',
      interruptPolicy: 'resume'
    };
  }

  private toBlock(row: typeof longSessionBlocks.$inferSelect): LongSessionBlock {
    return {
      id: row.id,
      longSessionId: row.longSessionId,
      seq: row.seq,
      blockType: row.blockType as LongSessionBlockType,
      state: row.state as LongSessionBlockState,
      payload: ((row.payloadJson as unknown) as LongSessionBlockPayload) ?? this.defaultBlockPayload(row.blockType as LongSessionBlockType)
    };
  }

  private toSnapshot(row: typeof longSessions.$inferSelect): LongSessionSnapshot {
    const metadata = this.parseMetadata(row.metadataJson);
    const remainingSec = Math.max(row.targetDurationSec - row.elapsedSec, 0);
    return {
      longSessionId: row.id,
      userId: row.userId,
      mode: row.mode as LongSessionMode,
      status: row.status as LongSessionStatus,
      phase: row.phase,
      targetDurationSec: row.targetDurationSec,
      elapsedSec: row.elapsedSec,
      topic: row.topic ?? undefined,
      language: row.language,
      currentBlockId: row.currentBlockId,
      version: row.version,
      metadata,
      remainingSec,
      lastCheckpointTs: metadata.lastCheckpointTs
    };
  }
}
