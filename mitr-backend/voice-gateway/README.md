# mitr-voice-gateway

A lightweight, **no-framework** voice gateway for the Mitr ESP32 device — a drop-in
replacement for the Pipecat gateway that talks **directly** to provider APIs. Built to
(a) cut the latency/overhead Pipecat adds, and (b) move off expensive realtime
speech-to-speech models onto a **STT → LLM → TTS cascade** so we can use the ElevenLabs
and Sarvam grants.

> **The device link is plain WebSocket carrying raw PCM16, not WebRTC.** This gateway
> speaks the exact same wire protocol as the Pipecat gateway, so **the ESP32 firmware
> needs zero changes** — point `CONFIG_MITR_GATEWAY_WS_URL` at this server and go.

## Architecture

```
ESP32 ──WS(binary PCM16 16k, 20ms)──▶  voice-gateway  ──▶ ElevenLabs Scribe v2 STT (wss)
  ▲                                        │  wake matcher + energy VAD endpointer
  │                                        ▼
  └──WS(binary PCM16 16k, paced)──────  ElevenLabs Flash v2.5 TTS ◀── Claude (streaming + tools)
```

- **Transport** (`server.ts`, `auth.ts`): WS `/ws`, `Authorization: Bearer` + `X-Mitr-Device-Id`/`?deviceId`
  auth (verified via backend `/devices/gateway/auth`, or `local` mode for dev). First server
  frame is the `ready` event. Binary = PCM16/16k; JSON = control.
- **Wake** (`wake/matcher.ts`): server-side (the device streams continuously). Faithful port of
  the Pipecat unicode matcher — NFC-normalize, dual rolling buffers, `\s*`-joined regex,
  Devanagari + STT-misrecognition aliases (e.g. "Mitr"→"Miter"), interim-transcript matching.
- **Endpointing** (`audio/vad.ts`): the firmware never signals end-of-turn, so an energy VAD
  with hysteresis derives speech start/stop and triggers STT finalize + the LLM.
- **STT/TTS/LLM** (`providers/`): swappable behind interfaces (`types.ts`). ElevenLabs cascade
  is native `pcm_16000` end-to-end → **zero resampling** for the ESP32 wire.
- **Pacing** (`audio/pacer.ts`): the device playback queue is only ~480 ms deep and drops on
  overflow, so outbound TTS is paced to ~real-time (first frame still goes out immediately).
- **Echo suppression** (`session.ts`): half-duplex — drop mic input while the device plays TTS
  (+ tail) and during tool calls (the ESP32 has no AEC). Barge-in disabled, like Pipecat.
- **Tools** (`tools/bridge.ts`): Claude tool-use → `POST /internal/pipecat/tool` on the backend
  with the internal token. Same HTTP contract as Pipecat, so existing tools work unchanged.
- **Latency** (`latency.ts`): per-turn marks (speechEnd→sttFinal→llmTTFT→ttsFirstChunk→firstAudioOut)
  logged as JSON and optionally appended to a JSONL sink for benchmarking.

## Run

```bash
pnpm install --ignore-workspace
cp .env.example .env        # fill in ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, ANTHROPIC_API_KEY
pnpm serve                  # tsx src/server.ts  (default :7861, alongside Pipecat's :7860)
```

Point firmware/sim at `ws://<host>:7861/ws`. `MITR_GATEWAY_AUTH_MODE=local` skips backend auth.

### Providers

`MITR_GATEWAY_{STT,TTS,LLM}_PROVIDER`. Default `elevenlabs` / `elevenlabs` / `claude`.
`LLM=echo` is an offline stub that streams a canned reply — used to benchmark the audio loop
without an LLM key. Sarvam adapters are a fast-follow (`Saaras v3` STT, `Bulbul v3` TTS, 24k→16k).

## Benchmark (local simulated ESP32)

```bash
pnpm bench:make-audio "Hey Mitr. How are you today?"   # synth a canned utterance (ElevenLabs)
pnpm serve &                                            # start this gateway
BENCH_TRIALS=5 pnpm bench "new=ws://localhost:7861/ws" "pipecat=ws://localhost:7860/ws"
```

`bench/sim-device.ts` connects exactly like the firmware, streams the utterance as 20 ms PCM16
frames in real time, and measures from the **device's** point of view:

| metric | meaning |
|---|---|
| `connect → ready` | WS open to `ready` event |
| `speech start → wake` | utterance start to server `awake` (wake-word detect) |
| `you stop → first sound` ★ | **the number a user feels** — end of *speech* to first audio byte heard |
| `speech start → first sound` | full utterance start to first audio |
| `response audio length` | duration of Mitr's spoken reply |

`★` measures from end-of-speech (before trailing-silence padding), so it includes the VAD
hangover (`MITR_GATEWAY_VAD_SILENCE_MS`, default 700 ms) — the single biggest tunable lever.

### First live result (echo LLM, laptop → ElevenLabs over public internet)

```
you stop → first sound   p50 1629ms / p95 1724ms
speech start → wake       p50 2576ms
STT heard: "Hey, Miter. How are you doing today? ..."  (wake alias caught "Miter")
```

With Claude swapped in, replace the ~360 ms echo with Claude TTFT (~0.4–0.7 s). Co-locating the
gateway in ElevenLabs' region and trimming the VAD hangover are the paths to sub-second.

## Status / TODO

- ✅ ElevenLabs cascade (Scribe v2 STT → LLM → Flash v2.5 TTS), wake, VAD, echo suppression,
  pacing, latency instrumentation, local benchmark harness — **working end-to-end on live APIs.**
- ⬜ `ANTHROPIC_API_KEY` not found in repo env — set it to benchmark the real Claude path.
- ⬜ Sarvam STT/TTS adapters (fast-follow).
- ⬜ Stand up the Pipecat gateway locally (cascade mode, `MITR_GATEWAY_AUTH_MODE=local`) for the
  head-to-head column.
- ⬜ Full ~45-tool schema parity (the bridge already executes any tool name).
- ⬜ Deploy: `Dockerfile` + compose service + nginx `/ws2` route for prod A/B.
```
