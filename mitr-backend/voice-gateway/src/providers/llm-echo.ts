import { config } from "../config.js";
import type { LlmProvider } from "../types.js";

/**
 * Offline stub LLM for smoke tests / benchmarking the audio loop without an LLM key.
 * Streams a short canned reply token-by-token (so TTS sees realistic streaming),
 * honoring barge-in via the abort signal. Select with MITR_GATEWAY_LLM_PROVIDER=echo.
 */
export class EchoLlm implements LlmProvider {
  private textDeltaCb: (text: string) => void = () => {};

  async runUserTurn(_userText: string, signal: AbortSignal): Promise<{ assistantText: string }> {
    const reply = config.elevenlabsTtsLanguage?.startsWith("hi")
      ? "Arre, sun ke accha laga. Main bilkul theek hoon. Aaj ka din shubh ho."
      : "Hey, good to hear you. I'm doing great today, thanks for asking. Hope your morning is off to a lovely start.";
    const words = reply.split(" ");
    let assistantText = "";
    for (const w of words) {
      if (signal.aborted) break;
      const chunk = (assistantText ? " " : "") + w;
      assistantText += chunk;
      this.textDeltaCb(chunk);
      await new Promise((r) => setTimeout(r, 18)); // simulate token cadence
    }
    return { assistantText };
  }

  onTextDelta(cb: (text: string) => void): void {
    this.textDeltaCb = cb;
  }
  onToolStart(): void {}
  onToolEnd(): void {}
  reset(): void {}
}
