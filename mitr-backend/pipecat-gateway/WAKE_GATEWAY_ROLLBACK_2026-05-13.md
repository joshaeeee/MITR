# Wake Gateway Rollback Incident - 2026-05-13

## Summary

The working baseline is:

```text
5dea1745a777b8dc7db7676e4cea4edb31389cb7
5dea174 Bootstrap voice storage acknowledgment (#56)
```

Rolling the local backend, Pipecat gateway, and ESP32 firmware back to this commit restored the end-to-end wake phrase flow. The ESP connected, the gateway detected `hi esp`, OpenAI Realtime produced audio, the gateway sent audio frames back to the ESP, and the device was heard responding.

This means the ESP hardware, Wi-Fi connection, websocket transport, audio capture path, and speaker path were not the primary cause of the no-response failure. The failure was introduced in gateway/session behavior after `5dea174`.

## What Was Broken

The risky changes after `5dea174` were:

```text
ae0f5f3 Add elder memory context system (#57)
49e3646 Disable boot context injection for gateway isolation (#60)
d1f83d8 Make wake gateway turn detection single-owner
```

The most important behavioral changes were:

1. `ae0f5f3` added asynchronous runtime context injection into the Pipecat gateway.

   In `bot_wake_phrase.py`, the gateway started calling `_queue_runtime_context_update(...)` on websocket connect. That could update the OpenAI Realtime session while the audio pipeline was still starting.

2. `ae0f5f3` added context packet tools and prompt/tool instructions to the Realtime session.

   This made the first session heavier and increased the chance of startup/session-state races before the first user response.

3. `d1f83d8` changed the wake gateway Realtime turn-detection default from `server_vad` to `manual` and made non-manual modes invalid.

   That was intended to make turn ownership cleaner, but it changed the runtime behavior that had been working. The rest of the pipeline was not redesigned around true manual ownership, so STT, wake gating, user aggregation, and Realtime response creation could still overlap.

## Evidence From Broken Behavior

The failing path showed wake phrase detection working, but response generation/session ownership getting confused. The key pattern was:

```text
OpenAI STT final: 'Hi ESP.'
wake phrase detected: 'hi esp'
Setting up conversation on OpenAI Realtime LLM service with initial messages: [{'role': 'user', 'content': 'Hi ESP.'}]
Creating response
...
LLMUserAggregator: broadcasting interruption
...
Conversation already has an active response in progress
```

That is the important failure signal: OpenAI Realtime already had a response active, then our pipeline sent another user-turn/interruption path into the same session. Once that happened, the ESP stayed connected but the user did not hear a useful response.

There was also a separate invalid API key problem earlier:

```text
invalid_request_error.invalid_api_key
```

That was real, but it was not the whole issue. After the key was fixed, the no-response behavior still needed rollback to the known-good gateway behavior.

## Why `5dea174` Works

`5dea174` works because it preserves the previously tested Realtime wake runtime:

```text
Pipecat wake phrase mode enabled
OpenAI Realtime turn detection enabled: server_vad threshold=0.65 silence_duration_ms=700 prefix_padding_ms=300
Gateway echo suppression: enabled=True tail_ms=900
```

In the successful rollback test, the gateway logs showed:

```text
Pipecat wake phrase detected: 'hi esp'
OpenAI wake-phrase output audio started
Gateway output audio frame #100: 1280 bytes
Gateway output audio frame #200: 1280 bytes
Bot stopped speaking
```

And the user confirmed the device responded audibly.

The key difference is that `5dea174` does not inject runtime context into the Realtime session on connect, and it does not force the wake gateway into the newer manual turn-detection path.

## Current Safe Configuration

For this rollback test, the ESP was flashed with:

```text
CONFIG_MITR_GATEWAY_SERVER_WAKE_PHRASE=y
CONFIG_MITR_GATEWAY_WS_URL="ws://172.16.0.217:7860/ws"
CONFIG_MITR_DEVICE_BACKEND_BASE_URL="http://172.16.0.217:8081"
CONFIG_LK_EXAMPLE_WIFI_SSID="LocalHost HQ"
```

The local gateway was started without `OPENAI_REALTIME_TURN_DETECTION=manual`, so the `5dea174` default `server_vad` path was used.

## Rules Before Touching This Again

Do not reintroduce runtime context injection into the wake gateway startup path until it has a hardware test proving first-response audio still works.

Do not change OpenAI Realtime turn-detection ownership in the wake gateway without redesigning the whole state machine. STT, wake phrase detection, user aggregation, Realtime response creation, interruptions, and echo suppression must have one explicit owner model.

Do not update Realtime session settings on websocket connect if the first response depends on that same session being stable. If context is needed, prefer an explicit post-wake tool call or a backend-built compact prompt before session creation, then measure latency.

Do not add random fallback behavior for memory/context. If context is missing, stale, or unavailable, the assistant should answer the current user request without inventing context.

Do not merge gateway changes based only on typecheck/build. This path requires hardware audio verification.

## Required Hardware Smoke Test

Before merging any PR that touches `mitr-backend/pipecat-gateway`, ESP gateway config, Realtime session settings, wake phrase handling, audio serialization, context injection, or tool registration:

1. Flash the ESP from the exact commit being tested.
2. Start the backend and gateway from the same commit.
3. Confirm the ESP log reaches:

   ```text
   state=gateway_ready
   Pipecat wake phrase mode enabled
   ```

4. Confirm the gateway log reaches:

   ```text
   ESP32 connected to Pipecat wake phrase gateway
   Transcription session configured and ready
   Pipeline is now ready
   ```

5. Say: `hi esp, can you hear me?`
6. Require all of these gateway log lines:

   ```text
   wake phrase detected
   OpenAI wake-phrase output audio started
   Gateway output audio frame
   Bot stopped speaking
   ```

7. Confirm the user hears the response on the physical device.

If any of those are missing, the PR is not safe for device rollout.

## Follow-Up Engineering Work

The rollback proves the known-good path, but it is not the final architecture.

The next implementation should introduce memory/context only behind a measured, explicit design:

1. Keep wake phrase and first-response audio stable first.
2. Add context after the wake turn is stable, not as hidden startup work.
3. Add integration logs that identify the current owner of turn detection.
4. Add a local automated websocket/audio smoke test.
5. Keep the hardware smoke test mandatory for release branches.

The invariant for Mitr is simple: if the device wakes, the user must hear a response. Context quality is secondary to that invariant.
