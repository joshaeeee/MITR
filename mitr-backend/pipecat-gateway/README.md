# Mitr Pipecat Gateway

Pipecat is the active voice runtime for Mitr.

```text
ESP32/browser PCM16 mono -> WebSocket -> Pipecat -> OpenAI Realtime -> WebSocket -> ESP32/browser PCM16 mono
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
MITR_GATEWAY_WAKE_MODE=pipecat_phrase \
MITR_GATEWAY_WAKE_PHRASES="hi mitr,hey mitr,hi mitra,hey mitra,hi reca,hey reca,hi rekha,hey rekha,hi r e k a,hey r e k a,hi reka,hey reka,hi esp,hey esp,hi e s p,हाय मित्र,हे मित्र,हाय रेका,हाय रेखा" \
MITR_GATEWAY_WAKE_IDLE_TIMEOUT_SEC=45 \
OPENAI_REALTIME_TURN_DETECTION=manual \
MITR_GATEWAY_ECHO_SUPPRESSION=true \
MITR_GATEWAY_ECHO_SUPPRESSION_TAIL_MS=900 \
MITR_GATEWAY_TOOL_TIMEOUT_SEC=65 \
MITR_GATEWAY_BACKEND_TOOL_TIMEOUT_SEC=55 \
MITR_GATEWAY_TOOL_INPUT_SUPPRESSION_TAIL_MS=500 \
OPENAI_REALTIME_STT_LANGUAGE=en \
uv run python -m mitr_pipecat_gateway.server
```

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

Build the server wake phrase firmware:

```sh
idf.py -B build-gateway-server-wake \
  -DSDKCONFIG=build-gateway-server-wake/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.gateway;sdkconfig.defaults.gateway-server-wake" \
  -p /dev/cu.usbmodem101 flash monitor
```

Expected gateway logs:

```text
Pipecat wake phrase mode enabled
Pipecat wake phrase detected
OpenAI wake-phrase output audio started
```
