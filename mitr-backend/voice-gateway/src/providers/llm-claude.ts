import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { log } from "../logger.js";
import type { DeviceAuthContext, LlmProvider, ToolExecutor } from "../types.js";
import { renderSystemPrompt } from "../prompt.js";

const MAX_TOOL_ITERATIONS = 6;

/**
 * Claude streaming LLM with a native tool-use loop. Owns conversation history for
 * the session. Streams assistant spoken text via onTextDelta so TTS can start early.
 */
export class ClaudeLlm implements LlmProvider {
  private readonly client: Anthropic;
  private readonly system: string;
  private readonly tools: Anthropic.Tool[];
  private messages: Anthropic.MessageParam[] = [];
  private textDeltaCb: (text: string) => void = () => {};
  private toolStartCb: (name: string) => void = () => {};
  private toolEndCb: (name: string, ok: boolean) => void = () => {};
  private readonly logc = log.child({ mod: "llm:claude" });

  constructor(
    auth: DeviceAuthContext,
    private readonly executor: ToolExecutor,
  ) {
    this.client = new Anthropic({ apiKey: config.anthropicApiKey });
    this.system = renderSystemPrompt(auth);
    const schemas = executor.schemas();
    // cache_control on the last tool caches the whole static tools prefix.
    this.tools = schemas.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      ...(i === schemas.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));
  }

  async runUserTurn(userText: string, signal: AbortSignal): Promise<{ assistantText: string }> {
    // Identity-tracked rollback: a replacement speculative run may append before this
    // run's abort lands, so a length-snapshot rollback would delete the wrong entries.
    const mine: Anthropic.MessageParam[] = [];
    const push = (m: Anthropic.MessageParam): void => {
      mine.push(m);
      this.messages.push(m);
    };
    const rollback = (): void => {
      this.messages = this.messages.filter((m) => !mine.includes(m));
    };
    push({ role: "user", content: userText });
    let assistantText = "";

    try {
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      if (signal.aborted) break;

      const params: Anthropic.MessageCreateParamsStreaming = {
        model: config.claudeModel,
        max_tokens: config.claudeMaxTokens,
        temperature: config.claudeTemperature,
        // Prompt caching on the static system prefix => lower TTFT on multi-turn sessions.
        system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
        messages: this.messages,
        stream: true,
        ...(this.tools.length ? { tools: this.tools } : {}),
      };

      let final: Anthropic.Message;
      try {
        const stream = this.client.messages.stream(params, { signal });
        stream.on("text", (delta) => {
          if (!signal.aborted && delta) {
            assistantText += delta;
            this.textDeltaCb(delta);
          }
        });
        final = await stream.finalMessage();
      } catch (err) {
        if (signal.aborted) {
          this.logc.debug("llm turn aborted (barge-in)");
          break;
        }
        this.logc.error("llm stream failed", { error: String(err) });
        throw err;
      }

      // Persist the assistant turn (text + any tool_use blocks).
      push({ role: "assistant", content: final.content });

      if (final.stop_reason !== "tool_use") break;

      // Execute every requested tool, then feed results back and loop.
      const toolUses = final.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        if (signal.aborted) break;
        this.toolStartCb(tu.name);
        let ok = true;
        let result: unknown;
        try {
          result = await this.executor.execute(tu.name, (tu.input ?? {}) as Record<string, unknown>);
          ok = !(result && typeof result === "object" && (result as { ok?: boolean }).ok === false);
        } catch (err) {
          ok = false;
          result = { ok: false, error: String(err) };
        }
        this.toolEndCb(tu.name, ok);
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: typeof result === "string" ? result : JSON.stringify(result ?? {}),
          ...(ok ? {} : { is_error: true }),
        });
      }
      if (signal.aborted) break;
      push({ role: "user", content: toolResults });
    }
    } catch (err) {
      rollback(); // failed turn: no orphaned user message in history
      throw err;
    }

    if (signal.aborted) rollback(); // aborted speculative run: discard everything it appended
    else this.trimHistory();
    return { assistantText };
  }

  /** Cap history for always-on sessions; trim to the most recent plain user turn. */
  private trimHistory(): void {
    const MAX_ENTRIES = 40;
    if (this.messages.length <= MAX_ENTRIES) return;
    let start = this.messages.length - MAX_ENTRIES;
    while (start < this.messages.length) {
      const m = this.messages[start]!;
      if (m.role === "user" && typeof m.content === "string") break;
      start++;
    }
    this.messages = this.messages.slice(start);
  }

  onTextDelta(cb: (text: string) => void): void {
    this.textDeltaCb = cb;
  }
  onToolStart(cb: (name: string) => void): void {
    this.toolStartCb = cb;
  }
  onToolEnd(cb: (name: string, ok: boolean) => void): void {
    this.toolEndCb = cb;
  }

  reset(): void {
    this.messages = [];
  }
}
