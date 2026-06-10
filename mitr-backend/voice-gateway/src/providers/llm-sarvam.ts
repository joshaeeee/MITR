import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import { config } from "../config.js";
import { log } from "../logger.js";
import type { DeviceAuthContext, LlmProvider, ToolExecutor } from "../types.js";
import { renderSystemPrompt } from "../prompt.js";

const MAX_TOOL_ITERATIONS = 6;

/**
 * Sarvam-M LLM (OpenAI-compatible chat completions at api.sarvam.ai/v1) — India-hosted,
 * so RTT from an India device/gateway is tiny. Streaming + tool calling; reasoning is
 * disabled by default (reasoning_effort:null) for the lowest TTFT. Also usable for any
 * OpenAI-compatible host (Groq/Cerebras/etc.) by overriding base URL + model.
 */
export class SarvamLlm implements LlmProvider {
  private readonly client: OpenAI;
  private readonly system: string;
  private readonly tools: ChatCompletionTool[];
  private messages: ChatCompletionMessageParam[] = [];
  private textDeltaCb: (text: string) => void = () => {};
  private toolStartCb: (name: string) => void = () => {};
  private toolEndCb: (name: string, ok: boolean) => void = () => {};
  private readonly logc = log.child({ mod: "llm:sarvam" });

  constructor(
    auth: DeviceAuthContext,
    private readonly executor: ToolExecutor,
  ) {
    this.client = new OpenAI({ apiKey: config.sarvamApiKey, baseURL: config.sarvamLlmBaseUrl });
    this.system = renderSystemPrompt(auth);
    this.tools = executor.schemas().map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema as Record<string, unknown> },
    }));
  }

  async runUserTurn(userText: string, signal: AbortSignal): Promise<{ assistantText: string }> {
    // The system message is permanent — outside identity-tracked rollback (rolling it
    // back while a replacement run is live would strip the persona for the whole session).
    if (this.messages.length === 0) this.messages.push({ role: "system", content: this.system });
    const mine: ChatCompletionMessageParam[] = [];
    const push = (m: ChatCompletionMessageParam): void => {
      mine.push(m);
      this.messages.push(m);
    };
    const rollback = (): void => {
      this.messages = this.messages.filter((m) => !mine.includes(m));
    };
    push({ role: "user", content: userText });
    let assistantText = "";

    const reasoning = config.sarvamLlmReasoning.toLowerCase();
    const reasoningField =
      reasoning === "off" || reasoning === "" || reasoning === "null"
        ? { reasoning_effort: null }
        : { reasoning_effort: reasoning };

    try {
    for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
      if (signal.aborted) break;

      const acc = new Map<number, { id: string; name: string; args: string }>();
      let turnText = "";
      try {
        const stream = await this.client.chat.completions.create(
          {
            model: config.sarvamLlmModel,
            messages: this.messages,
            stream: true,
            max_tokens: config.sarvamLlmMaxTokens,
            temperature: config.sarvamLlmTemperature,
            ...(this.tools.length ? { tools: this.tools, tool_choice: "auto" } : {}),
            ...(reasoningField as object),
          } as Parameters<typeof this.client.chat.completions.create>[0],
          { signal },
        );
        for await (const chunk of stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
          if (signal.aborted) break;
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) {
            turnText += delta.content;
            assistantText += delta.content;
            this.textDeltaCb(delta.content);
          }
          for (const tc of delta?.tool_calls ?? []) {
            const cur = acc.get(tc.index) ?? { id: "", name: "", args: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            acc.set(tc.index, cur);
          }
        }
      } catch (err) {
        if (signal.aborted) break;
        this.logc.error("sarvam stream failed", { error: String(err) });
        throw err;
      }

      const calls = [...acc.values()].filter((c) => c.name);
      if (calls.length === 0) {
        push({ role: "assistant", content: turnText });
        break;
      }

      const toolCallParams: ChatCompletionMessageToolCall[] = calls.map((c) => ({
        id: c.id || c.name,
        type: "function",
        function: { name: c.name, arguments: c.args || "{}" },
      }));
      push({ role: "assistant", content: turnText || null, tool_calls: toolCallParams });

      for (const c of calls) {
        if (signal.aborted) break;
        this.toolStartCb(c.name);
        let ok = true;
        let result: unknown;
        try {
          const args = c.args ? (JSON.parse(c.args) as Record<string, unknown>) : {};
          result = await this.executor.execute(c.name, args);
          ok = !(result && typeof result === "object" && (result as { ok?: boolean }).ok === false);
        } catch (err) {
          ok = false;
          result = { ok: false, error: String(err) };
        }
        this.toolEndCb(c.name, ok);
        push({
          role: "tool",
          tool_call_id: c.id || c.name,
          content: typeof result === "string" ? result : JSON.stringify(result ?? {}),
        });
      }
      if (signal.aborted) break;
    }
    } catch (err) {
      rollback(); // failed turn: no orphaned user message in history
      throw err;
    }

    if (signal.aborted) rollback(); // aborted speculative run: discard everything it appended
    else this.trimHistory();
    return { assistantText };
  }

  /** Cap history for always-on sessions; keep the system message + trim to a plain user turn. */
  private trimHistory(): void {
    const MAX_ENTRIES = 40;
    if (this.messages.length <= MAX_ENTRIES) return;
    const head = this.messages[0]?.role === "system" ? [this.messages[0]!] : [];
    let start = this.messages.length - MAX_ENTRIES;
    while (start < this.messages.length) {
      const m = this.messages[start]!;
      if (m.role === "user" && typeof m.content === "string") break;
      start++;
    }
    this.messages = [...head, ...this.messages.slice(start)];
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
