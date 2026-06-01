# MITR Web Simulator

## Local experiment testing

Run the web simulator:

```sh
cd /Users/shivanshjoshi/Mitr/mitr-backend
pnpm test:web
```

Open:

```text
http://localhost:8787
```

Use **Connection mode: Direct gateway** to test the two speech experiments
without going through the Node `/pipecat/connect` endpoint. The simulator uses
the same PCM16 websocket protocol as the ESP/browser gateway client.

Start the ElevenLabs gateway on port `7861`:

```sh
cd /Users/shivanshjoshi/.codex/worktrees/mitr-elevenlabs-chained-stt/mitr-backend/pipecat-gateway
MITR_GATEWAY_PIPELINE=openai_stt_llm_elevenlabs \
MITR_GATEWAY_AUTH_MODE=local \
MITR_GATEWAY_LOCAL_DEVICE_ID=web-sim-device \
MITR_GATEWAY_PORT=7861 \
MITR_GATEWAY_CONTEXT_SUMMARIZATION=false \
AGNOST_ENABLED=false \
OPENAI_REALTIME_STT_LANGUAGE=ta-IN \
uv run python -m mitr_pipecat_gateway.server
```

Start the Gemini Live gateway on port `7862`:

```sh
cd /Users/shivanshjoshi/.codex/worktrees/mitr-gemini-live/mitr-backend/pipecat-gateway
MITR_GATEWAY_PIPELINE=gemini_live \
GEMINI_LIVE_SERVICE=direct_sdk \
MITR_GATEWAY_AUTH_MODE=local \
MITR_GATEWAY_LOCAL_DEVICE_ID=web-sim-device \
MITR_GATEWAY_PORT=7862 \
MITR_GATEWAY_CONTEXT_SUMMARIZATION=false \
AGNOST_ENABLED=false \
OPENAI_REALTIME_STT_LANGUAGE=ta-IN \
uv run python -m mitr_pipecat_gateway.server
```

In the simulator, switch **Experiment server** between:

- `ElevenLabs chained TTS`: `ws://127.0.0.1:7861/ws`
- `Gemini Live direct SDK`: `ws://127.0.0.1:7862/ws`

Use language `ta-IN` or another target language, click **Connect**, wait for
`Listening`, then say “Hi Mitr”.

# MITR Web Simulator (Vercel)

Deploy this folder as a static site on Vercel.

## Vercel setup

1. Import repo: `https://github.com/joshaeeee/MITR`.
2. Set **Root Directory** to: `mitr-backend/tools/web-sim`.
3. Framework preset: `Other`.
4. Build command: leave empty.
5. Output directory: leave empty.
6. Deploy.

## API host configuration

The simulator reads API host in this order:

1. URL query param `?apiHost=...` (or `?host=...`)
2. `localStorage` key `mitr_websim_host`
3. Default: `http://127.0.0.1:8080`

Examples:

- `https://your-sim.vercel.app/?apiHost=https://api.yourdomain.com`
- `https://your-sim.vercel.app/?host=https://api.yourdomain.com`

Important: if simulator is served on HTTPS (Vercel), backend should also be HTTPS. Browsers block mixed-content requests from HTTPS -> HTTP.

## Runtime context debugging

The simulator shows the latest `runtime_context` packet sent by the Pipecat gateway.
Enable gateway context injection locally with:

```sh
MITR_GATEWAY_INJECT_BOOT_CONTEXT=true
```

When enabled, the gateway injects a compact context packet on WebSocket connect
and again after wake phrase detection. The packet is displayed in the simulator
without being read aloud by the agent.
