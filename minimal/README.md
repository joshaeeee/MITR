# Mitr ESP32 LiveKit Device Starter

This ESP-IDF app replaces the old browser bridge demo with a production-oriented starter for `ESP32-S3-WROOM`.

Path:

1. Device connects to Wi-Fi
2. Device authenticates to Mitr backend with its long-lived device credential
3. Backend returns a short-lived LiveKit participant token via `POST /devices/token`
4. Device joins a LiveKit room directly
5. Device publishes mic audio and subscribes to speaker audio
6. Device sends heartbeat, telemetry, and session-end events back to Mitr backend

This is the production starter path. The browser bridge is no longer the primary firmware flow here.

## What is implemented

- backend token fetch via `POST /devices/token`
- direct LiveKit room join
- audio publish + subscribe wiring through the LiveKit ESP32 SDK
- heartbeat via `POST /devices/heartbeat`
- telemetry via `POST /devices/telemetry`
- session end via `POST /devices/session/end`
- basic RPC hooks:
  - `mitr_ping`
  - `mitr_get_device_status`

## Important limitation

The transport/control-plane path is implemented here, but exact board bring-up is still hardware-specific.

The repo currently uses the LiveKit example audio board abstraction in `main/board.c` and `main/media.c`. If your exact `ESP32-S3-WROOM` hardware uses a raw MAX98357A + I2S mic path instead of a supported codec board, you still need to adapt those files using the LiveKit `custom_hardware` example as the reference.

The production control plane is now in place. The last hardware-specific step is the codec/I2S layer.

## Backend prerequisites

Your Mitr backend must have:

- LiveKit configured
- the `/devices/*` routes migrated and running

Run the backend on a reachable LAN or production origin. For local development:

```sh
cd /Users/shivanshjoshi/Mitr/mitr-backend
pnpm drizzle:migrate
PORT=8081 pnpm dev:api
```

## Create a device credential

Fastest local helper:

```sh
cd /Users/shivanshjoshi/Mitr/mitr-backend
pnpm smoke:device-flow -- --device-id mitr-esp32-001 --email tester@example.com
```

That prints a `deviceAccessToken`. Put that token into the ESP32 firmware config.

## Configuration

Open:

```sh
idf.py menuconfig
```

Set:

### LiveKit Example Utilities

- Wi-Fi SSID
- Wi-Fi password

### Mitr ESP32 Device

- `Codec board type`
- `Default speaker volume`
- `Mitr backend base URL`
- `Device access token`
- `Preferred language`
- `Hardware revision`
- `Firmware version`
- `Heartbeat interval`

Important:

- `Mitr backend base URL` must be reachable by the device
- use your backend LAN IP for local development, not `localhost`
- for local dev it will usually look like:

```ini
CONFIG_MITR_DEVICE_BACKEND_BASE_URL="http://192.168.x.x:8081"
```

## Helper script

You can rewrite `sdkconfig` quickly with:

```sh
./set-device-config.sh 192.168.x.x 8081 <device-access-token>
```

Optional extra args:

```sh
./set-device-config.sh 192.168.x.x 8081 <device-access-token> hi-IN esp32-s3-wroom v0.1.0-dev
```

## Build and flash

```sh
source ~/esp/esp-idf/export.sh
idf.py build
idf.py -p /dev/cu.usbmodem1101 flash
idf.py -p /dev/cu.usbmodem1101 monitor
```

The first `idf.py build` after these manifest changes will refresh `dependencies.lock`.

Verified locally on `2026-04-01` with `ESP-IDF v5.4.2`.

## Expected boot flow

Healthy signs:

- board/audio init succeeds
- Wi-Fi connects
- device logs the backend URL and firmware metadata
- token fetch succeeds
- room state transitions to `CONNECTED`
- agent participant joins the room
- heartbeats continue successfully

You should also see backend-side `device_sessions`, `device_telemetry`, and heartbeat activity.

## Repo references

- production architecture: [mitr-backend/docs/esp32-production-architecture.md](/Users/shivanshjoshi/Mitr/mitr-backend/docs/esp32-production-architecture.md)
- firmware entrypoint: [minimal/main/main.c](/Users/shivanshjoshi/Mitr/minimal/main/main.c)
- backend device routes: [mitr-backend/src/routes/device.ts](/Users/shivanshjoshi/Mitr/mitr-backend/src/routes/device.ts)
