# ESP32 Audio Output First Step

For the production path and fleet architecture, see `docs/esp32-production-architecture.md`.

This is the minimum viable path for getting MITR agent audio out of an ESP32-S3 while keeping the existing web simulator as the microphone/input client.

## What we are doing

- Web simulator joins the LiveKit room and talks to the agent.
- ESP32 joins the same room as a second participant.
- ESP32 only subscribes to audio and renders the agent track to the MAX98357A speaker.

This avoids a full device integration on day one.

## Important implementation choice

Do **not** use MicroPython for this step.

LiveKit's official ESP32 SDK is an **ESP-IDF** SDK for `ESP32-S3` and `ESP32-P4`. The SDK README describes the supported path as:

- microphone/camera input via `esp_capture`
- speaker/display output via `av_render`
- room connection through the LiveKit ESP32 SDK

Source used:

- LiveKit ESP32 SDK README: `https://github.com/livekit/client-sdk-esp32/blob/main/README.md`

## Your hardware mapping

### Speaker: MAX98357A

- `BCLK -> GPIO14`
- `LRC -> GPIO12`
- `DIN -> GPIO13`

### Microphone: INMP441

- `SCK -> GPIO3`
- `WS -> GPIO4`
- `SD -> GPIO6`

For the first step, the microphone can stay physically connected but unused. We only need speaker output working first.

## Best first milestone

Use the official LiveKit ESP32 **minimal** example as the base, but configure it for:

- room subscribe: audio
- renderer: I2S speaker
- no microphone publish yet

The LiveKit README points to the `minimal` example as the simplest starting point.

## How to test it with MITR

1. Start the MITR API.
2. Start the MITR agent worker.
3. Start the web simulator.
4. In the web simulator, set a **fixed room name** instead of leaving it blank.
5. Generate a subscribe-only token for the ESP32:

```bash
cd /Users/shivanshjoshi/Mitr/mitr-backend
pnpm tsx scripts/mint-livekit-output-token.ts --room mitr-esp32-test --identity esp32-speaker
```

6. Use the output JSON in the ESP32 example:

- `serverUrl`
- `participantToken`
- `roomName`

7. Connect the web simulator to the same room.
8. Speak in the web simulator.
9. The agent audio should come out of the ESP32 speaker.

## Why this is the right first step

- no custom audio bridge needed
- no browser-to-serial hack
- no duplicated TTS path
- same LiveKit room, same real agent audio
- closer to the final hardware architecture

## Why not route browser audio to ESP32 over USB

That path is possible, but it is the wrong abstraction for this product.

Problems with browser-to-USB forwarding:

- fragile
- not your final architecture
- adds another transport layer
- debugging gets worse
- you still eventually need the ESP32 to be a real LiveKit participant

The cleaner path is: **ESP32 subscribes directly to LiveKit audio**.

## What should come next after this works

1. Keep ESP32 subscribe-only and verify stable speaker playback.
2. Add ESP32 microphone publish.
3. Move from simulator mic input to ESP32 mic input.
4. Then decide whether the web simulator stays as a debug console only.
