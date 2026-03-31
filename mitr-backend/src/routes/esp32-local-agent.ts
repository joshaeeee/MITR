import { initializeLogger, llm, voice } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { TransformStream } from 'node:stream/web';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { env } from '../config/env.js';
import { observabilityConfig } from '../config/observability-config.js';
import { getSelectedVoicePipeline } from '../config/voice-pipeline-config.js';
import { buildSystemPrompt } from '../agent-worker/agent.js';
import {
  createVoiceSession,
  prewarmVoicePipeline,
  validateVoicePipeline
} from '../agent-worker/pipelines/index.js';
import { logger } from '../lib/logger.js';
import type { AuthService, AuthUser } from '../services/auth/auth-service.js';
import type { ProfileService } from '../services/profile/profile-service.js';
import {
  createToolDefinitions,
  type AgentToolContext,
  type AgentToolDefinition,
  type ToolDeps
} from '../services/agent/tools.js';
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
import { NudgesService } from '../services/nudges/nudges-service.js';

const WS_PATH = '/local/esp32-agent';
const PCM_FORMAT = 'pcm_s16le';
const DEFAULT_INPUT_SAMPLE_RATE = 16000;
const DEFAULT_INPUT_CHANNELS = 1;

type InitMessage = {
  type: 'init';
  language?: string;
  sampleRate?: number;
  channels?: number;
};

type ClientMessage = InitMessage;

type LocalPipelineProc = {
  userData: Record<string, unknown>;
};

const pipelineProc: LocalPipelineProc = {
  userData: {}
};

let pipelinePrewarmPromise: Promise<void> | null = null;
let livekitLoggerInitialized = false;

const ensureLivekitLoggerReady = (): void => {
  if (livekitLoggerInitialized) return;

  initializeLogger({
    pretty: false,
    level: observabilityConfig.logLevel
  });
  livekitLoggerInitialized = true;

  logger.info('ESP32 local LiveKit logger initialized', {
    level: observabilityConfig.logLevel
  });
};

const ensurePipelineReady = async (): Promise<void> => {
  ensureLivekitLoggerReady();

  if (!pipelinePrewarmPromise) {
    pipelinePrewarmPromise = prewarmVoicePipeline({
      env,
      logger,
      proc: pipelineProc as never
    }).catch((error) => {
      pipelinePrewarmPromise = null;
      throw error;
    });
  }

  await pipelinePrewarmPromise;
};

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error';

const toBuffer = (data: RawData): Buffer | null => {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) {
    return Buffer.concat(
      data.map((chunk) =>
        Buffer.isBuffer(chunk)
          ? chunk
          : chunk instanceof ArrayBuffer
            ? Buffer.from(chunk)
            : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      )
    );
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
};

const parseInitMessage = (value: unknown): InitMessage | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== 'init') return null;

  const sampleRate =
    typeof record.sampleRate === 'number' && Number.isFinite(record.sampleRate)
      ? Math.max(8000, Math.min(48000, Math.round(record.sampleRate)))
      : DEFAULT_INPUT_SAMPLE_RATE;
  const channels =
    typeof record.channels === 'number' && Number.isFinite(record.channels)
      ? Math.max(1, Math.min(2, Math.round(record.channels)))
      : DEFAULT_INPUT_CHANNELS;

  return {
    type: 'init',
    language: asNonEmptyString(record.language) ?? undefined,
    sampleRate,
    channels
  };
};

const parseClientMessage = (payload: string): ClientMessage | null => {
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parseInitMessage(parsed);
  } catch {
    return null;
  }
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

const toLivekitTool = (definition: AgentToolDefinition, context: AgentToolContext) =>
  llm.tool({
    description: definition.description,
    parameters: definition.parameters,
    execute: async (input: any) => {
      const startedAt = Date.now();
      context.onToolExecutionStart?.({
        name: definition.name,
        startedAt,
        payload: input
      });

      logger.info('ESP32 local tool start', {
        sessionId: context.sessionId,
        userId: context.userId,
        tool: definition.name
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

        logger.info('ESP32 local tool end', {
          sessionId: context.sessionId,
          userId: context.userId,
          tool: definition.name,
          elapsedMs: endedAt - startedAt,
          ok: true
        });

        return { ok: true, result };
      } catch (error) {
        const message = toErrorMessage(error);
        const endedAt = Date.now();
        context.onToolExecutionEnd?.({
          name: definition.name,
          startedAt,
          endedAt,
          ok: false,
          error: message
        });

        logger.warn('ESP32 local tool end', {
          sessionId: context.sessionId,
          userId: context.userId,
          tool: definition.name,
          elapsedMs: endedAt - startedAt,
          ok: false,
          error: message
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

type PlaybackFinishedEvent = {
  playbackPosition: number;
  interrupted: boolean;
};

class SocketAudioInput {
  private readonly transform = new TransformStream<AudioFrame, AudioFrame>();
  private readonly writer = this.transform.writable.getWriter();
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;
  readonly stream = this.transform.readable;

  constructor() {
    // No-op. AgentSession only needs a readable stream and attach/detach hooks.
  }

  enqueueFrame(frame: AudioFrame): Promise<void> {
    if (this.closed) return Promise.resolve();

    this.writeChain = this.writeChain
      .then(async () => {
        if (this.closed) return;
        await this.writer.write(frame);
      })
      .catch((error) => {
        logger.warn('ESP32 local input frame dropped', {
          error: toErrorMessage(error)
        });
      });

    return this.writeChain;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    try {
      await this.writeChain;
    } catch {}

    try {
      await this.writer.close();
    } catch {}

    try {
      this.writer.releaseLock();
    } catch {}

  }

  onAttached(): void {}

  onDetached(): void {}
}

class SocketAudioOutput extends EventEmitter {
  sampleRate: number | undefined;
  private outputFormatKey: string | null = null;
  private pendingSegmentDurationSec = 0;
  private playbackTimer: NodeJS.Timeout | null = null;
  private playbackStartedAt = 0;
  private segmentOpen = false;
  private capturing = false;
  private playbackSegmentsCount = 0;
  private playbackFinishedCount = 0;
  private lastPlaybackEvent: PlaybackFinishedEvent = {
    playbackPosition: 0,
    interrupted: false
  };
  private waiters = new Set<() => void>();

  constructor(
    private readonly sendJson: (payload: Record<string, unknown>) => void,
    private readonly sendBinary: (payload: Buffer) => void
  ) {
    super();
  }

  get canPause(): boolean {
    return false;
  }

  async captureFrame(frame: AudioFrame): Promise<void> {
    if (!this.capturing) {
      this.capturing = true;
      this.playbackSegmentsCount += 1;
    }

    if (!this.segmentOpen) {
      this.segmentOpen = true;
      this.playbackStartedAt = Date.now();
      this.onPlaybackStarted(this.playbackStartedAt);
    }

    this.sampleRate = frame.sampleRate;
    const formatKey = `${frame.sampleRate}:${frame.channels}`;
    if (formatKey !== this.outputFormatKey) {
      this.outputFormatKey = formatKey;
      this.sendJson({
        type: 'output_format',
        sampleRate: frame.sampleRate,
        channels: frame.channels,
        format: PCM_FORMAT
      });
    }

    this.pendingSegmentDurationSec += frame.samplesPerChannel / frame.sampleRate;
    const bytes = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
    this.sendBinary(bytes);
  }

  flush(): void {
    this.capturing = false;

    if (!this.segmentOpen || this.pendingSegmentDurationSec <= 0) {
      return;
    }

    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
    }

    const durationMs = Math.max(1, Math.ceil(this.pendingSegmentDurationSec * 1000));
    this.playbackTimer = setTimeout(() => {
      this.finishSegment(false, this.pendingSegmentDurationSec);
    }, durationMs + 60);
  }

  clearBuffer(): void {
    if (!this.segmentOpen) return;

    this.capturing = false;
    this.sendJson({ type: 'playback_clear' });

    const elapsedSec =
      this.playbackStartedAt > 0 ? Math.max(0, (Date.now() - this.playbackStartedAt) / 1000) : 0;
    const playbackPosition = Math.min(this.pendingSegmentDurationSec, elapsedSec);
    this.finishSegment(true, playbackPosition);
  }

  async waitForPlayout(): Promise<PlaybackFinishedEvent> {
    const target = this.playbackSegmentsCount;
    while (this.playbackFinishedCount < target) {
      await new Promise<void>((resolve) => {
        this.waiters.add(resolve);
      });
    }
    return this.lastPlaybackEvent;
  }

  onAttached(): void {}

  onDetached(): void {}

  pause(): void {}

  resume(): void {}

  private onPlaybackStarted(createdAt: number): void {
    this.emit('playbackStarted', { createdAt });
  }

  private onPlaybackFinished(event: PlaybackFinishedEvent): void {
    if (this.playbackFinishedCount >= this.playbackSegmentsCount) {
      logger.warn('ESP32 local playback finished called more times than captured segments', {
        sessionType: 'esp32_local'
      });
      return;
    }

    this.lastPlaybackEvent = event;
    this.playbackFinishedCount += 1;
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) waiter();
    this.emit('playbackFinished', event);
  }

  private finishSegment(interrupted: boolean, playbackPosition: number): void {
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }

    if (!this.segmentOpen) return;

    this.segmentOpen = false;
    this.playbackStartedAt = 0;
    this.pendingSegmentDurationSec = 0;
    this.onPlaybackFinished({
      playbackPosition,
      interrupted
    });
  }
}

class Esp32LocalAgentConnection {
  private initialized = false;
  private closed = false;
  private readonly input = new SocketAudioInput();
  private readonly output = new SocketAudioOutput(
    (payload) => this.sendJson(payload),
    (payload) => this.sendBinary(payload)
  );
  private session: voice.AgentSession | null = null;
  private readonly sessionId: string;

  constructor(
    private readonly socket: WebSocket,
    private readonly user: AuthUser,
    private readonly profiles: ProfileService
  ) {
    this.sessionId = `esp32-local:${this.user.id}:${Date.now()}`;
  }

  async handleJson(message: ClientMessage): Promise<void> {
    if (message.type !== 'init') {
      this.sendJson({ type: 'error', message: 'unsupported_message_type' });
      return;
    }

    if (this.initialized) {
      this.sendJson({ type: 'error', message: 'session_already_initialized' });
      return;
    }

    this.initialized = true;
    await this.startSession(message);
  }

  async handleBinary(chunk: Buffer): Promise<void> {
    if (!this.initialized || !this.session) {
      this.sendJson({ type: 'error', message: 'init_required_before_audio' });
      return;
    }

    if (chunk.byteLength < 2) return;
    const evenLength = chunk.byteLength - (chunk.byteLength % 2);
    if (evenLength <= 0) return;

    const data = new Int16Array(chunk.buffer, chunk.byteOffset, evenLength / 2);
    const samplesPerChannel = Math.floor(data.length / this.inputChannels);
    if (!samplesPerChannel) return;
    const frame = new AudioFrame(
      data.slice(0, samplesPerChannel * this.inputChannels),
      this.inputSampleRate,
      this.inputChannels,
      samplesPerChannel
    );
    await this.input.enqueueFrame(frame);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    try {
      await this.session?.close();
    } catch (error) {
      logger.warn('ESP32 local session close failed', {
        sessionId: this.sessionId,
        error: toErrorMessage(error)
      });
    }

    await this.input.close();
  }

  private inputSampleRate = DEFAULT_INPUT_SAMPLE_RATE;
  private inputChannels = DEFAULT_INPUT_CHANNELS;

  private async startSession(init: InitMessage): Promise<void> {
    this.inputSampleRate = init.sampleRate ?? DEFAULT_INPUT_SAMPLE_RATE;
    this.inputChannels = init.channels ?? DEFAULT_INPUT_CHANNELS;

    await ensurePipelineReady();

    const profile = await this.profiles.getProfile(this.user.id);
    const language =
      init.language ??
      (typeof profile?.answers?.language === 'string' ? profile.answers.language : null) ??
      'hi-IN';

    const selectedVoicePipeline = getSelectedVoicePipeline(env);
    const ctx = {
      proc: pipelineProc
    } as never;

    validateVoicePipeline({
      env,
      logger,
      language,
      ctx
    });

    const toolContext: AgentToolContext = {
      userId: this.user.id,
      language,
      sessionId: this.sessionId
    };

    const toolDefs = createToolDefinitions(buildToolDeps());
    const toolMap = buildToolMap(toolDefs, toolContext);

    const agent = new voice.Agent({
      instructions: buildSystemPrompt({
        userId: this.user.id,
        language,
        profileAnswers: profile?.answers ?? null,
        voicePipeline: selectedVoicePipeline
      }),
      tools: toolMap as Record<string, any>
    });

    const session = createVoiceSession({
      env,
      logger,
      language,
      ctx
    });

    session.input.audio = this.input as never;
    session.output.audio = this.output as never;

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
      this.sendJson({
        type: 'transcript',
        speaker: 'user',
        text: event.transcript,
        final: event.isFinal,
        language: event.language,
        createdAt: event.createdAt
      });
    });

    session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (event) => {
      if (event.item.role !== 'assistant') return;
      const text = event.item.textContent?.trim();
      if (!text) return;
      this.sendJson({
        type: 'transcript',
        speaker: 'assistant',
        text,
        interrupted: event.item.interrupted,
        createdAt: event.createdAt
      });
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (event) => {
      this.sendJson({
        type: 'state',
        scope: 'agent',
        value: event.newState,
        createdAt: event.createdAt
      });
    });

    session.on(voice.AgentSessionEventTypes.UserStateChanged, (event) => {
      this.sendJson({
        type: 'state',
        scope: 'user',
        value: event.newState,
        createdAt: event.createdAt
      });
    });

    session.on(voice.AgentSessionEventTypes.FunctionToolsExecuted, (event) => {
      this.sendJson({
        type: 'tool_event',
        calls: event.functionCalls.map((call) => call.name),
        createdAt: event.createdAt
      });
    });

    session.on(voice.AgentSessionEventTypes.Error, (event) => {
      this.sendJson({
        type: 'error',
        message: toErrorMessage(event.error),
        createdAt: event.createdAt
      });
    });

    session.on(voice.AgentSessionEventTypes.Close, (event) => {
      this.sendJson({
        type: 'session_closed',
        reason: event.reason,
        createdAt: event.createdAt
      });
    });

    await session.start({ agent });
    this.session = session;

    logger.info('ESP32 local agent session started', {
      sessionId: this.sessionId,
      userId: this.user.id,
      pipeline: selectedVoicePipeline,
      inputSampleRate: this.inputSampleRate,
      inputChannels: this.inputChannels
    });

    this.sendJson({
      type: 'ready',
      sessionId: this.sessionId,
      userId: this.user.id,
      pipeline: selectedVoicePipeline,
      language,
      inputFormat: {
        sampleRate: this.inputSampleRate,
        channels: this.inputChannels,
        format: PCM_FORMAT
      }
    });
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  private sendBinary(payload: Buffer): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(payload, { binary: true });
  }
}

const writeHttpError = (socket: Duplex, statusCode: number, message: string): void => {
  socket.write(
    `HTTP/1.1 ${statusCode} ${message}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n` +
      message
  );
  socket.destroy();
};

export const registerEsp32LocalAgentBridge = (
  app: FastifyInstance,
  auth: AuthService,
  profiles: ProfileService
): void => {
  const wss = new WebSocketServer({ noServer: true });
  const connections = new WeakMap<WebSocket, Esp32LocalAgentConnection>();

  wss.on('connection', (socket: WebSocket) => {
    const connection = connections.get(socket);
    if (!connection) {
      socket.close(1011, 'missing_connection_context');
      return;
    }

    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        const chunk = toBuffer(data);
        if (!chunk) return;
        void connection.handleBinary(chunk).catch((error) => {
          logger.error('ESP32 local binary handler failed', {
            error: toErrorMessage(error)
          });
          socket.close(1011, 'binary_handler_failed');
        });
        return;
      }

      const text =
        typeof data === 'string'
          ? data
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Array.isArray(data)
              ? Buffer.concat(data.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part)))).toString('utf8')
              : Buffer.from(data).toString('utf8');
      const message = parseClientMessage(text);
      if (!message) {
        socket.send(JSON.stringify({ type: 'error', message: 'invalid_json_message' }));
        return;
      }

      void connection.handleJson(message).catch((error) => {
        logger.error('ESP32 local init failed', {
          error: toErrorMessage(error)
        });
        socket.send(JSON.stringify({ type: 'error', message: toErrorMessage(error) }));
        socket.close(1011, 'init_failed');
      });
    });

    socket.on('close', () => {
      void connection.close();
    });

    socket.on('error', (error: unknown) => {
      logger.warn('ESP32 local websocket error', {
        error: toErrorMessage(error)
      });
    });
  });

  const handleUpgrade = async (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }

    const accessToken = asNonEmptyString(url.searchParams.get('accessToken'));
    if (!accessToken) {
      writeHttpError(socket, 401, 'Missing access token');
      return;
    }

    let user: AuthUser | null = null;
    try {
      user = await auth.getUserFromAccessToken(accessToken);
    } catch (error) {
      logger.warn('ESP32 local auth lookup failed', {
        error: toErrorMessage(error)
      });
    }

    if (!user) {
      writeHttpError(socket, 401, 'Invalid or expired access token');
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      connections.set(ws, new Esp32LocalAgentConnection(ws, user!, profiles));
      wss.emit('connection', ws, request);
    });
  };

  app.server.on('upgrade', (request, socket, head) => {
    void handleUpgrade(request, socket, head);
  });

  app.addHook('onClose', async () => {
    for (const client of wss.clients) {
      const connection = connections.get(client);
      if (connection) {
        await connection.close();
      }
      client.close();
    }

    await new Promise<void>((resolve, reject) => {
      wss.close((error: Error | undefined) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  });
};
