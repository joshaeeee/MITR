import { config } from "./config.js";

/**
 * Fire-and-forget TLS pre-warm for the providers the next turn will hit. Node's fetch
 * (undici) keeps the socket in its pool, so the real request a moment later skips
 * DNS+TCP+TLS (~150-200ms from India). Called on wake and on speech_start — both are
 * 1-4s ahead of the actual provider request, inside undici's keep-alive window.
 */

let lastPrewarmAt = 0;

function targets(): string[] {
  const urls = new Set<string>();
  if (config.ttsProvider === "elevenlabs" || config.ttsProvider === "eleven-v3") {
    urls.add("https://api.elevenlabs.io/");
  }
  if (config.sttProvider === "elevenlabs") urls.add("https://api.elevenlabs.io/");
  if (config.llmProvider === "gemini") urls.add("https://generativelanguage.googleapis.com/");
  if (config.llmProvider === "claude") urls.add("https://api.anthropic.com/");
  if (config.llmProvider === "sarvam" || config.sttProvider === "sarvam" || config.ttsProvider === "sarvam") {
    urls.add("https://api.sarvam.ai/");
  }
  return [...urls];
}

export function prewarmProviders(): void {
  const now = Date.now();
  if (now - lastPrewarmAt < 3000) return; // socket is still warm; don't spam
  lastPrewarmAt = now;
  for (const url of targets()) {
    void fetch(url, { method: "HEAD", signal: AbortSignal.timeout(2500) }).catch(() => {
      /* status/errors irrelevant — the TLS handshake is the point */
    });
  }
}
