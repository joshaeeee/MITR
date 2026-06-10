# Mitr Backend (API + voice gateway)

Mitr uses the Fastify API for product/auth/data flows and the TypeScript voice
gateway for realtime voice.

## Architecture

- `mitr-api` (Fastify): app auth, device auth, onboarding/profile APIs,
  sessions, telemetry, pairing, long-session HTTP APIs, health endpoints.
- `voice-gateway` (TypeScript): ESP32 and browser PCM WebSocket transport,
  wake phrase handling, OpenAI Realtime voice, and voice tool calls.
- `tools/web-sim`: local browser simulator that streams PCM directly to the
  voice gateway WebSocket.

## Stack

- API runtime: Node.js + TypeScript
- Voice runtime: Saaras v3 STT -> Gemini 2.5 Flash -> Eleven v3 TTS (voice-gateway/)
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
cd voice-gateway
MITR_GATEWAY_WAKE_PHRASES="hi mitr,hey mitr,hi mitra,hey mitra,hi reca,hey reca,hi rekha,hey rekha,hi r e k a,hey r e k a,hi reka,hey reka,hi esp,hey esp,hi e s p,हाय मित्र,हे मित्र,हाय रेका,हाय रेखा" \
MITR_GATEWAY_WAKE_IDLE_TIMEOUT_SEC=45 \
OPENAI_REALTIME_STT_LANGUAGE=en \
pnpm install --ignore-workspace && pnpm dev
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
  - returns voice gateway connection metadata for web clients (path kept for app compatibility):
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
Hi Mitr / Hi Reca -> awake -> conversation remains active -> 45 seconds idle -> sleeping
```

The client WebSocket remains connected across wake/sleep cycles. Model failures
are surfaced as `model_error` and `model_reconnecting` gateway events.

## Memory Architecture

Mitr uses a Mem0-first memory layer:

- Mem0 is the durable memory content store and semantic recall layer.
- Postgres `elder_memory_items` is the policy registry: elder scope, visibility,
  status, source, confidence, Mem0 event IDs, deletion/expiry, and audit metadata.
- Redis only caches compact context packets for realtime latency.
- ESP32 and Reca never call Mem0 directly. All memory reads/writes go through
  `POST /internal/pipecat/tool`, where device/user/elder context is verified.

Entity scope:

```text
Mem0 user_id = elder:<elderId>
Fallback when no elder exists = user:<userId>
```

New memory writes do not duplicate durable memory text in Postgres. The backend
creates a registry row, sends the memory content to Mem0 v3
`/v3/memories/add/`, stores the returned `event_id`, and uses registry metadata
to RBAC-filter future Mem0 search results before Reca can speak from them.

Relevant env:

```text
MEM0_API_KEY=
MEM0_BASE_URL=https://api.mem0.ai
MEM0_APP_ID=mitr-reca
MEM0_AGENT_ID=reca
MEM0_ADD_TIMEOUT_MS=5000
MEM0_SEARCH_TIMEOUT_MS=3500
MEM0_CONTEXT_SEARCH_TIMEOUT_MS=650
MEM0_SEARCH_THRESHOLD=0.1
MEM0_SEARCH_RERANK=false
```

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
- `pnpm dev:agent` -> voice gateway dev server
- `pnpm start:api` -> API production start
- `pnpm start:agent` -> voice gateway production start
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
bash deploy/deploy.sh
bash deploy/setup-https.sh
```

Production secrets and runtime config live in AWS SSM Parameter Store under
`/mitr/prod`. `deploy/deploy.sh` regenerates `deploy/.env.prod` from SSM before
bootstrapping service env files, so `.env.prod` and service env files on EC2 are
generated artifacts and should not be edited by hand. To refresh env without a
full deploy:

```sh
AWS_REGION=ap-south-1 bash deploy/sync-env-from-ssm.sh /mitr/prod deploy/.env.prod
bash deploy/bootstrap-service-env-files.sh deploy/.env.prod
VALIDATE_OPENAI_API_KEY=false bash deploy/preflight-prod-env.sh deploy/.env.prod
```

To change production config, update the matching SSM parameter, then rerun
deploy. Use `USE_SSM_ENV=false bash deploy/deploy.sh` only for an emergency
manual env-file deploy. Gateway and worker env files must not include unrelated
API/OAuth/database/vector-store/device secrets. The deploy preflight validates
`OPENAI_API_KEY` against OpenAI by default before restarting production
containers.
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
