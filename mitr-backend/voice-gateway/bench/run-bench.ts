// Multi-turn benchmark runner. Drives each gateway with the simulated ESP32 client for
// N turns per session and reports per-turn latency (turn 1 = cold, turn 2+ = warm) so
// the prompt-cache / warm-connection speedup is visible.
//
//   pnpm bench "new=ws://localhost:7861/ws" "pipecat=ws://localhost:7860/ws"
//   BENCH_TRIALS=4 BENCH_TURNS=3 pnpm bench
//
// Requires bench/audio/utterance.pcm (run `pnpm bench:make-audio` first).

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "../src/config.js";
import { wavToPcm, percentile, mean } from "./audio-util.js";
import { runSession, type TurnMetric } from "./sim-device.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUDIO_DIR = join(__dirname, "audio");
const RESULTS_DIR = join(__dirname, "results");

const TRIALS = Number.parseInt(process.env.BENCH_TRIALS ?? "3", 10);
const TURNS = Number.parseInt(process.env.BENCH_TURNS ?? "3", 10);
const DEVICE_ID = process.env.BENCH_DEVICE_ID ?? "bench-device";
const LANGUAGE = process.env.BENCH_LANGUAGE ?? "en-IN";
const TOKEN = process.env.BENCH_TOKEN || undefined;
const FRAME_MS = config.audioPacketMs;
const FRAME_BYTES = Math.floor((config.audioInSampleRate * FRAME_MS) / 1000) * 2;
const INTER_TURN_GAP_MS = Number.parseInt(
  process.env.BENCH_INTERTURN_GAP_MS ?? String(config.echoSuppressionTailMs + 800),
  10,
);
const QUIET_AFTER_AUDIO_MS = Number.parseInt(process.env.BENCH_QUIET_MS ?? "4000", 10);

// Prod (live) auth — used when a target URL is http(s):// instead of ws://.
const PROD_EMAIL = process.env.BENCH_PROD_EMAIL;
const PROD_PASSWORD = process.env.BENCH_PROD_PASSWORD;
const PROD_TOKEN = process.env.BENCH_PROD_TOKEN;

async function prodConnect(baseUrl: string): Promise<{ wsUrl: string; token: string }> {
  const base = baseUrl.replace(/\/+$/, "");
  let token = PROD_TOKEN ?? "";
  if (!token) {
    if (!PROD_EMAIL || !PROD_PASSWORD) {
      throw new Error("prod target needs BENCH_PROD_EMAIL/BENCH_PROD_PASSWORD or BENCH_PROD_TOKEN");
    }
    const r = await fetch(`${base}/auth/email/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: PROD_EMAIL, password: PROD_PASSWORD }),
    });
    if (!r.ok) throw new Error(`login ${r.status}: ${(await r.text()).slice(0, 120)}`);
    const b = (await r.json()) as { session?: { accessToken?: string } };
    token = String(b.session?.accessToken ?? "");
    if (!token) throw new Error("login returned no accessToken");
  }
  const c = await fetch(`${base}/pipecat/connect`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ language: LANGUAGE, participantName: "voice-bench" }),
  });
  if (!c.ok) throw new Error(`/pipecat/connect ${c.status}: ${(await c.text()).slice(0, 120)}`);
  const cj = (await c.json()) as { wsUrl?: string };
  const wsUrl = String(cj.wsUrl ?? "");
  if (!wsUrl) throw new Error("/pipecat/connect returned no wsUrl");
  return { wsUrl, token };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (n: number) => (Number.isFinite(n) ? `${Math.round(n)}ms` : "—");

function loadUtterance(): Buffer {
  try {
    return readFileSync(join(AUDIO_DIR, "utterance.pcm"));
  } catch {
    try {
      return wavToPcm(readFileSync(join(AUDIO_DIR, "utterance.wav"))).pcm;
    } catch {
      throw new Error("No bench/audio/utterance.pcm — run `pnpm bench:make-audio` first.");
    }
  }
}

function parseTargets(): Array<{ label: string; url: string }> {
  const args = process.argv.slice(2);
  if (args.length === 0) return [{ label: "new", url: "ws://localhost:7861/ws" }];
  return args.map((a) => {
    const eq = a.indexOf("=");
    return eq > 0 ? { label: a.slice(0, eq), url: a.slice(eq + 1) } : { label: a, url: a };
  });
}

async function benchmarkTarget(label: string, url: string, pcm: Buffer) {
  const byTurn = new Map<number, TurnMetric[]>();
  const isProd = url.startsWith("http");
  let connectUrl = url;
  let subprotocols: string[] | undefined;
  let clientWeb = false;
  let sendStartStop = false;
  if (isProd) {
    try {
      const pc = await prodConnect(url);
      connectUrl = pc.wsUrl;
      subprotocols = ["mitr-pcm16", `mitr-token-${pc.token}`];
      clientWeb = true;
      sendStartStop = true; // prod web client endpoints on start/stop control
      console.log(`\n▶ ${label}  (prod ${pc.wsUrl}) — ${TRIALS} sessions × ${TURNS} turns [web client]`);
    } catch (e) {
      console.log(`\n▶ ${label}: prod connect FAILED — ${String(e)}`);
      return { label, byTurn };
    }
  } else {
    console.log(`\n▶ ${label}  (${url}) — ${TRIALS} sessions × ${TURNS} turns`);
  }
  for (let s = 0; s < TRIALS; s++) {
    const res = await runSession({
      url: connectUrl,
      deviceId: DEVICE_ID,
      language: LANGUAGE,
      token: TOKEN,
      pcm,
      frameBytes: FRAME_BYTES,
      frameMs: FRAME_MS,
      turns: TURNS,
      trailingSilenceMs: 1100,
      interTurnGapMs: INTER_TURN_GAP_MS,
      perTurnTimeoutMs: 40000,
      quietAfterAudioMs: QUIET_AFTER_AUDIO_MS,
      subprotocols,
      clientWeb,
      sendStartStop,
    });
    const line = res.turns
      .map((t) => `t${t.turnIndex}=${t.ok ? fmt(t.utteranceEndToFirstSoundMs ?? NaN) : "FAIL"}`)
      .join(" ");
    console.log(`  session ${s + 1}/${TRIALS}: ${line}${res.error ? `  (${res.error})` : ""}`);
    for (const t of res.turns) {
      if (!byTurn.has(t.turnIndex)) byTurn.set(t.turnIndex, []);
      byTurn.get(t.turnIndex)!.push(t);
    }
    await sleep(800);
  }
  return { label, byTurn };
}

function turnStats(metrics: TurnMetric[]) {
  const vals = metrics.filter((m) => m.ok).map((m) => m.utteranceEndToFirstSoundMs!).filter(Number.isFinite);
  return { p50: percentile(vals, 50), p95: percentile(vals, 95), mean: mean(vals), n: vals.length };
}

async function main(): Promise<void> {
  const pcm = loadUtterance();
  const uttMs = Math.round(((pcm.length >> 1) / 16000) * 1000);
  console.log(
    `Utterance: ${uttMs}ms · ${FRAME_BYTES}B/${FRAME_MS}ms frames · inter-turn gap ${INTER_TURN_GAP_MS}ms · metric: you-stop->first-sound`,
  );

  const targets = parseTargets();
  const results = [];
  for (const tgt of targets) results.push(await benchmarkTarget(tgt.label, tgt.url, pcm));

  console.log("\n=== Per-turn latency (you stop -> first sound, p50 / p95) ===");
  const turnIdxs = Array.from({ length: TURNS }, (_, i) => i + 1);
  const col = 20;
  let head = "target".padEnd(16);
  for (const ti of turnIdxs) head += `turn ${ti}`.padEnd(col);
  head += "cold→warm";
  console.log(head);
  console.log("-".repeat(head.length));
  for (const { label, byTurn } of results) {
    let row = label.padEnd(16);
    const stats = turnIdxs.map((ti) => turnStats(byTurn.get(ti) ?? []));
    for (const st of stats) row += `${fmt(st.p50)} / ${fmt(st.p95)}`.padEnd(col);
    const cold = stats[0]?.p50 ?? NaN;
    const warm = stats[stats.length - 1]?.p50 ?? NaN;
    const delta = Number.isFinite(cold) && Number.isFinite(warm) ? `−${Math.round(cold - warm)}ms` : "—";
    row += delta;
    console.log(row);
  }
  console.log("\nturn 1 = cold (prompt-cache miss, fresh STT); later turns = warm.");

  mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(RESULTS_DIR, `bench-${stamp}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        trials: TRIALS,
        turns: TURNS,
        utteranceMs: uttMs,
        results: results.map((r) => ({ label: r.label, byTurn: Object.fromEntries(r.byTurn) })),
      },
      null,
      2,
    ),
  );
  console.log(`\nSaved raw results to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
