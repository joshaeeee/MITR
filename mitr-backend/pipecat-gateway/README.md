# Mitr Pipecat Gateway

Pipecat is the active voice runtime for Mitr.

```text
ESP32/browser PCM16 mono -> WebSocket -> Pipecat -> realtime voice model -> WebSocket -> ESP32/browser PCM16 mono
```

The Node/Fastify backend remains the source of truth for app auth, device auth,
sessions, telemetry, pairing, and user data. This gateway verifies device and web
connections against that backend before opening a voice pipeline.

## Protocol

- WebSocket endpoint: `/ws`
- Device auth: `Authorization: Bearer <deviceAccessToken>`
- Browser auth: request the `mitr-pcm16` WebSocket subprotocol plus a
  `mitr-token-<userAccessToken>` subprotocol. Do not put bearer tokens in the
  WebSocket URL.
- Identity hint: `X-Mitr-Device-Id` header or `?deviceId=...`
- Language hint: `X-Mitr-Language` header or `?language=hi-IN`
- Binary frames in: raw PCM16 mono, 16 kHz
- Binary frames out: raw PCM16 mono, 16 kHz
- Text events: `ready`, `listening`, `awake`, `sleeping`, `model_reconnecting`,
  `model_error`, `tool_event`

Device tokens are verified through:

```text
POST /devices/gateway/auth
```

Browser sessions are verified through:

```text
POST /pipecat/gateway/auth
```

For isolated local tests, set `MITR_GATEWAY_AUTH_MODE=local` and provide
`MITR_GATEWAY_LOCAL_DEVICE_ID`.

Tool calls are registered in Pipecat. When `MITR_BACKEND_INTERNAL_TOKEN` or
`INTERNAL_SERVICE_TOKEN` is set on the gateway, tool execution is bridged to the
Node backend through `POST /internal/pipecat/tool` so existing app services stay
the source of truth.

User-visible tools use Pipecat async function calls by default. The gateway sends
an intermediate result so Reca acknowledges the request immediately, then sends
the final result with `run_llm=true` so Reca confirms success or failure when the
backend finishes. Internal context tools such as `context_packet_get`,
`conversation_planner_get`, and `prompt_outcome_record` stay synchronous so hidden
context work does not produce spoken filler.

Controls:

```text
MITR_GATEWAY_ASYNC_TOOL_ACKS=true
MITR_GATEWAY_ASYNC_ACK_TOOLS=        # optional comma-list, supports *
MITR_GATEWAY_SYNC_TOOLS=             # optional comma-list for forced sync tools
MITR_GATEWAY_TOOL_FOLLOWUP_MIN_DELAY_SEC=1.2
```

## Context Summarization

The gateway enables Pipecat auto context summarization by default. Pipecat
compresses older conversation history when the built-in token or message
threshold is reached, while preserving the newest messages and function-call
sequences. Because OpenAI Realtime does not provide Pipecat's out-of-band
`run_inference()` hook, summaries are generated with a dedicated OpenAI text LLM.

Controls:

```text
MITR_GATEWAY_CONTEXT_SUMMARIZATION=true
MITR_GATEWAY_CONTEXT_SUMMARY_MODEL=gpt-4.1-mini
MITR_GATEWAY_CONTEXT_SUMMARY_MAX_CONTEXT_TOKENS=8000
MITR_GATEWAY_CONTEXT_SUMMARY_MAX_UNSUMMARIZED_MESSAGES=20
MITR_GATEWAY_CONTEXT_SUMMARY_TARGET_TOKENS=6000
MITR_GATEWAY_CONTEXT_SUMMARY_KEEP_MESSAGES=4
MITR_GATEWAY_CONTEXT_SUMMARY_TIMEOUT_SEC=120
MITR_GATEWAY_CONTEXT_SUMMARY_TEMPERATURE=0.2
MITR_GATEWAY_CONTEXT_SUMMARY_LOG_CONTENT=false
MITR_GATEWAY_CONTEXT_SUMMARY_LOG_MAX_CHARS=1200
```

Set `MITR_GATEWAY_CONTEXT_SUMMARY_MAX_CONTEXT_TOKENS` or
`MITR_GATEWAY_CONTEXT_SUMMARY_MAX_UNSUMMARIZED_MESSAGES` to `none` to disable
that trigger. At least one trigger must remain enabled. Set
`MITR_GATEWAY_CONTEXT_SUMMARY_LOG_CONTENT=true` during local testing to log the
inserted summary text after Pipecat applies compaction.

## System Prompt

The canonical Mitr voice prompt lives in:

```text
mitr_pipecat_gateway/prompts/mitr_system_prompt.md
```

Edit that markdown file to change the assistant behavior. The gateway reloads it
when a new Pipecat session starts, so restart the gateway after editing during
local tests.

Supported template variables:

```text
{auth.language} or {language}
{auth.device_id} or {device_id}
{auth.user_id} or {user_id}
{auth.family_id} or {family_id}
{auth.elder_id} or {elder_id}
{auth.timezone} or {timezone}
```

Unknown variables fail startup/session creation instead of falling back to an old
prompt.

Each session also appends a runtime clock block with the current user-local date,
time, weekday, local ISO timestamp, and UTC ISO timestamp. The timezone comes
from the verified auth response (`timezone` or `timeZone`), the websocket
`timezone` query parameter/header for local tests, or
`MITR_GATEWAY_DEFAULT_TIMEZONE` (`Asia/Kolkata` by default).

## Local Run

Start the Node API first:

```sh
cd /Users/shivanshjoshi/conductor/workspaces/Mitr/nairobi-v1/mitr-backend
DOTENV_CONFIG_PATH=/Users/shivanshjoshi/Mitr/mitr-backend/.env \
NODE_OPTIONS='-r dotenv/config' \
PORT=8081 \
./node_modules/.bin/tsx src/index.ts
```

Start the gateway:

```sh
cd /Users/shivanshjoshi/conductor/workspaces/Mitr/nairobi-v1/mitr-backend/pipecat-gateway
MITR_GATEWAY_PIPELINE_MODE=openai_realtime \
MITR_GATEWAY_DEFAULT_TIMEZONE=Asia/Kolkata \
MITR_GATEWAY_WAKE_PHRASES="hi mitr,hey mitr,hi mitra,hey mitra,hi reca,hey reca,hi rekha,hey rekha,hi r e k a,hey r e k a,hi reka,hey reka,hi esp,hey esp,hi e s p,हाय मित्र,हे मित्र,हाय रेका,हाय रेखा" \
MITR_GATEWAY_WAKE_IDLE_TIMEOUT_SEC=45 \
OPENAI_REALTIME_TURN_DETECTION=manual \
MITR_GATEWAY_ECHO_SUPPRESSION=true \
MITR_GATEWAY_ECHO_SUPPRESSION_TAIL_MS=900 \
MITR_GATEWAY_TOOL_TIMEOUT_SEC=65 \
MITR_GATEWAY_BACKEND_TOOL_TIMEOUT_SEC=55 \
MITR_GATEWAY_TOOL_INPUT_SUPPRESSION_TAIL_MS=500 \
MITR_GATEWAY_ASYNC_TOOL_ACKS=true \
MITR_GATEWAY_TOOL_FOLLOWUP_MIN_DELAY_SEC=1.2 \
OPENAI_REALTIME_STT_LANGUAGE=en \
uv run python -m mitr_pipecat_gateway.server
```

## OpenAI STT + ElevenLabs Experiment

The default pipeline stays OpenAI Realtime speech-to-speech. To test broader
spoken output language coverage, opt into the chained pipeline:

```sh
MITR_GATEWAY_PIPELINE_MODE=openai_llm_elevenlabs
OPENAI_REALTIME_STT_MODEL=gpt-4o-transcribe
OPENAI_REALTIME_STT_LANGUAGE=hi
OPENAI_LLM_MODEL=gpt-4.1-mini
OPENAI_LLM_MAX_TOKENS=512
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=...
ELEVENLABS_TTS_MODEL=eleven_turbo_v2_5
ELEVENLABS_TEXT_AGGREGATION_MODE=token
```

In this mode the gateway still uses the PCM WebSocket serializer, wake phrase
gate, runtime context injection, tool schemas, and `auth.language` prompt
rendering. The user language is passed to ElevenLabs from `auth.language` unless
`ELEVENLABS_TTS_LANGUAGE` is set. `ELEVENLABS_TEXT_AGGREGATION_MODE=token` is the
low-latency default; use `sentence` if quality is more important than first
audio latency.

## Wake UX

Default mode is server-side wake phrase detection:

```text
Hi Mitr / Hi Reca -> awake -> conversation continues -> 45 seconds of inactivity -> sleeping
```

The ESP/browser WebSocket stays open. If the OpenAI model session fails while the
client socket is still connected, the gateway emits `model_error` and
`model_reconnecting`, then starts a fresh Pipecat pipeline.

## Firmware

In `minimal/`, configure the gateway URL, backend URL, device ID, Wi-Fi, and
device access token:

```ini
CONFIG_MITR_GATEWAY_WS_URL="ws://192.168.x.x:7860/ws"
CONFIG_MITR_DEVICE_BACKEND_BASE_URL="http://192.168.x.x:8081"
```

Build the gateway firmware:

```sh
idf.py -B build-gateway \
  -DSDKCONFIG=build-gateway/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.gateway" \
  -p /dev/cu.usbmodem101 flash monitor
```

Expected gateway logs:

```text
Pipecat wake phrase mode enabled
Pipecat wake phrase detected
OpenAI wake-phrase output audio started
```

## Realtime 2 Experiment

Keep the stable wake runtime unchanged unless these experiment flags are set:

```sh
OPENAI_REALTIME_MODEL=gpt-realtime-2
OPENAI_REALTIME_REASONING_EFFORT=low
OPENAI_REALTIME_TRUNCATION=auto
```

`OPENAI_REALTIME_REASONING_EFFORT` and `OPENAI_REALTIME_TRUNCATION*` are
Realtime 2-only settings. The gateway fails fast if they are set with any model
other than `gpt-realtime-2`, so an experiment cannot silently send unsupported
session fields to the stable model.

Run the raw OpenAI websocket smoke test before using the ESP:

```sh
cd mitr-backend/pipecat-gateway
uv run python scripts/realtime2_smoke.py \
  --model gpt-realtime-2 \
  --reasoning-effort low \
  --truncation auto \
  --env-file ../.env
```

For long sessions, Realtime 2 truncation can also use a retention ratio:

```sh
OPENAI_REALTIME_MODEL=gpt-realtime-2
OPENAI_REALTIME_TRUNCATION=retention_ratio
OPENAI_REALTIME_TRUNCATION_RETENTION_RATIO=0.8
OPENAI_REALTIME_TRUNCATION_POST_INSTRUCTIONS_TOKEN_LIMIT=8000
```

## Gemini Live Experiment

The experiment keeps OpenAI realtime transcription for wake phrase detection and
swaps the speech-to-speech LLM to Gemini Live:

```sh
MITR_GATEWAY_REALTIME_PROVIDER=gemini_live
GOOGLE_API_KEY=...
GEMINI_LIVE_SERVICE=direct_sdk
GEMINI_LIVE_MODEL=models/gemini-3.1-flash-live-preview
GEMINI_LIVE_VOICE=Charon
GEMINI_LIVE_LANGUAGE=        # optional; defaults to auth.language
GEMINI_LIVE_PROMPT_MODE=shared
GEMINI_LIVE_ACTIVITY_MODE=manual
GEMINI_LIVE_AUDIO_SEND_PACING=false
GEMINI_LIVE_INPUT_BATCH_MS=20
GEMINI_LIVE_BACKLOG_INPUT_BATCH_MS=80
GEMINI_LIVE_PREROLL_FLUSH_BATCH_MS=80
GEMINI_LIVE_EXPLICIT_VAD_SIGNAL=false
GEMINI_LIVE_STALE_OUTPUT_GUARD_MS=0
GEMINI_LIVE_ECHO_SUPPRESSION_TAIL_MS=1200
GEMINI_LIVE_SERVER_VAD=true
GEMINI_LIVE_SERVER_VAD_START_MS=40
GEMINI_LIVE_SERVER_VAD_STOP_MS=120
GEMINI_LIVE_SERVER_VAD_PREROLL_MS=180
GEMINI_LIVE_SERVER_VAD_SPEECH_PEAK=0.035
GEMINI_LIVE_SERVER_VAD_SILENCE_PEAK=0.014
GEMINI_LIVE_PRECONNECT_ON_CONNECT=true
GEMINI_LIVE_PRECONNECT_BEFORE_LISTENING=false
GEMINI_LIVE_TRANSCRIPT_WAKE_PREROLL_SEC=0.5
GEMINI_LIVE_WAKE_IDLE_TIMEOUT_SEC=15
MITR_GATEWAY_WAKE_USE_INTERIM_TRANSCRIPTS=true
OPENAI_REALTIME_STT_LANGUAGE=        # optional; defaults to auth.language
OPENAI_REALTIME_WAKE_STT_MODEL=gpt-4o-mini-transcribe
MITR_GATEWAY_WAKE_STT_ASYNC_CONNECT=true
```

For latency, OpenAI realtime STT is only in the pre-wake path. The wake matcher
uses interim transcript deltas from `gpt-4o-mini-transcribe` by default, then
bypasses STT after `awake` so post-wake mic audio goes straight to the
speech-to-speech model. Gemini Live also uses a short 0.5 second transcript-wake
preroll by default instead of the generic 4 second wake buffer. The wake-STT
websocket connects in the background at startup; early wake audio is buffered
until the transcription session is ready.

The low-latency path uses the Google direct Live SDK by default, not the Pipecat
Gemini service wrapper. The gateway starts warming the Gemini Live session as
soon as the direct service is built, sends `listening` immediately, and uses
explicit `start`/`stop` turn controls plus a lightweight backend PCM VAD so
Gemini does not wait on browser or ESP silence timing before receiving
`activity_end`.
Gemini Live defaults to `GEMINI_LIVE_PROMPT_MODE=shared`, using the shared Mitr
voice prompt plus current time rules. Use `GEMINI_LIVE_PROMPT_MODE=compact`
only when you are explicitly chasing lower first-audio latency.
Keep `GEMINI_LIVE_PRECONNECT_BEFORE_LISTENING=false` unless you prefer slower
wake readiness in exchange for waiting until Gemini is fully connected.
The direct path drains wake-preroll and other queued audio in larger batches,
while live mic audio still uses small 20 ms batches.
For ESP32 hardware without local echo cancellation, the gateway hard-drops mic
audio and `start`/`stop` controls while assistant audio is estimated to be
playing, with `GEMINI_LIVE_ECHO_SUPPRESSION_TAIL_MS` as extra tail.
Gemini's wake idle timeout is separate from the stable OpenAI path and defaults
to 15 seconds. The timer refreshes on user turn activity, accepted assistant
audio, and tool-call progress.

Gemini Live produces 24 kHz PCM output. Leave `ESP32_AUDIO_OUT_SAMPLE_RATE`
unset for the Gemini experiment, or set it to `24000`; forcing `16000` adds a
resampling step.

Known limits in this experiment:

- `OPENAI_API_KEY` is still required for wake phrase transcription and context
  summarization.
- Runtime context packet updates are not injected into an active Gemini Live
  session.
- Gemini function calls are enabled on the direct SDK path; tools that require
  the verified backend still return `backend_required` in local simulator-only
  runs.
