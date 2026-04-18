# Mitr Wakeword Worker

This service owns backend wakeword detection for persistent Mitr device rooms.

Runtime flow:

1. Fetch live device sessions from `GET /internal/device-sessions/active`
2. Join each device room as a hidden subscriber
3. Read the device microphone track with LiveKit Python RTC
4. Run `livekit-wakeword` on rolling 2 second PCM windows
5. Call `POST /internal/device-sessions/:sessionId/wake-detected`
6. If accepted, publish `conversation_started` on `mitr.device_control`

Expected model artifacts:

- `models/hi_reca.meta.json`
- `models/hi_reca.onnx`

Temporary fallback while `hi_reca` is still training:

- `models/hey_livekit.meta.json`
- `models/hey_livekit.onnx`

The pre-trained `hey_livekit.onnx` model is available from LiveKit's example repo:

- `https://raw.githubusercontent.com/livekit-examples/hello-wakeword/main/client/models/hey_livekit.onnx`

This repo is currently wired to use that fallback by default. To switch manually, set:

- `WAKEWORD_MODEL_MANIFEST_PATH=/app/models/hey_livekit.meta.json`

Required environment variables:

- `LIVEKIT_URL`
- `LIVEKIT_API_KEY`
- `LIVEKIT_API_SECRET`
- `WAKEWORD_INTERNAL_API_BASE_URL`
- `WAKEWORD_INTERNAL_API_TOKEN`
- `WAKEWORD_MODEL_MANIFEST_PATH`
- `WAKEWORD_JOIN_IDENTITY_PREFIX`
- `WAKEWORD_DETECTION_DEBOUNCE_MS`
- `WAKEWORD_ROOM_IDLE_EVICT_MS`
- `REDIS_URL`

Training workflow:

1. Use `livekit-wakeword` with [`training/hi_reca.yaml`](training/hi_reca.yaml)
2. Run `livekit-wakeword run training/hi_reca.yaml`
3. Copy the exported ONNX file to `models/hi_reca.onnx`
4. Copy the evaluated threshold and metrics into `models/hi_reca.meta.json`
