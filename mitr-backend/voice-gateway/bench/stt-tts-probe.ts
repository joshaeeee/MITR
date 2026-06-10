// STT/TTS provider probe.
//   npx tsx bench/stt-tts-probe.ts stt          — streaming finalize + batch RTT suite
//   ELEVENLABS_TTS_MODEL=eleven_v3 npx tsx bench/stt-tts-probe.ts tts — TTS first-chunk for that model
// STT streaming metric = end-of-speech -> final transcript, with the 3s canned utterance
// streamed at real-time pace (640B/20ms), flush() at the last speech frame — exactly how
// the session drives it. Batch metric = whole-file POST round-trip (record-then-upload).
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.js";
import type { SttProvider } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PCM = readFileSync(join(__dirname, "audio", "utterance.pcm"));
const WAV = readFileSync(join(__dirname, "audio", "utterance.wav"));
const RUNS = 3;
const mode = process.argv[2] ?? "stt";

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

async function streamingFinalize(make: () => SttProvider): Promise<{ ms: number; text: string }> {
  const stt = make();
  let final = "";
  let speechEnd = 0;
  let resolveDone: (v: { ms: number; text: string }) => void;
  const done = new Promise<{ ms: number; text: string }>((r) => (resolveDone = r));
  stt.onTranscript((t) => {
    if (t.isFinal && speechEnd) {
      final = t.text;
      resolveDone({ ms: Date.now() - speechEnd, text: final });
    }
  });
  stt.onError(() => {});
  stt.onReady(() => {});
  await stt.connect();
  // stream at real-time pace
  for (let i = 0; i < PCM.length; i += 640) {
    stt.sendAudio(PCM.subarray(i, Math.min(i + 640, PCM.length)));
    await new Promise((r) => setTimeout(r, 20));
  }
  speechEnd = Date.now();
  stt.flush();
  const result = await Promise.race([
    done,
    new Promise<{ ms: number; text: string }>((r) => setTimeout(() => r({ ms: -1, text: "(timeout)" }), 10000)),
  ]);
  await stt.close().catch(() => {});
  return result;
}

async function batchScribe(modelId: string): Promise<{ ms: number; text: string }> {
  const t0 = Date.now();
  const form = new FormData();
  form.set("model_id", modelId);
  form.set("file", new Blob([new Uint8Array(WAV)], { type: "audio/wav" }), "u.wav");
  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": config.elevenlabsApiKey },
    body: form,
  });
  const body = (await res.json()) as { text?: string; detail?: unknown };
  if (!res.ok) throw new Error(JSON.stringify(body.detail).slice(0, 120));
  return { ms: Date.now() - t0, text: body.text ?? "" };
}

async function suite(name: string, fn: () => Promise<{ ms: number; text: string }>): Promise<void> {
  const xs: number[] = [];
  let lastText = "";
  for (let i = 0; i < RUNS; i++) {
    try {
      const r = await fn();
      if (r.ms >= 0) { xs.push(r.ms); lastText = r.text; }
      else lastText = r.text;
    } catch (e) {
      console.log(`  ${name}: run ${i + 1} FAILED — ${String(e).slice(0, 100)}`);
    }
  }
  const stats = xs.length ? `${xs.map((x) => x + "ms").join("  ")}  (median ${median(xs)}ms)` : "ALL FAILED/TIMEOUT";
  console.log(`  ${name.padEnd(34)} ${stats}`);
  if (lastText) console.log(`  ${"".padEnd(34)} -> "${lastText.slice(0, 70)}"`);
}

if (mode === "stt") {
  console.log("STREAMING STT — end-of-speech -> FINAL transcript (live-conversation metric):");
  await suite("scribe_v2_realtime (ws)", async () => {
    const { ElevenLabsStt } = await import("../src/providers/stt-elevenlabs.js");
    return streamingFinalize(() => new ElevenLabsStt());
  });
  await suite("saaras:v3 (ws)", async () => {
    const { SarvamStt } = await import("../src/providers/stt-sarvam.js");
    return streamingFinalize(() => new SarvamStt());
  });
  console.log("\nBATCH STT — whole-file upload round-trip (record-then-upload metric):");
  await suite("scribe_v1 (batch)", () => batchScribe("scribe_v1"));
  await suite("scribe_v2 (batch)", () => batchScribe("scribe_v2"));
} else {
  const { ElevenLabsTts } = await import("../src/providers/tts-elevenlabs.js");
  const xs: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const tts = new ElevenLabsTts();
    const t0 = Date.now();
    const ms = await new Promise<number>((resolve) => {
      tts.onAudio(() => { resolve(Date.now() - t0); void tts.cancel(); });
      tts.onError((e) => { console.log("  err:", e.message.slice(0, 120)); resolve(-1); });
      void tts.connect().then(() => {
        tts.appendText("Good morning! A short walk outside would be lovely.");
        tts.finish();
      });
      setTimeout(() => resolve(-1), 12000);
    });
    if (ms >= 0) xs.push(ms);
  }
  console.log(
    `TTS first chunk ${config.elevenlabsTtsModel}: ${xs.length ? xs.map((x) => x + "ms").join("  ") + `  (median ${median(xs)}ms)` : "ALL FAILED"}`,
  );
}
process.exit(0);
