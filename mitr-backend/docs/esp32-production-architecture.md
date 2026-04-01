# ESP32 Production Architecture

This document describes the production path for Mitr on `ESP32-S3-WROOM` after the local browser/bridge experiment proved the voice loop can work end to end.

## Summary

- Keep the existing **Mitr backend + LiveKit agent worker** as the canonical backend.
- Use **LiveKit Cloud** as the media plane for production.
- Target a **LiveKit-native ESP32 client** as the main production path.
- Keep an **Espressif WebRTC fallback path** available only if pilot stability proves the current LiveKit ESP32 SDK is not ready for launch on our hardware.
- Treat the current browser/bridge setup as a **debug harness only**, not production infrastructure.

## Why This Direction

The goal is not to build a custom realtime media stack from zero. The goal is to get a production-grade embedded voice client onto the existing Mitr voice platform with low latency, reconnect resilience, and a clean device-to-user identity model.

The key change in the ecosystem is that:

- LiveKit now has an official ESP32 SDK for `ESP32-S3`.
- Espressif now has an official WebRTC stack that supports the embedded-side media path and custom signaling patterns.

That changes the architecture decision. We should reuse those layers and keep our custom logic focused on:

- device identity
- claim/provision flow
- backend token minting
- telemetry
- firmware lifecycle
- mapping `device_id -> user_id`

## Production Architecture

### Device layers

Build firmware in four layers:

1. **Audio HAL**
   - I2S
   - codec init
   - speaker amp enable/mute
   - microphone gain/input config
   - wake/input buttons

2. **Provisioning + identity**
   - BLE-first provisioning
   - proof-of-possession
   - persistent `device_id`
   - encrypted on-device credential storage

3. **Transport**
   - primary: LiveKit ESP32 SDK
   - fallback: Espressif `esp_webrtc`

4. **Application runtime**
   - session start/stop
   - reconnect logic
   - telemetry
   - OTA
   - data-channel control handlers

### Cloud layers

Keep the current split:

- **Mitr backend**
  - device claim
  - device auth
  - LiveKit token minting
  - device telemetry/session APIs
  - device-to-user mapping

- **LiveKit Cloud**
  - WebRTC transport
  - TURN/TCP/443 fallback
  - room routing
  - participant metadata
  - agent dispatch

- **Mitr agent worker**
  - unchanged core voice logic
  - device appears as another LiveKit participant

### Identity model

- `user_id` is the source of truth for:
  - memory
  - reminders
  - agent context

- `device_id` is the source of truth for:
  - hardware identity
  - claim state
  - firmware version
  - telemetry
  - fleet operations

Every production room/session must carry both.

### Room/session model

- one active room per live device conversation
- participant metadata must include:
  - `user_id`
  - `device_id`
  - `language`
  - `firmware_version`
  - `hardware_rev`

### v1 media defaults

- audio only
- Opus
- mono
- `16 kHz`
- AEC enabled
- device joins rooms only for active sessions, not permanent idle presence

## Backend Control Plane

The backend should provide:

- `POST /devices/claim/start`
- `POST /devices/claim/complete`
- `GET /devices/claimed`
- `POST /devices/revoke`
- `POST /devices/token`
- `POST /devices/heartbeat`
- `POST /devices/telemetry`
- `POST /devices/session/end`

Core entities:

- `devices`
- `device_claims`
- `device_sessions`
- `device_telemetry`
- `firmware_releases`

Required behavior:

- device stores a long-lived credential
- backend mints a short-lived LiveKit JWT
- backend decides dispatch metadata
- backend preserves user-scoped agent behavior

## Transport Strategy

### Primary path: LiveKit-native

Use the official LiveKit ESP32 SDK, but treat it as pilot-gated because the SDK is still marked Developer Preview.

Implementation target:

- adapt `voice_agent` / `custom_hardware` example to our board
- handle board-specific codec / I2S / power-rail bring-up
- connect to our own backend token endpoint
- publish mic audio
- subscribe speaker audio
- use data channel or RPC for device control/telemetry

### Fallback path: Espressif gateway

Fallback is not the default design.

If pilot data shows the preview SDK is not stable enough, use:

- device-side `esp_webrtc`
- custom signaling to a Mitr media gateway
- gateway bridges device media into LiveKit rooms

The backend auth/session model remains the same. Only the embedded transport implementation changes.

## What We Should Not Use In Production

- browser bridge
- raw websocket PCM relay
- direct device-to-model realtime APIs
- WHIP as the main two-way assistant architecture

WHIP remains useful as a standards-based ingest option, but not as the core Mitr device transport for a bidirectional assistant.

## Rollout Sequence

1. Preserve the current local breakthrough in Git history.
2. Build the backend device control plane.
3. Replace the old firmware bridge demo with a backend-token + LiveKit-native embedded starter.
4. Adapt board/media bring-up to the exact production `ESP32-S3-WROOM` hardware.
5. Add session metadata integration and telemetry.
6. Run a small pilot on real home Wi-Fi.
7. Decide whether the fallback path is necessary.

## Developer Helpers

The backend now includes helper scripts for exercising the control plane during development:

- `pnpm seed:dev-account`
  - creates a test user/family setup if needed
- `pnpm smoke:device-flow -- --device-id mitr-esp32-001 --email tester@gmail.com`
  - creates a claim
  - completes the claim
  - issues a device credential
  - mints a LiveKit token for that device
- `pnpm seed:firmware-release -- --hardware-rev esp32-s3-wroom --version v0.1.0`
  - inserts or updates a firmware release row so heartbeat responses can recommend firmware
- `minimal/`
  - now contains the LiveKit-native ESP-IDF starter that talks to the `/devices/*` control plane
  - still requires hardware-specific board/media adaptation if the exact board is not covered by the codec board abstraction

## Test Plan

### Functional

- claim device to user
- mint device token
- device joins room
- mic reaches existing agent worker
- agent audio plays on device
- user-scoped tools continue to work correctly
- two devices for different users never cross context or audio

### Reliability

- reconnect after router restart
- reconnect after temporary Wi-Fi loss
- token expiry during long session
- TURN/TCP/443 fallback on weak networks
- stale session cleanup after abrupt power loss

### Audio

- double-talk without self-interruption
- barge-in while agent is speaking
- noisy room behavior
- Hindi-first usage with current pipeline defaults
- no echo loop and no major underruns

### Fleet

- OTA update and rollback
- firmware cohort targeting
- telemetry arrival for reconnects/crashes
- observability across `device_id`, LiveKit participant, and backend session

## Reference Appendix

Only implementation-relevant references are listed here.

### LiveKit

- LiveKit ESP32 announcement
  - https://livekit.com/blog/livekit-sdk-for-esp32-bringing-voice-ai-to-embedded-devices
  - Why it matters:
    - confirms official ESP32 support
    - dates support to **December 18, 2025**
    - confirms the SDK is built on Espressif media/WebRTC components

- LiveKit ESP32 SDK repo / README
  - https://github.com/livekit/client-sdk-esp32
  - Why it matters:
    - confirms `ESP32-S3` support
    - confirms Developer Preview status
    - documents Opus, AEC, data/RPC, and examples

- LiveKit custom ESP32 hardware tutorial
  - https://livekit.com/blog/esp32-custom-hardware-quickstart
  - Why it matters:
    - shows the board-specific bring-up path
    - clarifies that hardware integration is the actual custom work

- LiveKit authentication docs
  - https://docs.livekit.io/frontends/build/authentication/
  - Why it matters:
    - backend-minted JWT model
    - production token endpoint flow
    - dispatch metadata model

- LiveKit ingress / WHIP docs
  - https://docs.livekit.io/transport/media/ingress-egress/ingress/
  - Why it matters:
    - useful for external ingest options
    - clarifies why WHIP is not our main assistant transport

- LiveKit server repo / transport capabilities
  - https://github.com/livekit/livekit
  - Why it matters:
    - SFU, JWT auth, TURN, distributed deployment, multi-region support

### Espressif

- Espressif WebRTC solution
  - https://github.com/espressif/esp-webrtc-solution
  - Why it matters:
    - defines the fallback transport path
    - includes OpenAI, WHIP, doorbell, peer, and local signaling demos

- Espressif `esp_webrtc` / `esp_peer` design
  - https://raw.githubusercontent.com/espressif/esp-webrtc-solution/master/components/esp_webrtc/README.md
  - Why it matters:
    - TURN support
    - custom signaling support
    - embedded WebRTC call flow

- Espressif `esp_capture`
  - https://components.espressif.com/components/espressif/esp_capture
  - Why it matters:
    - capture abstraction for custom audio hardware
    - AEC/media pipeline integration path

- ESP-IDF provisioning
  - https://docs.espressif.com/projects/esp-idf/en/v4.4/esp32s3/api-reference/provisioning/provisioning.html
  - Why it matters:
    - BLE vs SoftAP tradeoff
    - proof-of-possession support
    - provisioning transport/security model

### OpenAI

- OpenAI embedded repo
  - https://github.com/openai/openai-realtime-embedded
  - Why it matters:
    - confirms that OpenAI now points ESP32 users toward Espressif’s official path
    - reinforces the decision not to make direct-to-model transport our production architecture
