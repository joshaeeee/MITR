// Head-to-head provider latency probe, run from this machine (India).
// LLMs: time-to-first-token with the SAME short prompt. TTS: time-to-first-audio-chunk.
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import { config } from "../src/config.js";

const PROMPT = "Reply in one short sentence: what's a nice thing to do this morning?";
const RUNS = 3;

async function claudeTtft(): Promise<number> {
  const c = new Anthropic({ apiKey: config.anthropicApiKey });
  const t0 = Date.now();
  const stream = c.messages.stream({
    model: config.claudeModel,
    max_tokens: 100,
    messages: [{ role: "user", content: PROMPT }],
  });
  return new Promise((resolve, reject) => {
    let done = false;
    stream.on("text", () => {
      if (done) return;
      done = true;
      resolve(Date.now() - t0);
      stream.abort();
    });
    stream.on("error", (e) => { if (!done) reject(e); });
    stream.done().catch(() => { /* abort after first token is expected */ });
  });
}

async function geminiTtft(): Promise<number> {
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
  const t0 = Date.now();
  const stream = await ai.models.generateContentStream({
    model: config.geminiModel,
    contents: [{ role: "user", parts: [{ text: PROMPT }] }],
    config: { maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 } },
  });
  for await (const chunk of stream) {
    if (chunk.text) return Date.now() - t0;
  }
  throw new Error("no text");
}

async function sarvamTtft(): Promise<number> {
  const c = new OpenAI({ apiKey: config.sarvamApiKey, baseURL: config.sarvamLlmBaseUrl });
  const t0 = Date.now();
  const stream = await c.chat.completions.create({
    model: config.sarvamLlmModel,
    max_tokens: 100,
    stream: true,
    messages: [{ role: "user", content: PROMPT }],
    reasoning_effort: null,
  });
  for await (const chunk of stream) {
    if (chunk.choices[0]?.delta?.content) return Date.now() - t0;
  }
  throw new Error("no text");
}

async function elevenTtsFirstChunk(): Promise<number> {
  const { ElevenLabsTts } = await import("../src/providers/tts-elevenlabs.js");
  const tts = new ElevenLabsTts();
  const t0 = Date.now();
  return new Promise<number>((resolve, reject) => {
    tts.onAudio(() => { resolve(Date.now() - t0); void tts.cancel(); });
    tts.onError(reject);
    tts.connect().then(() => {
      tts.appendText("Good morning! A short walk outside would be lovely.");
      tts.finish();
    }, reject);
  });
}

async function sarvamTtsFirstChunk(): Promise<number> {
  const { SarvamTts } = await import("../src/providers/tts-sarvam.js");
  const tts = new SarvamTts();
  const t0 = Date.now();
  return new Promise<number>((resolve, reject) => {
    tts.onAudio(() => { resolve(Date.now() - t0); void tts.cancel(); });
    tts.onError(reject);
    tts.connect().then(() => {
      tts.appendText("Good morning! A short walk outside would be lovely.");
      tts.finish();
    }, reject);
  });
}

async function bench(name: string, fn: () => Promise<number>): Promise<void> {
  const xs: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    try {
      xs.push(await fn());
    } catch (e) {
      console.log(`${name}: run ${i + 1} FAILED — ${String(e).slice(0, 120)}`);
    }
  }
  if (xs.length) console.log(`${name}: ${xs.map((x) => x + "ms").join("  ")}  (median ${xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]}ms)`);
}

console.log(`LLM TTFT (same prompt, ${RUNS} runs each):`);
await bench("  claude " + config.claudeModel.padEnd(18), claudeTtft);
await bench("  gemini " + config.geminiModel.padEnd(18), geminiTtft);
await bench("  sarvam " + config.sarvamLlmModel.padEnd(18), sarvamTtft);
console.log(`\nTTS first audio chunk (connect + synth, ${RUNS} runs each):`);
await bench("  elevenlabs flash-v2.5    ", elevenTtsFirstChunk);
await bench("  sarvam bulbul-v3         ", sarvamTtsFirstChunk);
process.exit(0);
