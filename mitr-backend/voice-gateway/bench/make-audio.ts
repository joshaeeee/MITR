// Synthesize a canned "hey Mitr ..." test utterance as PCM16/16k via ElevenLabs REST,
// so the benchmark drives every gateway with identical, realistic speech.
//
//   ELEVENLABS_API_KEY=... ELEVENLABS_VOICE_ID=... pnpm bench:make-audio ["<text>"]
//
// Writes bench/audio/utterance.pcm (raw, what the sim streams) + utterance.wav (to listen).

import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "../src/config.js";
import { pcmToWav } from "./audio-util.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "audio");

const DEFAULT_TEXT =
  process.argv[2] ||
  process.env.BENCH_UTTERANCE ||
  "Hey Mitr. How are you doing today? Tell me one nice thing to start my morning.";

async function main(): Promise<void> {
  if (!config.elevenlabsApiKey) throw new Error("ELEVENLABS_API_KEY required to synthesize audio");
  if (!config.elevenlabsVoiceId) throw new Error("ELEVENLABS_VOICE_ID required to synthesize audio");

  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.elevenlabsVoiceId)}` +
    `?output_format=pcm_16000`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": config.elevenlabsApiKey, "content-type": "application/json" },
    body: JSON.stringify({
      text: DEFAULT_TEXT,
      model_id: config.elevenlabsTtsModel,
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS failed: ${res.status} ${await res.text()}`);

  const pcm = Buffer.from(await res.arrayBuffer());
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "utterance.pcm"), pcm);
  writeFileSync(join(OUT_DIR, "utterance.wav"), pcmToWav(pcm, 16000, 1));

  const ms = Math.round(((pcm.length >> 1) / 16000) * 1000);
  console.log(`Wrote utterance.pcm (${pcm.length} bytes, ${ms} ms) to ${OUT_DIR}`);
  console.log(`Text: ${DEFAULT_TEXT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
