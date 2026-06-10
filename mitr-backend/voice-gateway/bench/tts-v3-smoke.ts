import { ElevenLabsHttpTts } from "../src/providers/tts-elevenlabs-http.js";

// 3 sentences streamed like an LLM. With sequential synthesis each inter-sentence gap pays
// ~600ms TTFB; with pipelining (concurrency 2) sentences 2+ should already be buffered when
// the previous one finishes -> emission gaps near zero and total wall-time much shorter.
const TOKENS = [
  "\n", "Good", " morning", "!", " A", " short", " walk", " in", " the", " park", " sounds", " perfect", ".",
  " Maybe", " grab", " some", " chai", " on", " the", " way", " back", " home", ".",
  " And", " call", " an", " old", " friend", " while", " you", " sip", " it", ".",
];

const tts = new ElevenLabsHttpTts();
let chunks = 0,
  bytes = 0,
  err = "";
const start = Date.now();
const gaps: number[] = [];
let lastChunkAt = 0;
let firstAt = 0;
let doneAt = 0;
tts.onAudio((pcm) => {
  const now = Date.now();
  if (!firstAt) firstAt = now - start;
  else gaps.push(now - lastChunkAt);
  lastChunkAt = now;
  chunks++;
  bytes += pcm.length;
});
tts.onDone(() => (doneAt = Date.now() - start));
tts.onError((e) => (err = err || e.message.slice(0, 140)));
await tts.connect();
for (const t of TOKENS) {
  tts.appendText(t);
  await new Promise((r) => setTimeout(r, 20));
}
tts.finish();
await new Promise((r) => setTimeout(r, 20000));
const maxGap = gaps.length ? Math.max(...gaps) : 0;
console.log(
  JSON.stringify({
    chunks,
    firstAudioMs: firstAt || null,
    allReceivedMs: doneAt || null,
    audioDurationMs: Math.round((bytes / 2 / 16000) * 1000),
    maxInterChunkGapMs: maxGap, // sequential would show ~600ms+ gaps at sentence joins
    err: err || null,
  }),
);
process.exit(0);
