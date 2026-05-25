# Mitr ESP32 Pipecat Device

This ESP-IDF app is the active Mitr ESP32 voice firmware. It uses a raw PCM
WebSocket to the Pipecat gateway; the backend remains responsible for device
auth, bootstrap, heartbeat, telemetry, and OTA metadata.

## Boot Flow

1. Device connects to Wi-Fi.
2. If needed, device exchanges a one-time pairing token with
   `POST /devices/bootstrap/complete`.
3. Device stores the long-lived device credential locally.
4. Device authenticates to Mitr backend with that credential.
5. Backend returns Pipecat gateway connection metadata.
6. Device opens the Pipecat gateway WebSocket.
7. Device streams mic PCM and plays response PCM from the gateway.
8. Device sends heartbeat, telemetry, and session-end events to Mitr backend.

## Implemented

- bootstrap exchange via `POST /devices/bootstrap/complete`
- Pipecat session metadata via `POST /devices/session/open` and
  `POST /devices/token`
- PCM16 mono WebSocket transport to the Pipecat gateway
- backend wake phrase mode
- heartbeat via `POST /devices/heartbeat`
- telemetry via `POST /devices/telemetry`
- session end via `POST /devices/session/end`
- A/B OTA partition layout with pending-verify rollback support

## Backend Prerequisites

Run the API on a LAN-reachable host:

```sh
cd /Users/shivanshjoshi/conductor/workspaces/Mitr/nairobi-v1/mitr-backend
DOTENV_CONFIG_PATH=/Users/shivanshjoshi/Mitr/mitr-backend/.env \
NODE_OPTIONS='-r dotenv/config' \
PORT=8081 \
./node_modules/.bin/tsx src/index.ts
```

Run the Pipecat gateway:

```sh
cd /Users/shivanshjoshi/conductor/workspaces/Mitr/nairobi-v1/mitr-backend/pipecat-gateway
MITR_GATEWAY_WAKE_PHRASES="hi mitr,hey mitr,hi mitra,hey mitra,hi reca,hey reca,hi rekha,hey rekha,hi r e k a,hey r e k a,hi reka,hey reka,hi esp,hey esp,hi e s p,हाय मित्र,हे मित्र,हाय रेका,हाय रेखा" \
MITR_GATEWAY_WAKE_IDLE_TIMEOUT_SEC=45 \
OPENAI_REALTIME_STT_LANGUAGE=en \
uv run python -m mitr_pipecat_gateway.server
```

## Device Credentials

Two bootstrapping modes are supported:

- Direct access-token mode: put the long-lived `deviceAccessToken` into firmware
  config.
- Pairing-token mode: put a one-time pairing token into firmware config; the
  device exchanges it for a long-lived credential on first boot.

Local smoke helper:

```sh
cd /Users/shivanshjoshi/conductor/workspaces/Mitr/nairobi-v1/mitr-backend
pnpm smoke:device-flow -- --device-id mitr-esp32-001 --email tester@example.com
```

## Configuration

Open menuconfig:

```sh
idf.py menuconfig
```

Set:

- Wi-Fi SSID
- Wi-Fi password
- `Mitr backend base URL`
- `Device ID`
- `Device access token` or `One-time pairing token`
- `Preferred language`
- `Pipecat gateway WebSocket URL`

For local development, use your Mac LAN IP, not `localhost`:

```ini
CONFIG_MITR_DEVICE_BACKEND_BASE_URL="http://192.168.x.x:8081"
CONFIG_MITR_GATEWAY_WS_URL="ws://192.168.x.x:7860/ws"
```

## Build And Flash

```sh
source /Users/shivanshjoshi/esp-idf/export.sh
idf.py -B build-gateway \
  -DSDKCONFIG=build-gateway/sdkconfig \
  -DSDKCONFIG_DEFAULTS="sdkconfig.defaults;sdkconfig.defaults.gateway" \
  build
idf.py -B build-gateway -p /dev/cu.usbmodem101 flash monitor
```

## Expected Runtime

Healthy signs:

- board/audio init succeeds
- Wi-Fi connects
- bootstrap/access-token check succeeds
- gateway websocket connects
- gateway sends `ready` and `listening`
- saying "Hi Mitr" or "Hi Reca" wakes the gateway
- response PCM plays through the speaker
- gateway sends `sleeping` after 45 seconds of inactivity
- heartbeat and telemetry continue while the socket remains connected

## References

- firmware entrypoint: `minimal/main/main.c`
- gateway client: `minimal/main/gateway_client.c`
- backend device routes: `mitr-backend/src/routes/device.ts`
- Pipecat gateway: `mitr-backend/pipecat-gateway`
