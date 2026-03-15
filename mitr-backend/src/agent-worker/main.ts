import {
  type JobContext,
  ServerOptions,
  cli,
  defineAgent,
  llm,
  metrics,
  voice
} from '@livekit/agents';
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
  type LocalParticipant
} from '@livekit/rtc-node';
import dotenv from 'dotenv';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { ReligiousRetriever } from '../services/retrieval/religious-retriever.js';
import { Mem0Service } from '../services/memory/mem0-service.js';
import { ReminderService } from '../services/reminders/reminder-service.js';
import { NewsService } from '../services/news/news-service.js';
import { CompanionService } from '../services/companion/companion-service.js';
import { DiaryService } from '../services/companion/diary-service.js';
import { YoutubeStreamService } from '../services/media/youtube-stream-service.js';
import { SessionDirectorService } from '../services/long-session/session-director-service.js';
import { GeocodingService } from '../services/location/geocoding-service.js';
import { PanchangService } from '../services/panchang/panchang-service.js';
import { WebSearchService } from '../services/web/web-search-service.js';
import { ConversationService } from '../services/conversations/conversation-service.js';
import { UserTranscriptService } from '../services/conversations/user-transcript-service.js';
import { NudgesService } from '../services/nudges/nudges-service.js';
import {
  AgentToolContext,
  AgentToolDefinition,
  ToolDeps,
  createToolDefinitions
} from '../services/agent/tools.js';
import { BackgroundVoiceCancellation } from '@livekit/noise-cancellation-node';
import { AsyncFollowupManager } from './async-followup-manager.js';
import { buildSystemPrompt } from './agent.js';
import { createVoiceSession, prewarmVoicePipeline, validateVoicePipeline } from './pipelines/index.js';

dotenv.config({ path: '.env.local' });

type DispatchMetadata = {
  user_id?: string;
  language?: string;
  profile_answers?: Record<string, string> | null;
  [key: string]: unknown;
};

type FlowType = 'satsang' | 'story' | 'companion';
const FLOW_STATE_TOPIC = 'mitr.flow_state';
const TOOL_EVENT_TOPIC = 'mitr.tool_event';
const NEWS_AUTO_FOLLOWUP_DELAY_MS = 300;
const NUDGE_PLAYBACK_STATUS_TIMEOUT_MS = 20000;
const NUDGE_PLAYBACK_MAX_ATTEMPTS = 2;
const AMBIENCE_SAMPLE_RATE = 48000;
const AMBIENCE_CHANNELS = 2;
const AMBIENCE_FRAME_MS = 20;
const AMBIENCE_VOLUME_GAIN = 0.6;
const AMBIENCE_SAMPLES_PER_FRAME = (AMBIENCE_SAMPLE_RATE / 1000) * AMBIENCE_FRAME_MS;
const AMBIENCE_BYTES_PER_FRAME = AMBIENCE_SAMPLES_PER_FRAME * AMBIENCE_CHANNELS * 2;
const AMBIENCE_PREBUFFER_MS = 600;
const AMBIENCE_PREBUFFER_BYTES = (AMBIENCE_SAMPLE_RATE / 1000) * AMBIENCE_PREBUFFER_MS * AMBIENCE_CHANNELS * 2;
const AMBIENCE_TRACK_PATHS = [
  resolve(process.cwd(), 'tools/web-sim/assets/ambience/birds_rain_woods.mp3'),
  resolve(process.cwd(), 'tools/web-sim/assets/ambience/rain_light.ogg'),
  resolve(process.cwd(), 'tools/web-sim/assets/ambience/water_on_rocks.ogg'),
  resolve(process.cwd(), 'tools/web-sim/assets/ambience/rain_woods_0757.mp3')
];

class SatsangAmbiencePublisher {
  private source: AudioSource | null = null;
  private track: LocalAudioTrack | null = null;
  private trackSid: string | null = null;
  private ffmpeg: ChildProcess | null = null;
  private frameTimer: NodeJS.Timeout | null = null;
  private pcmBuffer = Buffer.alloc(0);
  private running = false;
  private lastTrackPath: string | null = null;
  private ambiencePrimed = false;
  private lastFrameBytes = Buffer.alloc(AMBIENCE_BYTES_PER_FRAME);

  constructor(
    private readonly participant: LocalParticipant,
    private readonly sessionId: string
  ) {}

  private pickTrackPath(): string | null {
    const available = AMBIENCE_TRACK_PATHS.filter((path) => existsSync(path));
    if (available.length === 0) return null;
    if (available.length === 1) return available[0] ?? null;
    const filtered = available.filter((path) => path !== this.lastTrackPath);
    const pool = filtered.length > 0 ? filtered : available;
    const next = pool[Math.floor(Math.random() * pool.length)];
    return next ?? null;
  }

  private spawnDecoder(trackPath: string): void {
    const cmd = 'ffmpeg';
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-stream_loop',
      '-1',
      '-i',
      trackPath,
      '-vn',
      '-filter:a',
      `volume=${AMBIENCE_VOLUME_GAIN}`,
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      '-ac',
      String(AMBIENCE_CHANNELS),
      '-ar',
      String(AMBIENCE_SAMPLE_RATE),
      'pipe:1'
    ];

    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.ffmpeg = proc;
    this.pcmBuffer = Buffer.alloc(0);
    this.ambiencePrimed = false;
    this.lastFrameBytes = Buffer.alloc(AMBIENCE_BYTES_PER_FRAME);

    proc.stdout.on('data', (chunk: Buffer) => {
      if (!this.running) return;
      if (this.pcmBuffer.length === 0) {
        this.pcmBuffer = Buffer.from(chunk);
      } else {
        this.pcmBuffer = Buffer.concat([this.pcmBuffer, chunk]);
      }
      const maxBuffered = AMBIENCE_BYTES_PER_FRAME * 300;
      if (this.pcmBuffer.length > maxBuffered) {
        this.pcmBuffer = this.pcmBuffer.subarray(this.pcmBuffer.length - maxBuffered);
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (!text) return;
      logger.warn('Ambience ffmpeg stderr', {
        sessionId: this.sessionId,
        detail: text
      });
    });

    proc.on('error', (error) => {
      logger.error('Failed to start ambience ffmpeg process', {
        sessionId: this.sessionId,
        error: (error as Error).message
      });
    });

    proc.on('exit', (code, signal) => {
      if (!this.running) return;
      logger.warn('Ambience ffmpeg exited; restarting decoder', {
        sessionId: this.sessionId,
        code,
        signal
      });
      const next = this.pickTrackPath();
      if (!next) return;
      this.lastTrackPath = next;
      this.spawnDecoder(next);
    });
  }

  private startFramePump(): void {
    if (this.frameTimer) return;
    this.frameTimer = setInterval(() => {
      if (!this.running || !this.source) return;
      if (!this.ambiencePrimed) {
        if (this.pcmBuffer.length < AMBIENCE_PREBUFFER_BYTES) return;
        this.ambiencePrimed = true;
      }
      let frameBytes: Buffer;
      if (this.pcmBuffer.length >= AMBIENCE_BYTES_PER_FRAME) {
        frameBytes = this.pcmBuffer.subarray(0, AMBIENCE_BYTES_PER_FRAME);
        this.pcmBuffer = this.pcmBuffer.subarray(AMBIENCE_BYTES_PER_FRAME);
        this.lastFrameBytes = Buffer.from(frameBytes);
      } else {
        frameBytes = this.lastFrameBytes;
      }

      const samples = new Int16Array(
        frameBytes.buffer,
        frameBytes.byteOffset,
        AMBIENCE_SAMPLES_PER_FRAME * AMBIENCE_CHANNELS
      );
      const frame = new AudioFrame(samples, AMBIENCE_SAMPLE_RATE, AMBIENCE_CHANNELS, AMBIENCE_SAMPLES_PER_FRAME);
      void this.source.captureFrame(frame).catch((error) => {
        logger.debug('Ambience frame capture failed', {
          sessionId: this.sessionId,
          error: (error as Error).message
        });
      });
    }, AMBIENCE_FRAME_MS);
  }

  async start(): Promise<void> {
    if (this.running) return;
    const trackPath = this.pickTrackPath();
    if (!trackPath) {
      logger.warn('No ambience tracks found on disk', {
        sessionId: this.sessionId
      });
      return;
    }

    this.running = true;
    this.lastTrackPath = trackPath;
    this.source = new AudioSource(AMBIENCE_SAMPLE_RATE, AMBIENCE_CHANNELS, 1000);
    this.track = LocalAudioTrack.createAudioTrack('mitr-satsang-ambience', this.source);
    const publication = await this.participant.publishTrack(
      this.track,
      new TrackPublishOptions({
      source: TrackSource.SOURCE_SCREENSHARE_AUDIO,
      stream: 'mitr-satsang-ambience'
      })
    );
    this.trackSid = publication.sid ?? null;
    this.spawnDecoder(trackPath);
    this.startFramePump();
    logger.info('Satsang ambience track started', {
      sessionId: this.sessionId,
      trackSid: this.trackSid,
      trackPath
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.frameTimer) {
      clearInterval(this.frameTimer);
      this.frameTimer = null;
    }
    this.ambiencePrimed = false;
    this.lastFrameBytes = Buffer.alloc(AMBIENCE_BYTES_PER_FRAME);

    if (this.ffmpeg) {
      try {
        this.ffmpeg.kill('SIGTERM');
      } catch {}
      this.ffmpeg = null;
    }

    if (this.trackSid) {
      try {
        await this.participant.unpublishTrack(this.trackSid, true);
      } catch (error) {
        logger.warn('Failed to unpublish ambience track', {
          sessionId: this.sessionId,
          trackSid: this.trackSid,
          error: (error as Error).message
        });
      }
      this.trackSid = null;
    }

    if (this.track) {
      try {
        await this.track.close(false);
      } catch {}
      this.track = null;
    }

    if (this.source) {
      try {
        await this.source.close();
      } catch {}
      this.source = null;
    }

    this.pcmBuffer = Buffer.alloc(0);
    logger.info('Satsang ambience track stopped', {
      sessionId: this.sessionId
    });
  }
}

const sanitizeForLog = (payload: unknown): unknown => {
  if (payload === null || payload === undefined) return payload;
  const asString = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (asString.length <= 500) return payload;
  return `${asString.slice(0, 500)}...`;
};

const parseDispatchMetadata = (raw: string | undefined): DispatchMetadata => {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as DispatchMetadata;
    if (parsed && typeof parsed === 'object') return parsed;
    return {};
  } catch {
    return {};
  }
};

type WebItemForFollowup = {
  title: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: string;
};

const asNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const truncate = (value: string, max: number): string => {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
};

const toNewsSummariesForFollowup = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'string') return truncate(entry.trim(), 520);
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return '';
      const summary = asNonEmptyString((entry as Record<string, unknown>).summary);
      return summary ? truncate(summary, 520) : '';
    })
    .filter((entry) => entry.length > 0)
    .slice(0, 5);
};

const toWebItemsForFollowup = (value: unknown): WebItemForFollowup[] => {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 5)
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const item = entry as Record<string, unknown>;
      return {
        title: asNonEmptyString(item.title) ?? '',
        summary: truncate(asNonEmptyString(item.summary) ?? '', 420),
        source: asNonEmptyString(item.source) ?? '',
        url: asNonEmptyString(item.url) ?? '',
        publishedAt: asNonEmptyString(item.publishedAt) ?? ''
      };
    })
    .filter((item): item is WebItemForFollowup => item !== null);
};

type CitationForFollowup = {
  title: string;
  source: string;
  passage: string;
  tradition: string | undefined;
};

type StoryForFollowup = {
  title: string;
  source: string;
  passage: string;
  moral: string | undefined;
};

type QueuedNudgePlayback = {
  type: string;
  requestId: string;
  sourceTool: string;
  payload: Record<string, unknown>;
  attempts: number;
};

type NudgePlaybackStatusPacket = {
  type: 'nudge_voice_playback_status';
  requestId?: string;
  nudgeId?: string;
  status?: 'started' | 'ended' | 'failed';
};

type TurnLatencyTrace = {
  turnId: number;
  startedAt: number;
  transcriptChars: number;
  userSpeechStoppedAt: number | null;
  sttFinalizeMs: number | null;
  speechCreatedAt: number | null;
  thinkingAt: number | null;
  firstToolStartAt: number | null;
  firstToolEndAt: number | null;
  toolCount: number;
  toolNames: string[];
  totalToolMs: number;
  firstAssistantTextAt: number | null;
  firstAudioAt: number | null;
  firstMetricsAt: number | null;
  modelTtftMs: number | null;
  closed: boolean;
};

const toCitationsForFollowup = (value: unknown): CitationForFollowup[] => {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 4)
    .map((entry) => {
      const item = asRecord(entry);
      if (!item) return null;
      return {
        title: asNonEmptyString(item.title) ?? 'Unknown',
        source: asNonEmptyString(item.source) ?? 'Unknown',
        passage: truncate(asNonEmptyString(item.passage) ?? '', 420),
        tradition: asNonEmptyString(item.tradition)
      };
    })
    .filter((item): item is CitationForFollowup => item !== null);
};

const toStoriesForFollowup = (value: unknown): StoryForFollowup[] => {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 3)
    .map((entry) => {
      const item = asRecord(entry);
      if (!item) return null;
      return {
        title: asNonEmptyString(item.title) ?? 'Unknown',
        source: asNonEmptyString(item.source) ?? 'Unknown',
        passage: truncate(asNonEmptyString(item.passage) ?? '', 520),
        moral: asNonEmptyString(item.moral)
      };
    })
    .filter((item): item is StoryForFollowup => item !== null);
};

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms (${label})`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const toLivekitTool = <TSchema extends z.ZodTypeAny>(
  definition: AgentToolDefinition<TSchema>,
  context: AgentToolContext
)=>
  llm.tool({
    description: definition.description,
    parameters: definition.parameters,
    execute: async (input: z.infer<TSchema>) => {
      const startedAt = Date.now();
      context.onToolExecutionStart?.({
        name: definition.name,
        startedAt,
        payload: input
      });
      logger.info('Agent tool event', {
        sessionId: context.sessionId,
        userId: context.userId,
        name: definition.name,
        status: 'start',
        payload: sanitizeForLog(input)
      });
      try {
        const result = await withTimeout(
          definition.execute(input, context),
          definition.timeoutMs,
          definition.name
        );
        const endedAt = Date.now();
        context.onToolExecutionEnd?.({
          name: definition.name,
          startedAt,
          endedAt,
          ok: true
        });
        logger.info('Agent tool event', {
          sessionId: context.sessionId,
          userId: context.userId,
          name: definition.name,
          status: 'end',
          elapsedMs: endedAt - startedAt,
          payload: sanitizeForLog(result)
        });
        return { ok: true, result };
      } catch (error) {
        const message = (error as Error).message;
        const endedAt = Date.now();
        context.onToolExecutionEnd?.({
          name: definition.name,
          startedAt,
          endedAt,
          ok: false,
          error: message
        });
        logger.warn('Agent tool event', {
          sessionId: context.sessionId,
          userId: context.userId,
          name: definition.name,
          status: 'end',
          elapsedMs: endedAt - startedAt,
          payload: { ok: false, error: message }
        });
        return { ok: false, error: message };
      }
    }
  });

const buildToolMap = (
  definitions: AgentToolDefinition[],
  context: AgentToolContext
): Record<string, unknown> => {
  const entries = definitions.map((definition) => [
    definition.name,
    toLivekitTool(definition, context)
  ] as const);
  return Object.fromEntries(entries);
};

const buildToolDeps = (): ToolDeps => {
  const reminderService = new ReminderService();
  const religiousRetriever = new ReligiousRetriever();
  const youtubeStreamService = new YoutubeStreamService();
  const sessionDirector = new SessionDirectorService();
  const geocodingService = new GeocodingService();

  return {
    religiousRetriever,
    mem0: new Mem0Service(),
    reminderService,
    newsService: new NewsService(),
    companionService: new CompanionService(reminderService),
    diaryService: new DiaryService(),
    sessionDirector,
    youtubeStreamService,
    panchangService: new PanchangService(geocodingService),
    webSearchService: new WebSearchService(),
    nudgesService: new NudgesService()
  };
};

export default defineAgent({
  prewarm: async (proc) => {
    await prewarmVoicePipeline({
      env,
      logger,
      proc
    });
  },
  entry: async (ctx: JobContext) => {
    const metadata = parseDispatchMetadata((ctx.job as { metadata?: string }).metadata);
    const participantIdentity = (ctx.job as { participant?: { identity?: string } }).participant?.identity;
    const userId = metadata.user_id ?? participantIdentity ?? 'anonymous-user';
    const language = metadata.language ?? 'hi-IN';
    validateVoicePipeline({
      env,
      logger,
      language,
      ctx
    });
    const roomNameFromJob = (ctx.job as { room?: { name?: string } }).room?.name;
    const roomName = roomNameFromJob ?? (ctx.room as { name?: string } | undefined)?.name ?? 'unknown-room';
    const sessionId = `${roomName}:${userId}`;
    let lastFinalTranscript: string | null = null;
    const MAX_AUTO_ADVANCE_TURNS = 6;
    const autoFlowState: {
      flowId: string | null;
      flowType: FlowType | null;
      loopMode: 'interactive' | 'continuous';
      pendingAutoAdvance: boolean;
      autoTurnsRemaining: number;
    } = {
      flowId: null,
      flowType: null,
      loopMode: 'interactive',
      pendingAutoAdvance: false,
      autoTurnsRemaining: MAX_AUTO_ADVANCE_TURNS
    };
    let autoAdvanceTimer: NodeJS.Timeout | null = null;
    let speechStuckTimer: NodeJS.Timeout | null = null;
    let latestAgentState: voice.AgentState = 'initializing';
    let latestUserState: voice.UserState = 'listening';
    let sessionRef: voice.AgentSession | null = null;
    let satsangAmbiencePublisher: SatsangAmbiencePublisher | null = null;
    let nudgePlaybackStatusTimer: NodeJS.Timeout | null = null;
    let activeNudgePlayback: QueuedNudgePlayback | null = null;
    const queuedNudgePlaybacks: QueuedNudgePlayback[] = [];
    const conversations = new ConversationService();
    const userTranscripts = new UserTranscriptService();
    const pendingUserTurns: string[] = [];
    let turnSeq = 0;
    let activeTurnId: number | null = null;
    let lastUserSpeechStoppedAt: number | null = null;
    const turnLatencyById = new Map<number, TurnLatencyTrace>();
    const speechToTurnId = new Map<string, number>();

    const resolveTurnForTimestamp = (timestamp: number): TurnLatencyTrace | null => {
      const active = activeTurnId ? turnLatencyById.get(activeTurnId) ?? null : null;
      if (active && !active.closed && active.startedAt <= timestamp) return active;

      let candidate: TurnLatencyTrace | null = null;
      for (const turn of turnLatencyById.values()) {
        if (turn.closed) continue;
        if (turn.startedAt > timestamp) continue;
        if (!candidate || turn.turnId > candidate.turnId) {
          candidate = turn;
        }
      }
      return candidate;
    };

    const logTurnMarker = (
      turn: TurnLatencyTrace,
      marker: string,
      markerAt: number,
      extra?: Record<string, unknown>
    ): void => {
      logger.info('Turn latency marker', {
        sessionId,
        turnId: turn.turnId,
        marker,
        sinceTurnStartMs: Math.max(0, markerAt - turn.startedAt),
        ...extra
      });
    };

    const cleanupLatencyTraces = (): void => {
      if (turnLatencyById.size <= 40) return;
      for (const [turnId, turn] of turnLatencyById) {
        if (turn.closed && activeTurnId !== turnId) {
          turnLatencyById.delete(turnId);
        }
        if (turnLatencyById.size <= 30) break;
      }
    };

    const closeTurnTrace = (turn: TurnLatencyTrace, endedAt: number): void => {
      if (turn.closed) return;
      turn.closed = true;
      if (activeTurnId === turn.turnId) {
        activeTurnId = null;
      }
      logger.info('Turn latency summary', {
        sessionId,
        turnId: turn.turnId,
        transcriptChars: turn.transcriptChars,
        totalMs: Math.max(0, endedAt - turn.startedAt),
        sttFinalizeMs: turn.sttFinalizeMs,
        generationStartMs: turn.speechCreatedAt ? Math.max(0, turn.speechCreatedAt - turn.startedAt) : null,
        thinkingStartMs: turn.thinkingAt ? Math.max(0, turn.thinkingAt - turn.startedAt) : null,
        firstToolStartMs: turn.firstToolStartAt ? Math.max(0, turn.firstToolStartAt - turn.startedAt) : null,
        firstToolEndMs: turn.firstToolEndAt ? Math.max(0, turn.firstToolEndAt - turn.startedAt) : null,
        firstAudioMs: turn.firstAudioAt ? Math.max(0, turn.firstAudioAt - turn.startedAt) : null,
        firstAssistantTextMs: turn.firstAssistantTextAt
          ? Math.max(0, turn.firstAssistantTextAt - turn.startedAt)
          : null,
        modelTtftMs: turn.modelTtftMs,
        toolCount: turn.toolCount,
        toolNames: turn.toolNames,
        totalToolMs: turn.totalToolMs
      });
      cleanupLatencyTraces();
    };

    const buildNewsFollowupInstructions = (payload: Record<string, unknown>): string => {
      const summaries = toNewsSummariesForFollowup(payload.summaries);
      const fallbackSummaries = summaries.length > 0 ? summaries : toNewsSummariesForFollowup(payload.items);
      const query = asNonEmptyString(payload.query) ?? 'latest news';

      return [
        'The background news retrieval is complete.',
        `Reply in ${language}.`,
        'Give a concise spoken news update based only on the provided summary lines.',
        'Do not mention URLs, source metadata, or identifiers.',
        'Cover up to 3 key items unless user explicitly asks for more.',
        'Do not ask a new question at the end unless there are zero usable summaries.',
        'Do not call any tool in this turn.',
        `ToolData=${JSON.stringify({
          query,
          itemCount: fallbackSummaries.length,
          summaries: fallbackSummaries
        })}`
      ].join('\n');
    };

    const buildNewsFollowupSpeech = (payload: Record<string, unknown>): string | null => {
      const summaries = toNewsSummariesForFollowup(payload.summaries);
      const fallbackSummaries = summaries.length > 0 ? summaries : toNewsSummariesForFollowup(payload.items);
      const compact = fallbackSummaries
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter((line) => line.length > 0)
        .slice(0, 3);

      const isHindi = language.toLowerCase().startsWith('hi');
      if (compact.length === 0) {
        return isHindi
          ? 'मुझे अभी भरोसेमंद खबरें नहीं मिलीं। मैं थोड़ी देर में फिर कोशिश कर सकता हूँ।'
          : 'I could not fetch reliable news updates right now. I can try again shortly.';
      }

      if (isHindi) {
        const stitched = compact.map((line, i) => `खबर ${i + 1}: ${line}`).join(' ');
        return `मैंने ताज़ा अपडेट निकाल लिए हैं। ${stitched}`;
      }

      const stitched = compact.map((line, i) => `Update ${i + 1}: ${line}`).join(' ');
      return `I found the latest updates. ${stitched}`;
    };

    const buildWebSearchFollowupInstructions = (payload: Record<string, unknown>): string => {
      const items = toWebItemsForFollowup(payload.items);
      const query = asNonEmptyString(payload.query) ?? 'web search';
      const recencyDays = typeof payload.recencyDays === 'number' ? payload.recencyDays : undefined;
      const includeDomains = Array.isArray(payload.includeDomains)
        ? payload.includeDomains
            .map((d) => (typeof d === 'string' ? d.trim() : ''))
            .filter((d) => d.length > 0)
        : [];
      const compactItems = items.map((item) => ({
        title: item.title,
        summary: item.summary,
        source: item.source,
        url: item.url,
        publishedAt: item.publishedAt
      }));

      return [
        'The background web search is complete.',
        `Reply in ${language}.`,
        'Answer the user query first, then mention 2-4 relevant websites with what each contains.',
        'Use only provided tool data and do not call any tool in this turn.',
        'If no results, say that no reliable results were found and ask one clarifying follow-up.',
        `ToolData=${JSON.stringify({
          query,
          recencyDays,
          includeDomains,
          itemCount: compactItems.length,
          items: compactItems
        })}`
      ].join('\n');
    };

    const buildPanchangFollowupInstructions = (payload: Record<string, unknown>): string => {
      const result = asRecord(payload.result) ?? {};
      const status = asNonEmptyString(result.status) ?? 'unknown';
      const queryType = asNonEmptyString(payload.queryType) ?? asNonEmptyString(result.queryType) ?? 'today_snapshot';
      const tithiKey = asNonEmptyString(payload.tithiKey) ?? asNonEmptyString(result.targetTithi) ?? '';
      const city = asNonEmptyString(payload.city) ?? asNonEmptyString(result.location && asRecord(result.location)?.city) ?? '';
      const stateOrRegion = asNonEmptyString(payload.stateOrRegion) ?? '';
      const countryCode = asNonEmptyString(payload.countryCode) ?? '';
      const message = asNonEmptyString(result.message) ?? '';
      const responseStyle =
        status !== 'ready'
          ? 'If retrieval is incomplete or needs confirmation, ask one short clarification question.'
          : queryType === 'next_tithi'
            ? 'Answer with the next matching tithi date/time first. Keep to 2-4 short sentences. Add only one brief practical note.'
            : queryType === 'upcoming_tithi_dates'
              ? 'Provide only the next few matching dates in concise spoken form. Keep to 3-5 short sentences. Do not narrate full daily panchang.'
              : queryType === 'tithi_on_date'
                ? 'Answer only the tithi for that date first, then one short supporting line.'
                : 'Give a concise Panchang answer. Mention asked item first. Add at most one extra context line unless user requested full details.';

      return [
        'The background panchang retrieval is complete.',
        `Reply in ${language}.`,
        'Use only the tool data and do not call any tool in this turn.',
        responseStyle,
        `ToolData=${JSON.stringify({
          status,
          queryType,
          tithiKey,
          city,
          stateOrRegion,
          countryCode,
          message,
          result
        })}`
      ].join('\n');
    };

    const buildReligiousFollowupInstructions = (payload: Record<string, unknown>): string => {
      const query = asNonEmptyString(payload.query) ?? '';
      const citations = toCitationsForFollowup(payload.citations);
      return [
        'The background religious retrieval is complete.',
        `Reply in ${language}.`,
        citations.length > 0
          ? 'Give a grounded response using the provided citations. Mention source title naturally.'
          : 'No citations were found. Ask one concise clarifying question to refine the request.',
        'Do not call any tool in this turn.',
        `ToolData=${JSON.stringify({
          query,
          citationCount: citations.length,
          citations
        })}`
      ].join('\n');
    };

    const buildStoryFollowupInstructions = (payload: Record<string, unknown>): string => {
      const query = asNonEmptyString(payload.query) ?? '';
      const hits = toStoriesForFollowup(payload.hits);
      return [
        'The background story retrieval is complete.',
        `Reply in ${language}.`,
        hits.length > 0
          ? 'Tell one coherent story segment based on the provided passage. Keep it engaging and grounded in the retrieved text.'
          : 'No story hits were found. Ask one concise clarifying question (theme/tradition/region).',
        'Do not call any tool in this turn.',
        `ToolData=${JSON.stringify({
          query,
          hitCount: hits.length,
          hits
        })}`
      ].join('\n');
    };

    const buildStoryFollowupSpeech = (payload: Record<string, unknown>): string | null => {
      const hits = toStoriesForFollowup(payload.hits);
      const isHindi = language.toLowerCase().startsWith('hi');

      if (hits.length === 0) {
        return isHindi
          ? 'मुझे अभी कोई सही लोक कथा नहीं मिली। आप चाहें तो परंपरा बताइए, जैसे पंचतंत्र, अकबर बीरबल, या क्षेत्र, फिर मैं तुरंत सुनाता हूँ।'
          : 'I could not find a strong story match right now. If you share a tradition or region, I can fetch one immediately.';
      }

      const first = hits[0]!;
      const passage = first.passage.replace(/\s+/g, ' ').trim();
      const storyPart = truncate(passage, 700);
      const moralPart = first.moral ? ` ${isHindi ? 'सीख:' : 'Moral:'} ${first.moral}` : '';

      if (isHindi) {
        return `ठीक है, एक लोक कथा सुनिए। ${storyPart}${moralPart}`;
      }
      return `Alright, here is a story. ${storyPart}${moralPart}`;
    };

    const buildYoutubeFailureSpeech = (payload: Record<string, unknown>): string => {
      const query = asNonEmptyString(payload.searchQuery) ?? asNonEmptyString(payload.query) ?? 'media';
      const isHindi = language.toLowerCase().startsWith('hi');
      return isHindi
        ? `माफ़ कीजिए, मैं अभी ${query} के लिए playable भजन या media resolve नहीं कर पाया। मैं चाहें तो दोबारा कोशिश कर सकता हूँ।`
        : `Sorry, I could not resolve playable media for ${query} right now. I can try again.`;
    };

    const clearNudgePlaybackStatusTimer = () => {
      if (!nudgePlaybackStatusTimer) return;
      clearTimeout(nudgePlaybackStatusTimer);
      nudgePlaybackStatusTimer = null;
    };

    const canStartQueuedNudgePlayback = (): boolean =>
      !autoFlowState.pendingAutoAdvance &&
      latestUserState !== 'speaking' &&
      (latestAgentState === 'idle' || latestAgentState === 'listening') &&
      sessionRef !== null &&
      activeNudgePlayback === null;

    const canFlushFollowups = (): boolean =>
      !autoFlowState.pendingAutoAdvance &&
      activeNudgePlayback === null &&
      latestUserState !== 'speaking' &&
      (latestAgentState === 'idle' || latestAgentState === 'listening');

    const followupManager = new AsyncFollowupManager({
      delayMs: NEWS_AUTO_FOLLOWUP_DELAY_MS,
      onTriggered: (entry) => {
        logger.info(`Auto ${entry.type} follow-up triggered`, {
          sessionId,
          requestId: entry.requestId
        });
      }
    });

    const flushFollowups = () => {
      followupManager.flushEligible(sessionRef, canFlushFollowups);
    };

    const publishFlowState = (payload: {
      source: string;
      flow: {
        id?: string;
        type?: string;
        mode?: string;
        status?: string;
        phase?: string;
        loopMode?: string;
      } | null;
    }) => {
      const localParticipant = ctx.room.localParticipant;
      if (!localParticipant) return;
      const body = {
        type: 'flow_state',
        source: payload.source,
        flow: payload.flow,
        ts: Date.now()
      };
      void localParticipant
        .publishData(new TextEncoder().encode(JSON.stringify(body)), {
          reliable: true,
          topic: FLOW_STATE_TOPIC
        })
        .catch((error) => {
          logger.warn('Failed to publish flow state data packet', {
            sessionId,
            source: payload.source,
            error: (error as Error).message
          });
        });
    };

    const publishToolEventPacket = (payload: {
      type: string;
      sourceTool: string;
      requestId?: string;
      payload?: Record<string, unknown>;
    }) => {
      const localParticipant = ctx.room.localParticipant;
      if (!localParticipant) return;
      const body = {
        ...payload,
        sessionId,
        ts: Date.now()
      };
      void localParticipant
        .publishData(new TextEncoder().encode(JSON.stringify(body)), {
          reliable: true,
          topic: TOOL_EVENT_TOPIC
        })
        .catch((error) => {
          logger.warn('Failed to publish tool-event data packet', {
            sessionId,
            sourceTool: payload.sourceTool,
            type: payload.type,
            error: (error as Error).message
          });
        });

    };

    const dispatchNextQueuedNudgePlayback = (force = false) => {
      if (!force && !canStartQueuedNudgePlayback()) return;
      if (activeNudgePlayback !== null) return;
      if (sessionRef === null) return;
      if (latestUserState === 'speaking') return;
      const next = queuedNudgePlaybacks.shift();
      if (!next) return;
      activeNudgePlayback = next;
      logger.info('Dispatching nudge voice playback request', {
        sessionId,
        requestId: next.requestId,
        nudgeId: asNonEmptyString(next.payload?.nudgeId),
        attempt: next.attempts + 1
      });
      publishToolEventPacket(next);
      clearNudgePlaybackStatusTimer();
      nudgePlaybackStatusTimer = setTimeout(() => {
        if (!activeNudgePlayback || activeNudgePlayback.requestId !== next.requestId) return;
        const timedOut = activeNudgePlayback;
        logger.warn('Timed out waiting for nudge voice playback status', {
          sessionId,
          requestId: timedOut.requestId,
          nudgeId: asNonEmptyString(timedOut.payload?.nudgeId),
          attempt: timedOut.attempts + 1
        });
        if (timedOut.attempts + 1 < NUDGE_PLAYBACK_MAX_ATTEMPTS) {
          queuedNudgePlaybacks.unshift({
            ...timedOut,
            attempts: timedOut.attempts + 1
          });
          logger.info('Re-queued nudge voice playback after timeout', {
            sessionId,
            requestId: timedOut.requestId,
            attempt: timedOut.attempts + 2
          });
        }
        activeNudgePlayback = null;
        clearNudgePlaybackStatusTimer();
        scheduleAutoAdvance(session);
        flushFollowups();
        dispatchNextQueuedNudgePlayback();
      }, NUDGE_PLAYBACK_STATUS_TIMEOUT_MS);
    };

    const handleNudgePlaybackStatus = async (packet: NudgePlaybackStatusPacket) => {
      if (!activeNudgePlayback) return;
      const status = packet.status;
      if (status !== 'started' && status !== 'ended' && status !== 'failed') return;
      const packetRequestId = asNonEmptyString(packet.requestId);
      const activeRequestId = activeNudgePlayback.requestId;
      if (packetRequestId && packetRequestId !== activeRequestId) return;

      if (status === 'started') {
        logger.info('Nudge voice playback started', {
          sessionId,
          requestId: activeRequestId,
          nudgeId: asNonEmptyString(activeNudgePlayback.payload?.nudgeId)
        });
        return;
      }

      const active = activeNudgePlayback;
      activeNudgePlayback = null;
      clearNudgePlaybackStatusTimer();

      const nudgeId =
        asNonEmptyString(packet.nudgeId) ??
        asNonEmptyString(active.payload?.nudgeId) ??
        asNonEmptyString(active.payload?.requestId) ??
        active.requestId;

      if (status === 'ended' && nudgeId) {
        try {
          const acknowledged = await deps.nudgesService.markListened(userId, [nudgeId]);
          logger.info('Nudge voice playback acknowledged after completion', {
            sessionId,
            requestId: active.requestId,
            nudgeId,
            acknowledgedCount: acknowledged.length
          });
        } catch (error) {
          logger.warn('Failed to acknowledge nudge after voice playback completion', {
            sessionId,
            requestId: active.requestId,
            nudgeId,
            error: (error as Error).message
          });
        }
      } else if (status === 'failed') {
        logger.warn('Nudge voice playback failed', {
          sessionId,
          requestId: active.requestId,
          nudgeId,
          attempt: active.attempts + 1
        });
        if (active.attempts + 1 < NUDGE_PLAYBACK_MAX_ATTEMPTS) {
          queuedNudgePlaybacks.unshift({
            ...active,
            attempts: active.attempts + 1
          });
          logger.info('Re-queued failed nudge voice playback', {
            sessionId,
            requestId: active.requestId,
            attempt: active.attempts + 2
          });
        }
      }

      scheduleAutoAdvance(session);
      flushFollowups();
      dispatchNextQueuedNudgePlayback();
    };

    const publishToolEvent = (payload: {
      type: string;
      sourceTool: string;
      requestId?: string;
      payload?: Record<string, unknown>;
    }) => {
      if (payload.type === 'nudge_playback_requested') {
        const eventPayload = payload.payload ?? {};
        const voiceUrl = asNonEmptyString(eventPayload.voiceUrl);
        if (voiceUrl) {
          if (sessionRef && latestAgentState === 'speaking') {
            try {
              sessionRef.interrupt({ force: true });
            } catch (error) {
              logger.warn('Failed to interrupt agent before nudge voice playback', {
                sessionId,
                requestId: payload.requestId,
                error: (error as Error).message
              });
            }
          }
          queuedNudgePlaybacks.push({
            type: payload.type,
            sourceTool: payload.sourceTool,
            requestId: payload.requestId ?? asNonEmptyString(eventPayload.nudgeId) ?? `nudge_${Date.now().toString(36)}`,
            payload: eventPayload,
            attempts: 0
          });
          setTimeout(() => {
            dispatchNextQueuedNudgePlayback(true);
          }, 150);
          return;
        }
      }

      publishToolEventPacket(payload);

      const isLegacyAsyncAlias =
        payload.type.endsWith('_ready') || payload.type.endsWith('_failed');
      if (env.ASYNC_TOOL_RUNTIME_V2 && isLegacyAsyncAlias && !payload.type.startsWith('tool_async_')) {
        return;
      }

      const scheduleAsyncFollowup = (
        toolName: string,
        status: 'ready' | 'failed',
        requestId: string,
        eventPayload: Record<string, unknown>
      ) => {
        if (status === 'failed') {
          if (toolName === 'youtube_media_get') {
            followupManager.schedule({
              type: `youtube:${requestId}:failed`,
              requestId,
              payload: eventPayload,
              buildInstructions: () => '',
              buildSpeech: buildYoutubeFailureSpeech
            });
            flushFollowups();
          }
          if (toolName === 'web_search') followupManager.clear('web');
          if (toolName === 'panchang_get') followupManager.clear('panchang');
          if (toolName === 'religious_retrieve') followupManager.clear('religious');
          if (toolName === 'story_retrieve') followupManager.clear('story');
          return;
        }

        if (toolName === 'news_retrieve') {
          followupManager.schedule({
            type: `news:${requestId}`,
            requestId,
            payload: eventPayload,
            buildInstructions: buildNewsFollowupInstructions,
            buildSpeech: buildNewsFollowupSpeech
          });
          flushFollowups();
          return;
        }

        if (toolName === 'web_search') {
          followupManager.schedule({
            type: 'web',
            requestId,
            payload: eventPayload,
            buildInstructions: buildWebSearchFollowupInstructions
          });
          flushFollowups();
          return;
        }

        if (toolName === 'panchang_get') {
          followupManager.schedule({
            type: 'panchang',
            requestId,
            payload: eventPayload,
            buildInstructions: buildPanchangFollowupInstructions
          });
          flushFollowups();
          return;
        }

        if (toolName === 'religious_retrieve') {
          followupManager.schedule({
            type: 'religious',
            requestId,
            payload: eventPayload,
            buildInstructions: buildReligiousFollowupInstructions
          });
          flushFollowups();
          return;
        }

        if (toolName === 'story_retrieve') {
          followupManager.schedule({
            type: 'story',
            requestId,
            payload: eventPayload,
            buildInstructions: buildStoryFollowupInstructions,
            buildSpeech: buildStoryFollowupSpeech
          });
          flushFollowups();
          return;
        }

      };

      if (payload.type === 'tool_async_ready' || payload.type === 'tool_async_failed') {
        const envelope = asRecord(payload.payload) ?? {};
        const toolName = asNonEmptyString(envelope.tool) ?? payload.sourceTool;
        const requestId =
          asNonEmptyString(envelope.requestId) ??
          payload.requestId ??
          `${toolName}_${Date.now().toString(36)}`;
        const eventPayload = asRecord(envelope.payload) ?? {};
        scheduleAsyncFollowup(toolName, payload.type === 'tool_async_ready' ? 'ready' : 'failed', requestId, eventPayload);
        return;
      }

      if (payload.type === 'news_retrieve_ready') {
        const requestId = payload.requestId ?? `news_${Date.now().toString(36)}`;
        scheduleAsyncFollowup('news_retrieve', 'ready', requestId, payload.payload ?? {});
        return;
      }

      if (payload.type === 'news_retrieve_failed') {
        scheduleAsyncFollowup('news_retrieve', 'failed', payload.requestId ?? `news_${Date.now().toString(36)}`, payload.payload ?? {});
        return;
      }

      if (payload.type === 'web_search_ready') {
        const requestId = payload.requestId ?? `web_${Date.now().toString(36)}`;
        scheduleAsyncFollowup('web_search', 'ready', requestId, payload.payload ?? {});
        return;
      }

      if (payload.type === 'web_search_failed') {
        scheduleAsyncFollowup('web_search', 'failed', payload.requestId ?? `web_${Date.now().toString(36)}`, payload.payload ?? {});
      }

      if (payload.type === 'panchang_get_ready') {
        const requestId = payload.requestId ?? `panchang_${Date.now().toString(36)}`;
        scheduleAsyncFollowup('panchang_get', 'ready', requestId, payload.payload ?? {});
        return;
      }

      if (payload.type === 'panchang_get_failed') {
        scheduleAsyncFollowup('panchang_get', 'failed', payload.requestId ?? `panchang_${Date.now().toString(36)}`, payload.payload ?? {});
      }

      if (payload.type === 'religious_retrieve_ready') {
        const requestId = payload.requestId ?? `rr_${Date.now().toString(36)}`;
        scheduleAsyncFollowup('religious_retrieve', 'ready', requestId, payload.payload ?? {});
        return;
      }

      if (payload.type === 'religious_retrieve_failed') {
        scheduleAsyncFollowup('religious_retrieve', 'failed', payload.requestId ?? `rr_${Date.now().toString(36)}`, payload.payload ?? {});
      }

      if (payload.type === 'story_retrieve_ready') {
        const requestId = payload.requestId ?? `story_${Date.now().toString(36)}`;
        scheduleAsyncFollowup('story_retrieve', 'ready', requestId, payload.payload ?? {});
        return;
      }

      if (payload.type === 'story_retrieve_failed') {
        scheduleAsyncFollowup('story_retrieve', 'failed', payload.requestId ?? `story_${Date.now().toString(36)}`, payload.payload ?? {});
      }
    };

    const clearAutoFlow = () => {
      autoFlowState.flowId = null;
      autoFlowState.flowType = null;
      autoFlowState.loopMode = 'interactive';
      autoFlowState.pendingAutoAdvance = false;
      autoFlowState.autoTurnsRemaining = MAX_AUTO_ADVANCE_TURNS;
    };

    const startSatsangAmbience = async () => {
      if (!env.SATSANG_AMBIENCE_ENABLED) return;
      if (!satsangAmbiencePublisher) return;
      try {
        await satsangAmbiencePublisher.start();
      } catch (error) {
        logger.warn('Failed to start satsang ambience', {
          sessionId,
          error: (error as Error).message
        });
      }
    };

    const stopSatsangAmbience = async () => {
      if (!satsangAmbiencePublisher) return;
      try {
        await satsangAmbiencePublisher.stop();
      } catch (error) {
        logger.warn('Failed to stop satsang ambience', {
          sessionId,
          error: (error as Error).message
        });
      }
    };

    const clearSpeechStuckTimer = () => {
      if (!speechStuckTimer) return;
      clearTimeout(speechStuckTimer);
      speechStuckTimer = null;
    };

    const parseToolOutput = (raw: string | undefined): unknown => {
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };

    const parseToolArgs = (raw: string | undefined): Record<string, unknown> | null => {
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
      } catch {
        return null;
      }
    };

    const unwrapToolOutput = (parsed: unknown): Record<string, unknown> | null => {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const first = (parsed as Record<string, unknown>).result;
      const level1 =
        first && typeof first === 'object' && !Array.isArray(first)
          ? (first as Record<string, unknown>)
          : (parsed as Record<string, unknown>);
      const second = level1.result;
      const level2 =
        second && typeof second === 'object' && !Array.isArray(second)
          ? (second as Record<string, unknown>)
          : level1;
      return level2;
    };

    const scheduleAutoAdvance = (session: voice.AgentSession) => {
      if (autoAdvanceTimer || !autoFlowState.pendingAutoAdvance) return;
      if (autoFlowState.loopMode !== 'continuous') return;
      if (activeNudgePlayback) return;
      if (latestUserState === 'speaking') return;
      if (latestAgentState !== 'idle' && latestAgentState !== 'listening') return;
      if (autoFlowState.autoTurnsRemaining <= 0) {
        logger.info('Auto flow advance halted: turn budget exhausted', { sessionId, flowId: autoFlowState.flowId });
        autoFlowState.pendingAutoAdvance = false;
        return;
      }
      autoAdvanceTimer = setTimeout(() => {
        autoAdvanceTimer = null;
        if (!autoFlowState.pendingAutoAdvance || autoFlowState.loopMode !== 'continuous') return;
        if (activeNudgePlayback) return;
        if (latestUserState === 'speaking') return;
        if (latestAgentState !== 'idle' && latestAgentState !== 'listening') return;
        if (autoFlowState.autoTurnsRemaining <= 0) {
          autoFlowState.pendingAutoAdvance = false;
          return;
        }
        autoFlowState.pendingAutoAdvance = false;
        autoFlowState.autoTurnsRemaining -= 1;
        logger.info('Auto flow advance triggered', {
          sessionId,
          flowId: autoFlowState.flowId,
          flowType: autoFlowState.flowType,
          turnsRemaining: autoFlowState.autoTurnsRemaining
        });
        session.generateReply({
          instructions:
            'Continue the active structured flow hands-free. You must call flow_next exactly once with action continue and auto true, then speak only the returned flow.nextStep content. Do not call any other tool in this step.'
        });
      }, 250);
    };

    const toolContext: AgentToolContext = {
      userId,
      language,
      sessionId,
      getLastUserTranscript: () => lastFinalTranscript,
      onToolExecutionStart: ({ name, startedAt }) => {
        const turn = resolveTurnForTimestamp(startedAt);
        if (!turn) return;
        turn.toolCount += 1;
        if (!turn.toolNames.includes(name)) {
          turn.toolNames.push(name);
        }
        if (!turn.firstToolStartAt) {
          turn.firstToolStartAt = startedAt;
          logTurnMarker(turn, 'first_tool_start', startedAt, { tool: name });
        }
      },
      onToolExecutionEnd: ({ name, startedAt, endedAt, ok, error }) => {
        const turn = resolveTurnForTimestamp(endedAt);
        if (!turn) return;
        turn.totalToolMs += Math.max(0, endedAt - startedAt);
        if (!turn.firstToolEndAt) {
          turn.firstToolEndAt = endedAt;
          logTurnMarker(turn, 'first_tool_end', endedAt, {
            tool: name,
            ok,
            error
          });
        }
      },
      publishClientEvent: publishToolEvent
    };

    const deps = buildToolDeps();
    const toolDefs = createToolDefinitions(deps);
    const toolMap = buildToolMap(toolDefs, toolContext);

    const agent = new voice.Agent({
      instructions: buildSystemPrompt({
        userId,
        language,
        profileAnswers: metadata.profile_answers ?? null,
        voicePipeline: env.AGENT_VOICE_PIPELINE
      }),
      tools: toolMap as Record<string, any>
    });

    const session = createVoiceSession({
      env,
      logger,
      language,
      ctx
    });
    logger.info('Voice pipeline selected', {
      sessionId,
      pipeline: env.AGENT_VOICE_PIPELINE,
      language
    });
    sessionRef = session;

    const usageCollector = new metrics.UsageCollector();

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (event) => {
      usageCollector.collect(event.metrics);
      logger.debug('Agent metrics', {
        sessionId,
        metrics: event.metrics
      });

      const turn = resolveTurnForTimestamp(event.createdAt);
      if (!turn) return;
      if (!turn.firstMetricsAt) {
        turn.firstMetricsAt = event.createdAt;
        const metricsRecord = event.metrics as Record<string, unknown>;
        const ttftMs = typeof metricsRecord.ttftMs === 'number' ? metricsRecord.ttftMs : null;
        if (ttftMs !== null && ttftMs >= 0) {
          turn.modelTtftMs = ttftMs;
        }
        logTurnMarker(turn, 'first_metrics', event.createdAt, {
          metricsType: typeof metricsRecord.type === 'string' ? metricsRecord.type : undefined,
          modelTtftMs: turn.modelTtftMs
        });
      }
    });

    session.on(voice.AgentSessionEventTypes.SpeechCreated, (event) => {
      if (event.source !== 'generate_reply' && event.source !== 'tool_response') return;
      const turn = resolveTurnForTimestamp(event.createdAt);
      if (!turn) return;

      if (!turn.speechCreatedAt) {
        turn.speechCreatedAt = event.createdAt;
        logTurnMarker(turn, 'speech_created', event.createdAt, {
          source: event.source,
          userInitiated: event.userInitiated
        });
      }

      speechToTurnId.set(event.speechHandle.id, turn.turnId);
      event.speechHandle.addDoneCallback((speechHandle) => {
        const turnId = speechToTurnId.get(speechHandle.id) ?? turn.turnId;
        speechToTurnId.delete(speechHandle.id);
        const doneTurn = turnLatencyById.get(turnId);
        if (!doneTurn) return;
        closeTurnTrace(doneTurn, Date.now());
      });
    });

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
      if (!event.isFinal) return;
      const transcript = event.transcript?.trim() || '';
      // Ignore likely echo artifacts while agent is actively speaking.
      if (latestAgentState === 'speaking' && transcript.length > 0) {
        logger.debug('Ignoring user transcript while agent speaking (possible echo)', {
          sessionId,
          transcript: sanitizeForLog(transcript)
        });
        return;
      }
      lastFinalTranscript = transcript || null;
      if (transcript.length > 0) {
        autoFlowState.pendingAutoAdvance = false;
        autoFlowState.autoTurnsRemaining = MAX_AUTO_ADVANCE_TURNS;
      }
      logger.info('User transcribed', {
        sessionId,
        language: event.language,
        transcript: sanitizeForLog(transcript)
      });

      if (transcript.length > 0) {
        const turnId = ++turnSeq;
        const sttFinalizeMs =
          lastUserSpeechStoppedAt !== null ? Math.max(0, event.createdAt - lastUserSpeechStoppedAt) : null;
        const turn: TurnLatencyTrace = {
          turnId,
          startedAt: event.createdAt,
          transcriptChars: transcript.length,
          userSpeechStoppedAt: lastUserSpeechStoppedAt,
          sttFinalizeMs,
          speechCreatedAt: null,
          thinkingAt: null,
          firstToolStartAt: null,
          firstToolEndAt: null,
          toolCount: 0,
          toolNames: [],
          totalToolMs: 0,
          firstAssistantTextAt: null,
          firstAudioAt: null,
          firstMetricsAt: null,
          modelTtftMs: null,
          closed: false
        };
        activeTurnId = turnId;
        turnLatencyById.set(turnId, turn);
        logTurnMarker(turn, 'user_final_transcript', event.createdAt, {
          transcriptChars: transcript.length,
          sttFinalizeMs
        });
      }

      if (transcript.length > 0) {
        void userTranscripts
          .appendFinalUserTranscript({
            sessionId,
            userId,
            transcript,
            language: event.language
          })
          .catch((error) => {
            logger.warn('Failed to persist final user transcript', {
              sessionId,
              userId,
              error: (error as Error).message
            });
          });
      }
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (event) => {
      const text = event.item.textContent?.trim();
      if (!text) return;

      if (event.item.role === 'user') {
        pendingUserTurns.push(text);
        return;
      }

      if (event.item.role !== 'assistant') return;

      const userText = pendingUserTurns.shift() ?? '';
      if (!userText) return;

      const turn = resolveTurnForTimestamp(event.createdAt);
      if (turn && !turn.firstAssistantTextAt) {
        turn.firstAssistantTextAt = event.createdAt;
        logTurnMarker(turn, 'first_assistant_text_item', event.createdAt);
      }

      void conversations
        .appendTurn({
          sessionId,
          userId,
          userText,
          assistantText: text,
          language
        })
        .catch((error) => {
          logger.warn('Failed to persist conversation turn', {
            sessionId,
            userId,
            error: (error as Error).message
          });
        });
    });

    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (event) => {
      for (let i = 0; i < event.functionCalls.length; i += 1) {
        const call = event.functionCalls[i];
        const output = event.functionCallOutputs[i];
        if (!output) continue;

        const result = unwrapToolOutput(parseToolOutput(output.output));
        const callArgs = parseToolArgs(call.args);
        const ok = !output.isError && result?.ok !== false;
        const flow = result?.flow as Record<string, unknown> | undefined;

        if (call.name === 'flow_stop') {
          clearAutoFlow();
          const stoppedFlow = result?.flow as Record<string, unknown> | undefined;
          void stopSatsangAmbience();
          publishFlowState({
            source: call.name,
            flow: stoppedFlow
              ? {
                  id: typeof stoppedFlow.id === 'string' ? stoppedFlow.id : undefined,
                  type: typeof stoppedFlow.type === 'string' ? stoppedFlow.type : undefined,
                  mode: typeof stoppedFlow.mode === 'string' ? stoppedFlow.mode : undefined,
                  status: typeof stoppedFlow.status === 'string' ? stoppedFlow.status : undefined,
                  phase: typeof stoppedFlow.phase === 'string' ? stoppedFlow.phase : undefined,
                  loopMode: typeof stoppedFlow.loopMode === 'string' ? stoppedFlow.loopMode : undefined
                }
              : null
          });
          continue;
        }

        if (!ok) {
          if (call.name === 'flow_next') {
            autoFlowState.pendingAutoAdvance = false;
          }
          continue;
        }

        if (flow && typeof flow.id === 'string') {
          autoFlowState.flowId = flow.id;
          autoFlowState.flowType = typeof flow.type === 'string' ? (flow.type as FlowType) : autoFlowState.flowType;
          autoFlowState.loopMode = flow.loopMode === 'continuous' ? 'continuous' : 'interactive';
          publishFlowState({
            source: call.name,
            flow: {
              id: flow.id,
              type: typeof flow.type === 'string' ? flow.type : undefined,
              mode: typeof flow.mode === 'string' ? flow.mode : undefined,
              status: typeof flow.status === 'string' ? flow.status : undefined,
              phase: typeof flow.phase === 'string' ? flow.phase : undefined,
              loopMode: typeof flow.loopMode === 'string' ? flow.loopMode : undefined
            }
          });
        }

        if (call.name === 'flow_start') {
          const requestedFlowType =
            typeof callArgs?.flowType === 'string'
              ? callArgs.flowType
              : typeof flow?.type === 'string'
                ? flow.type
                : null;
          const shouldStartSatsangAmbience =
            requestedFlowType === 'satsang' &&
            (typeof flow?.status !== 'string' || flow.status === 'running');
          if (shouldStartSatsangAmbience) {
            void startSatsangAmbience();
          }
          const autoLoop = result?.autoLoop === true || flow?.loopMode === 'continuous';
          autoFlowState.autoTurnsRemaining = MAX_AUTO_ADVANCE_TURNS;
          autoFlowState.pendingAutoAdvance = autoLoop && flow?.readyForAutoAdvance === true;
          continue;
        }

        if (call.name === 'flow_next') {
          const effectiveFlowType =
            typeof flow?.type === 'string'
              ? flow.type
              : typeof autoFlowState.flowType === 'string'
                ? autoFlowState.flowType
                : null;
          if (effectiveFlowType === 'satsang') {
            if (typeof flow?.status !== 'string' || flow.status === 'running') {
              void startSatsangAmbience();
            } else {
              void stopSatsangAmbience();
            }
          }
          const shouldAutoAdvance =
            autoFlowState.loopMode === 'continuous' &&
            flow?.status === 'running' &&
            flow?.readyForAutoAdvance === true;
          autoFlowState.pendingAutoAdvance = shouldAutoAdvance;
          if (!shouldAutoAdvance) {
            autoFlowState.autoTurnsRemaining = MAX_AUTO_ADVANCE_TURNS;
          }
        }
      }
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (event) => {
      latestAgentState = event.newState;
      const turn = resolveTurnForTimestamp(event.createdAt);
      if (turn && event.newState === 'thinking' && !turn.thinkingAt) {
        turn.thinkingAt = event.createdAt;
        logTurnMarker(turn, 'agent_thinking_started', event.createdAt);
      }
      if (turn && event.newState === 'speaking' && !turn.firstAudioAt) {
        turn.firstAudioAt = event.createdAt;
        logTurnMarker(turn, 'first_audio_playback_started', event.createdAt);
      }
      if (event.newState === 'idle' || event.newState === 'listening') {
        dispatchNextQueuedNudgePlayback();
        scheduleAutoAdvance(session);
        flushFollowups();
      }
    });

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (event) => {
      latestUserState = event.newState;
      if (event.oldState === 'speaking' && event.newState !== 'speaking') {
        lastUserSpeechStoppedAt = event.createdAt;
      }
      if (event.newState === 'speaking') {
        clearSpeechStuckTimer();
        speechStuckTimer = setTimeout(() => {
          if (latestUserState !== 'speaking') return;
          logger.warn('User speech appears stuck; forcing turn commit', { sessionId });
          session.commitUserTurn();
        }, 8500);
        return;
      }

      clearSpeechStuckTimer();
      dispatchNextQueuedNudgePlayback();
      scheduleAutoAdvance(session);
      flushFollowups();
    });

    session.on(voice.AgentSessionEventTypes.Error, (event) => {
      logger.error('Agent session error', {
        sessionId,
        source: String((event.source as { constructor?: { name?: string } })?.constructor?.name ?? 'unknown'),
        error: (event.error as Error)?.message ?? String(event.error)
      });
    });

    session.on(voice.AgentSessionEventTypes.Close, (event) => {
      clearSpeechStuckTimer();
      clearNudgePlaybackStatusTimer();
      activeNudgePlayback = null;
      queuedNudgePlaybacks.length = 0;
      for (const turn of turnLatencyById.values()) {
        if (!turn.closed) {
          closeTurnTrace(turn, event.createdAt);
        }
      }
      speechToTurnId.clear();
      followupManager.clear();
      void stopSatsangAmbience();
      if (autoAdvanceTimer) {
        clearTimeout(autoAdvanceTimer);
        autoAdvanceTimer = null;
      }
      sessionRef = null;
      clearAutoFlow();
      logger.info('Agent session closed', {
        sessionId,
        reason: event.reason,
        usage: usageCollector.getSummary()
      });
    });

    await ctx.connect();
    ctx.room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (topic !== TOOL_EVENT_TOPIC) return;
      if (participantIdentity && participant?.identity && participant.identity !== participantIdentity) return;
      try {
        const decoded = new TextDecoder().decode(payload);
        const packet = JSON.parse(decoded) as NudgePlaybackStatusPacket;
        if (packet?.type !== 'nudge_voice_playback_status') return;
        void handleNudgePlaybackStatus(packet);
      } catch (error) {
        logger.debug('Failed to parse tool-event data packet from participant', {
          sessionId,
          error: (error as Error).message
        });
      }
    });

    if (ctx.room.localParticipant) {
      satsangAmbiencePublisher = new SatsangAmbiencePublisher(ctx.room.localParticipant, sessionId);
    } else {
      logger.warn('Local participant unavailable; satsang ambience publisher disabled', { sessionId });
    }

    await session.start({
      agent,
      room: ctx.room,
      inputOptions: {
        audioEnabled: true,
        textEnabled: true,
        noiseCancellation: BackgroundVoiceCancellation()
      },
      outputOptions: {
        audioEnabled: true,
        transcriptionEnabled: true
      }
    });

    // Avoid automatic greeting on connect: it is frequently interrupted by mic/VAD noise and
    // can leave sessions feeling "stuck" before the first real user turn.
  }
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: env.LIVEKIT_AGENT_NAME
  })
);
