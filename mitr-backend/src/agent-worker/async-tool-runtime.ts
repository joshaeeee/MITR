import type { AgentToolContext } from '../services/agent/tools.js';

export type AsyncToolName =
  | 'news_retrieve'
  | 'web_search'
  | 'panchang_get'
  | 'religious_retrieve'
  | 'story_retrieve'
  | 'youtube_media_get';

export type AsyncToolEvent = {
  type: 'tool_async_ready' | 'tool_async_failed';
  tool: AsyncToolName;
  requestId: string;
  key: string;
  payload: Record<string, unknown>;
  error?: string;
};

type AsyncJobState<TResult> = {
  status: 'pending' | 'ready' | 'failed';
  requestId: string;
  key: string;
  tool: AsyncToolName;
  updatedAt: number;
  expiresAt: number;
  result?: TResult;
  readyResponse?: Record<string, unknown>;
  error?: string;
};

export type StartAsyncToolJobOptions<TResult> = {
  tool: AsyncToolName;
  key: string;
  requestIdPrefix: string;
  context: AgentToolContext;
  pendingResponse: (requestId: string) => Record<string, unknown>;
  execute: () => Promise<TResult>;
  onReady: (requestId: string, result: TResult) => {
    response: Record<string, unknown>;
    payload: Record<string, unknown>;
  };
  onFailed?: (requestId: string, error: string) => {
    response?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  };
  ttlMs?: number;
  legacyReadyType?: string;
  legacyFailedType?: string;
};

export class AsyncToolRuntime {
  private readonly jobs = new Map<string, AsyncJobState<unknown>>();
  private readonly defaultTtlMs: number;
  private readonly cleanupIntervalMs: number;
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(options?: { defaultTtlMs?: number; cleanupIntervalMs?: number }) {
    this.defaultTtlMs = options?.defaultTtlMs ?? 5 * 60 * 1000;
    this.cleanupIntervalMs = options?.cleanupIntervalMs ?? 30_000;
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), this.cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  stop(): void {
    clearInterval(this.cleanupTimer);
    this.jobs.clear();
  }

  private nextRequestId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private jobMapKey(tool: AsyncToolName, key: string): string {
    return `${tool}:${key}`;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [key, job] of this.jobs.entries()) {
      if (job.expiresAt <= now) {
        this.jobs.delete(key);
      }
    }
  }

  async start<TResult>(options: StartAsyncToolJobOptions<TResult>): Promise<Record<string, unknown>> {
    this.cleanupExpired();
    const jobKey = this.jobMapKey(options.tool, options.key);
    const now = Date.now();
    const ttlMs = options.ttlMs ?? this.defaultTtlMs;
    const existing = this.jobs.get(jobKey) as AsyncJobState<TResult> | undefined;

    if (existing?.status === 'ready' && existing.readyResponse) {
      existing.updatedAt = now;
      existing.expiresAt = now + ttlMs;
      return existing.readyResponse;
    }

    if (existing?.status === 'pending') {
      existing.updatedAt = now;
      existing.expiresAt = now + ttlMs;
      return options.pendingResponse(existing.requestId);
    }

    const requestId = this.nextRequestId(options.requestIdPrefix);
    const pendingJob: AsyncJobState<TResult> = {
      status: 'pending',
      requestId,
      key: options.key,
      tool: options.tool,
      updatedAt: now,
      expiresAt: now + ttlMs
    };
    this.jobs.set(jobKey, pendingJob as AsyncJobState<unknown>);

    void options
      .execute()
      .then((result) => {
        const ready = options.onReady(requestId, result);
        const readyJob: AsyncJobState<TResult> = {
          ...pendingJob,
          status: 'ready',
          updatedAt: Date.now(),
          expiresAt: Date.now() + ttlMs,
          result,
          readyResponse: ready.response
        };
        this.jobs.set(jobKey, readyJob as AsyncJobState<unknown>);

        const eventPayload: AsyncToolEvent = {
          type: 'tool_async_ready',
          tool: options.tool,
          requestId,
          key: options.key,
          payload: ready.payload
        };
        options.context.publishClientEvent?.({
          type: eventPayload.type,
          sourceTool: options.tool,
          requestId,
          payload: {
            ...eventPayload
          }
        });
        if (options.legacyReadyType) {
          options.context.publishClientEvent?.({
            type: options.legacyReadyType,
            sourceTool: options.tool,
            requestId,
            payload: ready.payload
          });
        }
      })
      .catch((error) => {
        const message = (error as Error).message || 'Unknown async tool error';
        const failed = options.onFailed?.(requestId, message);
        const failedJob: AsyncJobState<TResult> = {
          ...pendingJob,
          status: 'failed',
          updatedAt: Date.now(),
          expiresAt: Date.now() + ttlMs,
          error: message
        };
        this.jobs.set(jobKey, failedJob as AsyncJobState<unknown>);

        const failedPayload = failed?.payload ?? { error: message };
        const eventPayload: AsyncToolEvent = {
          type: 'tool_async_failed',
          tool: options.tool,
          requestId,
          key: options.key,
          payload: failedPayload,
          error: message
        };
        options.context.publishClientEvent?.({
          type: eventPayload.type,
          sourceTool: options.tool,
          requestId,
          payload: {
            ...eventPayload
          }
        });
        if (options.legacyFailedType) {
          options.context.publishClientEvent?.({
            type: options.legacyFailedType,
            sourceTool: options.tool,
            requestId,
            payload: failedPayload
          });
        }
      });

    return options.pendingResponse(requestId);
  }
}
