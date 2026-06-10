import {
  GoogleGenAI,
  type Content,
  type FunctionCall,
  type FunctionDeclaration,
  type Part,
  type Schema,
} from "@google/genai";
import { config } from "../config.js";
import { log } from "../logger.js";
import type { DeviceAuthContext, LlmProvider, ToolExecutor } from "../types.js";
import { renderSystemPrompt } from "../prompt.js";

const MAX_TOOL_ITERATIONS = 6;

/**
 * Gemini Flash streaming LLM with a function-calling loop. Thinking is disabled by
 * default (thinkingBudget=0) for the lowest possible TTFT — the whole point of using
 * Flash here. Owns conversation history for the session; streams text deltas to TTS.
 */
export class GeminiLlm implements LlmProvider {
  private readonly ai: GoogleGenAI;
  private readonly system: string;
  private readonly tools: FunctionDeclaration[];
  private contents: Content[] = [];
  private textDeltaCb: (text: string) => void = () => {};
  private toolStartCb: (name: string) => void = () => {};
  private toolEndCb: (name: string, ok: boolean) => void = () => {};
  private readonly logc = log.child({ mod: "llm:gemini" });

  constructor(
    auth: DeviceAuthContext,
    private readonly executor: ToolExecutor,
  ) {
    this.ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
    this.system = renderSystemPrompt(auth);
    this.tools = executor.schemas().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.input_schema as unknown as Schema,
    }));
  }

  private requestConfig(signal: AbortSignal) {
    return {
      systemInstruction: this.system,
      temperature: config.geminiTemperature,
      maxOutputTokens: config.geminiMaxTokens,
      thinkingConfig: { thinkingBudget: config.geminiThinkingBudget },
      abortSignal: signal,
      ...(this.tools.length ? { tools: [{ functionDeclarations: this.tools }] } : {}),
    };
  }

  async runUserTurn(userText: string, signal: AbortSignal): Promise<{ assistantText: string }> {
    // Track the entries THIS run appends by identity. A replacement speculative run can
    // start appending before this run's abort rejection lands, so a length-snapshot
    // rollback would delete the replacement's entries; filtering by reference is
    // interleaving-safe.
    const mine: Content[] = [];
    const push = (c: Content): void => {
      mine.push(c);
      this.contents.push(c);
    };
    const rollback = (): void => {
      this.contents = this.contents.filter((c) => !mine.includes(c));
    };
    push({ role: "user", parts: [{ text: userText }] });
    let assistantText = "";

    try {
      for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
        if (signal.aborted) break;

        const calls: FunctionCall[] = [];
        let turnText = "";
        try {
          const stream = await this.ai.models.generateContentStream({
            model: config.geminiModel,
            contents: this.contents,
            config: this.requestConfig(signal),
          });
          for await (const chunk of stream) {
            if (signal.aborted) break;
            const t = chunk.text;
            if (t) {
              turnText += t;
              assistantText += t;
              this.textDeltaCb(t);
            }
            if (chunk.functionCalls?.length) calls.push(...chunk.functionCalls);
          }
        } catch (err) {
          if (signal.aborted) break;
          this.logc.error("gemini stream failed", { error: String(err) });
          throw err;
        }

        // record the model turn (text + any function calls)
        const modelParts: Part[] = [];
        if (turnText) modelParts.push({ text: turnText });
        for (const c of calls) modelParts.push({ functionCall: c });
        if (modelParts.length) push({ role: "model", parts: modelParts });

        if (!calls.length) break;

        // execute tools, feed responses back, loop
        const responseParts: Part[] = [];
        for (const c of calls) {
          if (signal.aborted) break;
          const name = c.name ?? "";
          this.toolStartCb(name);
          let ok = true;
          let result: unknown;
          try {
            result = await this.executor.execute(name, (c.args ?? {}) as Record<string, unknown>);
            ok = !(result && typeof result === "object" && (result as { ok?: boolean }).ok === false);
          } catch (err) {
            ok = false;
            result = { ok: false, error: String(err) };
          }
          this.toolEndCb(name, ok);
          responseParts.push({
            functionResponse: { name, response: { result } },
          });
        }
        if (signal.aborted) break;
        push({ role: "user", parts: responseParts });
      }
    } catch (err) {
      rollback(); // a failed turn must not leave an orphaned user message polluting history
      throw err;
    }

    if (signal.aborted) rollback(); // aborted speculative run: discard everything it appended
    else this.trimHistory();
    return { assistantText };
  }

  /** Cap history for always-on sessions (days-long on the device) so context never
   * overflows. Trim to the most recent plain user turn within the cap. */
  private trimHistory(): void {
    const MAX_ENTRIES = 40;
    if (this.contents.length <= MAX_ENTRIES) return;
    let start = this.contents.length - MAX_ENTRIES;
    while (start < this.contents.length) {
      const c = this.contents[start]!;
      const plainUser = c.role === "user" && (c.parts ?? []).some((p) => typeof (p as Part).text === "string");
      if (plainUser) break;
      start++;
    }
    this.contents = this.contents.slice(start);
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
    this.contents = [];
  }
}
