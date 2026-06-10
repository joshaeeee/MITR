import { config } from "../config.js";
import { log } from "../logger.js";
import type { AnthropicTool, DeviceAuthContext, ToolExecutor } from "../types.js";
import { TOOL_SCHEMAS } from "./schema.js";

/**
 * Executes tools by POSTing to the mitr-backend, exactly like the Pipecat gateway:
 *   POST {MITR_BACKEND_BASE_URL}/internal/pipecat/tool
 *   header X-Internal-Service-Token: <MITR_BACKEND_INTERNAL_TOKEN>
 *   body { name, arguments, context:{ userId, deviceId, familyId, elderId, language, sessionId } }
 * Response { ok, tool, elapsedMs, result, clientEvents }.
 *
 * This HTTP contract is language-agnostic, so existing backend tools work unchanged.
 */
export class BackendToolBridge implements ToolExecutor {
  private readonly logc = log.child({ mod: "tools" });

  constructor(
    private readonly auth: DeviceAuthContext,
    private readonly sessionId: string,
  ) {}

  schemas(): AnthropicTool[] {
    return config.toolsEnabled ? TOOL_SCHEMAS : [];
  }

  async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.auth.userId) {
      return { ok: false, status: "no_user", error: "tool requires an authenticated user" };
    }
    if (!config.backendBaseUrl) {
      return { ok: false, status: "no_backend", error: "MITR_BACKEND_BASE_URL not configured" };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.backendToolTimeoutSec * 1000);
    const startedAt = performance.now();
    try {
      const res = await fetch(`${config.backendBaseUrl}/internal/pipecat/tool`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Internal-Service-Token": config.backendInternalToken,
        },
        body: JSON.stringify({
          name,
          arguments: args,
          context: {
            userId: this.auth.userId,
            deviceId: this.auth.deviceId,
            familyId: this.auth.familyId ?? undefined,
            elderId: this.auth.elderId ?? undefined,
            language: this.auth.language,
            sessionId: this.sessionId,
          },
        }),
        signal: ctrl.signal,
      });
      const elapsedMs = Math.round(performance.now() - startedAt);
      if (res.status >= 400) {
        this.logc.warn("tool backend error", { name, status: res.status, elapsedMs });
        return { ok: false, backendStatus: res.status, error: `backend ${res.status}` };
      }
      const data = (await res.json()) as Record<string, unknown>;
      this.logc.debug("tool ok", { name, elapsedMs });
      // Only the tool's result payload reaches the model — never the raw backend
      // envelope (it may carry internal/diagnostic fields that would be spoken aloud).
      return data.result ?? { ok: data.ok ?? true };
    } catch (err) {
      this.logc.warn("tool exception", { name, error: String(err) });
      return { ok: false, status: "backend_error", error: String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}
