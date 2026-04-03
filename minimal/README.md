# Mitr ESP32 LiveKit Device Starter

This ESP-IDF app replaces the old browser bridge demo with a production-oriented starter for `ESP32-S3-WROOM`.

Path:

1. Device connects to Wi-Fi
2. If needed, device exchanges a one-time pairing token with `POST /devices/bootstrap/complete`
3. Device stores the long-lived device credential locally
4. Device authenticates to Mitr backend with that long-lived credential
5. Backend returns a short-lived LiveKit participant token via `POST /devices/token`
6. Device joins a LiveKit room directly
7. Device publishes mic audio and subscribes to speaker audio
8. Device sends heartbeat, telemetry, and session-end events back to Mitr backend

This is the production starter path. The browser bridge is no longer the primary firmware flow here.

## What is implemented

- backend token fetch via `POST /devices/token`
- bootstrap exchange via `POST /devices/bootstrap/complete`
- direct LiveKit room join
- audio publish + subscribe wiring through the LiveKit ESP32 SDK
- heartbeat via `POST /devices/heartbeat`
- telemetry via `POST /devices/telemetry`
- session end via `POST /devices/session/end`
- always-connected session recovery with fresh-room retries instead of reboot-on-failure
- A/B OTA partition layout with pending-verify rollback support
- basic RPC hooks:
  - `mitr_ping`
  - `mitr_get_device_status`
  - `mitr_get_diagnostics`
  - `mitr_set_mute`
  - `mitr_restart_session`
- device events on the data channel topic `mitr.device_event`

## What still needs real hardware validation

The transport/control-plane path, recovery loop, and OTA plumbing are now implemented in repo. The remaining release work is physical validation:

- verify BLE onboarding on real Android and iOS devices
- verify the OTA update + rollback path on real hardware
- run soak tests on real home Wi-Fi and confirm the reconnect policy is stable enough for pilot

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

## Device credentials

There are now two supported bootstrapping modes:

1. Direct access-token mode
   - put the long-lived `deviceAccessToken` into firmware config
2. Pairing-token bootstrap mode
   - put the one-time pairing token into firmware config
   - on first successful internet connection the device exchanges it for the long-lived credential and stores that locally

### Create a device credential for local smoke testing

Fastest local helper:

```sh
cd /Users/shivanshjoshi/Mitr/mitr-backend
pnpm smoke:device-flow -- --device-id mitr-esp32-001 --email tester@example.com
```

That prints a `deviceAccessToken`. Put that token into the ESP32 firmware config, or use the new pairing APIs for the production bootstrap path.

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
- `Device ID`
- `Device access token`
- `One-time pairing token`
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

You can rewrite `sdkconfig` quickly with an access token:

```sh
./set-device-config.sh 192.168.x.x 8081 access:<device-access-token>
```

Optional extra args:

```sh
./set-device-config.sh 192.168.x.x 8081 access:<device-access-token> hi-IN esp32-s3-wroom v0.1.0-dev mitr-esp32-001
```

Or with a one-time pairing token:

```sh
./set-device-config.sh https://api.heyreca.com pairing:<pairing-token> hi-IN esp32-s3-wroom v0.1.0-dev mitr-esp32-001
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
- if only a pairing token is present, bootstrap completes and the long-lived credential is stored
- token fetch succeeds
- room state transitions to `CONNECTED`
- agent participant joins the room
- heartbeats continue successfully
- room failures trigger recovery and fresh-room retries instead of parking until reboot
- diagnostics RPCs return Wi-Fi / heap / OTA state
- OTA recommendations appear in heartbeat responses when `firmware_releases` recommends a newer version

You should also see backend-side `device_sessions`, `device_telemetry`, and heartbeat activity.

## Repo references

- production architecture: [mitr-backend/docs/esp32-production-architecture.md](/Users/shivanshjoshi/Mitr/mitr-backend/docs/esp32-production-architecture.md)
- firmware entrypoint: [minimal/main/main.c](/Users/shivanshjoshi/Mitr/minimal/main/main.c)
- backend device routes: [mitr-backend/src/routes/device.ts](/Users/shivanshjoshi/Mitr/mitr-backend/src/routes/device.ts)
