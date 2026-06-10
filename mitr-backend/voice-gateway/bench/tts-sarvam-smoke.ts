import { SarvamTts } from "../src/providers/tts-sarvam.js";

// Token streams that mimic exactly what an LLM emits, including the fragments that crash Bulbul:
// a leading newline, a lone "!", an emoji, a markdown "*". The adapter must carry these forward.
const STREAMS: Record<string, string[]> = {
  hindi: ["\n", "नमस्ते", "!", " 😊", " मैं", " बिल्कुल", " ठीक", " हूँ", "।", " आप", " कैसे", " हैं", "?"],
  english: ["\n\n", "*", "Sure", "!", " 😊", " Take", " a", " short", " morning", " walk", " outside", "."],
  hinglish: [" ", "Aap", " kaise", " ho", "?", " Main", " theek", " hoon", " 🙏", "."],
};

async function run(label: string, tokens: string[]): Promise<void> {
  const tts = new SarvamTts();
  let bytes = 0,
    chunks = 0,
    firstAt = 0,
    err = "";
  const start = Date.now();
  tts.onAudio((pcm) => {
    if (!firstAt) firstAt = Date.now() - start;
    chunks++;
    bytes += pcm.length;
  });
  tts.onError((e) => (err = err || e.message.slice(0, 120)));
  await tts.connect();
  for (const t of tokens) tts.appendText(t); // stream all tokens "instantly" like a fast LLM
  tts.finish();
  await new Promise((r) => setTimeout(r, 6000));
  console.log(
    `[${label}] chunks=${chunks} firstAudioMs=${firstAt || "NONE"} approxDurMs=${Math.round((bytes / 2 / 16000) * 1000)} err=${err || "none"}`,
  );
  await tts.cancel();
}

for (const [label, tokens] of Object.entries(STREAMS)) await run(label, tokens);
process.exit(0);
