// Simulated ESP32 device: connects over WebSocket exactly like the firmware and runs
// a MULTI-TURN session — stream an utterance, hear the reply, wait out the echo window,
// then speak again — measuring each turn from the device's point of view. Turn 1 is
// "cold" (prompt cache miss, fresh STT); turn 2+ are "warm".

import WebSocket from "ws";
import { splitFrames } from "./audio-util.js";

export interface SessionOptions {
  url: string;
  deviceId: string;
  language: string;
  token?: string;
  pcm: Buffer; // raw PCM16/16k utterance, reused for every turn
  frameBytes: number;
  frameMs: number;
  turns: number;
  trailingSilenceMs: number;
  interTurnGapMs: number; // wait after a reply (covers the echo-suppression tail) before speaking again
  perTurnTimeoutMs: number;
  quietAfterAudioMs: number;
  subprotocols?: string[]; // e.g. ['mitr-pcm16', 'mitr-token-<token>'] for prod web auth
  clientWeb?: boolean; // connect as the web client (client=web, token via subprotocol)
  sendStartStop?: boolean; // emit {type:'start'} / {type:'stop'} control (Pipecat/prod endpoints on these)
}

export interface TurnMetric {
  turnIndex: number;
  ok: boolean;
  utteranceEndToFirstSoundMs?: number; // you stop -> first audio heard (headline)
  firstSoundFromStreamStartMs?: number;
  wakeToFirstSoundMs?: number; // turn 1 only (awake event)
  responseAudioMs?: number;
  finalTranscript?: string;
  endReceived: boolean;
}

export interface SessionResult {
  ok: boolean;
  error?: string;
  connectToReadyMs?: number;
  turns: TurnMetric[];
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface TurnState {
  idx: number;
  streamStart: number;
  speechEnd: number;
  firstAudioIn: number;
  lastAudioIn: number;
  awakeAt: number;
  bytes: number;
  endReceived: boolean;
  finalTranscript: string;
  resolve: (() => void) | null;
  quietTimer: NodeJS.Timeout | null;
}

export async function runSession(opts: SessionOptions): Promise<SessionResult> {
  const qs = new URLSearchParams();
  qs.set("language", opts.language);
  if (opts.clientWeb) qs.set("client", "web");
  else qs.set("deviceId", opts.deviceId);
  const fullUrl = `${opts.url}${opts.url.includes("?") ? "&" : "?"}${qs.toString()}`;
  const headers: Record<string, string> = { "User-Agent": "mitr-bench-sim/0.2" };
  if (!opts.clientWeb) {
    headers["X-Mitr-Device-Id"] = opts.deviceId;
    headers["X-Mitr-Language"] = opts.language;
  }
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;

  return new Promise<SessionResult>((resolve) => {
    const ws = new WebSocket(fullUrl, opts.subprotocols ?? [], { headers });
    let tOpen = 0;
    let tReady = 0;
    let onReady: (() => void) | null = null;
    let cur: TurnState | null = null;
    const turns: TurnMetric[] = [];
    let fatal: string | undefined;
    let finished = false;

    const diff = (a: number, b: number) => (a && b ? Math.max(0, Math.round(b - a)) : undefined);

    function cleanup(): void {
      if (finished) return;
      finished = true;
      clearInterval(uplink);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve({
        ok: turns.some((t) => t.ok) && !fatal,
        error: fatal,
        connectToReadyMs: diff(tOpen, tReady),
        turns,
      });
    }

    function completeTurn(): void {
      if (cur?.resolve) {
        const r = cur.resolve;
        cur.resolve = null;
        if (cur.quietTimer) clearTimeout(cur.quietTimer);
        r();
      }
    }
    function armQuiet(): void {
      if (!cur) return;
      if (cur.quietTimer) clearTimeout(cur.quietTimer);
      cur.quietTimer = setTimeout(() => {
        if (cur?.firstAudioIn) completeTurn();
      }, opts.quietAfterAudioMs);
    }

    ws.on("open", () => {
      tOpen = Date.now();
    });
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        if (cur) {
          if (!cur.firstAudioIn) cur.firstAudioIn = Date.now();
          cur.bytes += data.length;
          cur.lastAudioIn = Date.now();
          armQuiet();
        }
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case "ready":
          tReady = Date.now();
          onReady?.();
          break;
        case "awake":
          if (cur && !cur.awakeAt) cur.awakeAt = Date.now();
          break;
        case "transcript":
          if (msg.status === "final" && cur) cur.finalTranscript = String(msg.text ?? "");
          break;
        case "end":
          if (cur) {
            cur.endReceived = true;
            completeTurn();
          }
          break;
        case "gateway_error":
          if (msg.fatal) {
            fatal = `gateway_error: ${String(msg.message ?? "")}`;
            cleanup();
          }
          break;
        default:
          break;
      }
    });
    ws.on("error", (err) => {
      fatal = String(err);
      cleanup();
    });
    ws.on("close", () => cleanup());

    // Continuous uplink like the real firmware: the ESP32 streams mic audio forever, so
    // between/after utterances the gateway must keep receiving SILENCE frames (provider
    // VADs stall without audio flow, which skews finalize latency by seconds).
    const silenceFrame = Buffer.alloc(opts.frameBytes);
    let utterQueue: Buffer[] = [];
    let onUtterDrained: (() => void) | null = null;
    const uplink = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const f = utterQueue.shift();
      ws.send(f ?? silenceFrame, { binary: true });
      if (f && utterQueue.length === 0 && onUtterDrained) {
        const cb = onUtterDrained;
        onUtterDrained = null;
        cb();
      }
    }, opts.frameMs);

    async function streamTurn(idx: number): Promise<void> {
      cur = {
        idx,
        streamStart: 0,
        speechEnd: 0,
        firstAudioIn: 0,
        lastAudioIn: 0,
        awakeAt: 0,
        bytes: 0,
        endReceived: false,
        finalTranscript: "",
        resolve: null,
        quietTimer: null,
      };
      cur.streamStart = Date.now();
      if (opts.sendStartStop && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "start", source: "mitr-bench-sim", ts: Date.now() }));
      }
      utterQueue = splitFrames(opts.pcm, opts.frameBytes);
      await new Promise<void>((res) => {
        onUtterDrained = () => {
          if (cur) cur.speechEnd = Date.now();
          // explicit end-of-turn for gateways that endpoint on control (Pipecat/prod web)
          if (opts.sendStartStop && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "stop", source: "mitr-bench-sim", ts: Date.now() }));
          }
          res();
        };
      });

      // wait for the reply to complete (end event or quiet-after-audio), bounded
      await new Promise<void>((res) => {
        cur!.resolve = res;
        setTimeout(() => {
          if (cur?.resolve) {
            const r = cur.resolve;
            cur.resolve = null;
            r();
          }
        }, opts.perTurnTimeoutMs);
      });

      const c = cur;
      turns.push({
        turnIndex: idx,
        ok: c.firstAudioIn > 0,
        utteranceEndToFirstSoundMs: diff(c.speechEnd, c.firstAudioIn),
        firstSoundFromStreamStartMs: diff(c.streamStart, c.firstAudioIn),
        wakeToFirstSoundMs: diff(c.awakeAt, c.firstAudioIn),
        responseAudioMs: c.bytes ? Math.round(((c.bytes >> 1) / 16000) * 1000) : undefined,
        finalTranscript: c.finalTranscript || undefined,
        endReceived: c.endReceived,
      });
    }

    (async () => {
      // wait for ready (bounded)
      await new Promise<void>((res) => {
        if (tReady) return res();
        onReady = res;
        setTimeout(res, 8000);
      });
      if (!tReady) {
        fatal = "no ready event";
        return cleanup();
      }
      ws.send(
        JSON.stringify(
          opts.clientWeb
            ? { type: "hello", client: "web", language: opts.language, ts: Date.now() }
            : { type: "hello", deviceId: opts.deviceId, language: opts.language, ts: Date.now() },
        ),
      );

      for (let k = 1; k <= opts.turns && !finished; k++) {
        await streamTurn(k);
        if (k < opts.turns) await delay(opts.interTurnGapMs); // wait out echo-suppression tail
      }
      cleanup();
    })();
  });
}
