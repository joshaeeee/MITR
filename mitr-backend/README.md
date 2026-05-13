# Mitr Backend (Pipecat + OpenAI Realtime)

Mitr uses the Fastify API for product/auth/data flows and the Python Pipecat
gateway for realtime voice.

## Architecture

- `mitr-api` (Fastify): app auth, device auth, onboarding/profile APIs,
  sessions, telemetry, pairing, long-session HTTP APIs, health endpoints.
- `mitr-pipecat-gateway` (Python): ESP32 and browser PCM WebSocket transport,
  wake phrase handling, OpenAI Realtime voice, and voice tool calls.
- `tools/web-sim`: local browser simulator that streams PCM directly to the
  Pipecat gateway WebSocket.

## Stack

- API runtime: Node.js + TypeScript
- Voice runtime: Pipecat + OpenAI Realtime
- Data: Postgres + Drizzle, Redis + BullMQ, Qdrant, Mem0
- Retrieval/news/media: Exa, Prokerala, Bhagavad Gita API, yt-dlp

## Quickstart

```sh
cp .env.example .env
pnpm install
```

Start the API:

```sh
DOTENV_CONFIG_PATH=/Users/shivanshjoshi/Mitr/mitr-backend/.env \
NODE_OPTIONS='-r dotenv/config' \
PORT=8081 \
./node_modules/.bin/tsx src/index.ts
```

Start the voice gateway:

```sh
cd pipecat-gateway
MITR_GATEWAY_WAKE_MODE=pipecat_phrase \
MITR_GATEWAY_WAKE_PHRASES="hi esp,hey esp,hi e s p" \
MITR_GATEWAY_WAKE_IDLE_TIMEOUT_SEC=45 \
OPENAI_REALTIME_STT_LANGUAGE=en \
uv run python -m mitr_pipecat_gateway.server
```

Start the web simulator:

```sh
pnpm test:web
```

Open `http://localhost:8787`.

## Voice APIs

- `POST /session/start`
  - returns `{ sessionId, transport: "pipecat", onboarding }`
- `POST /pipecat/connect`
  - returns Pipecat connection metadata for web clients:
    `transport`, `wsUrl`, `serverUrl`, `identity`, `agentName`, `dispatchMetadata`
- `POST /pipecat/gateway/auth`
  - verifies authenticated web voice sessions for the Python gateway
- `POST /devices/session/open`
  - returns Pipecat connection metadata for ESP32 clients
- `POST /devices/token`
  - refreshes Pipecat connection metadata for ESP32 clients
- `POST /devices/gateway/auth`
  - verifies device bearer tokens for the Python gateway

Wake behavior:

```text
Hi ESP -> awake -> conversation remains active -> 45 seconds idle -> sleeping
```

The client WebSocket remains connected across wake/sleep cycles. Model failures
are surfaced as `model_error` and `model_reconnecting` gateway events.

## Other APIs

- `POST /session/end`
- `GET /onboarding/questions`
- `GET /onboarding/status?userId=<id>`
- `POST /onboarding/submit`
- `POST /long-session/start`
- `POST /long-session/next`
- `POST /long-session/stop`
- `GET /long-session/:id`
- `GET /long-session/:id/summary`
- `GET /healthz`
- `GET /health/latency`

## Scripts

- `pnpm dev:api` -> API dev server
- `pnpm dev:agent` -> Pipecat gateway dev server
- `pnpm start:api` -> API production start
- `pnpm start:agent` -> Pipecat gateway production start
- `pnpm worker` -> reminder worker
- `pnpm test:web` -> local Pipecat web simulator
- `pnpm test:agent` -> Node tool registry smoke script

## EC2 Deployment

Production compose runs:

- `mitr-api`
- `mitr-pipecat-gateway`
- `mitr-reminder-worker`
- `mitr-insights-worker`
- `mitr-digest-worker`
- Redis and Nginx

Nginx proxies `/ws` to `mitr-pipecat-gateway:7860`; all other API traffic goes
to `mitr-api:8080`.

Deploy:

```sh
cd /opt/mitr/MITR/mitr-backend
cp deploy/.env.prod.template deploy/.env.prod
deploy/generate-prod-secrets.sh
bash deploy/bootstrap-service-env-files.sh deploy/.env.prod
bash deploy/preflight-prod-env.sh deploy/.env.prod
bash deploy/deploy.sh
bash deploy/setup-https.sh
```

Fill secrets and runtime config only in `deploy/.env.prod`. Deploy bootstrap
regenerates narrow gateway and worker env files from that canonical env, so
service env files should not be edited by hand. Gateway and worker env files
must not include unrelated API/OAuth/database/vector-store/device secrets. The
deploy preflight validates `OPENAI_API_KEY` against OpenAI by default before
restarting production containers.
Before a pilot launch, complete `deploy/SECURITY_LAUNCH_CHECKLIST.md`; the
production preflight blocks deploy until the required security acknowledgements
are set.
Use `deploy/SECURITY_TESTING_GUIDE.md` to verify local, live API, staging, and
production security gates.

Verify:

```sh
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod config >/dev/null
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod ps
curl -fsS http://127.0.0.1/healthz
curl -fsS -H "Authorization: Bearer <access-token>" http://127.0.0.1/health/latency
```

GitHub Actions builds and pushes the API image and the Pipecat gateway image,
then rewrites `API_IMAGE`, `PIPECAT_GATEWAY_IMAGE`, and `REMINDER_IMAGE` in
`deploy/.env.prod` before deployment.
