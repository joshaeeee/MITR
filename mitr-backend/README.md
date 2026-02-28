# Mitr Backend (LiveKit + OpenAI Realtime)

Mitr backend migrated to LiveKit transport with OpenAI Realtime voice agent.

## Architecture
- `mitr-api` (Fastify): token issuance, onboarding/profile APIs, long-session HTTP APIs, health endpoints.
- `mitr-agent-worker` (LiveKit Agents Node): realtime voice agent with tools.
- Frontend/web-sim uses `livekit-client` (`Room.connect`) and no custom `/voice` protocol.

## Stack
- Runtime: Node.js + TypeScript
- Agent runtime: `@livekit/agents` + `@livekit/agents-plugin-openai`
- Realtime model: OpenAI Realtime (`gpt-realtime` by default)
- Data: Postgres + Drizzle, Redis + BullMQ, Qdrant, Mem0
- News: Exa API

## Quickstart
1. Copy env file:
```bash
cp .env.example .env
```

2. Install:
```bash
pnpm install
```

3. Start API:
```bash
pnpm dev:api
```

4. Start agent worker:
```bash
pnpm dev:agent
```

5. Start web simulator:
```bash
pnpm test:web
```
Open `http://localhost:8787`.

## Public APIs

### Session and onboarding
- `POST /session/start`
  - body: `{ "userId": "<id>" }`
  - returns `{ sessionId, transport: "livekit", onboarding }`
- `POST /session/end`
  - body: `{ "sessionId": "<id>" }`
- `GET /onboarding/questions`
- `GET /onboarding/status?userId=<id>`
- `POST /onboarding/submit`
  - body: `{ "userId": "<id>", "answers": { ... } }`

### LiveKit token
- `POST /livekit/token`
  - body: `{ "userId": "<id>", "roomName?": "...", "language?": "hi-IN", "metadata?": { ... } }`
  - returns:
    - `serverUrl`
    - `participantToken`
    - `roomName`
    - `identity`
    - `agentName`

Token includes `room_config.agents` dispatch with `LIVEKIT_AGENT_NAME`, so agent auto-joins on connect.

### Long-session runtime (HTTP)
- `POST /long-session/start`
- `POST /long-session/next`
- `POST /long-session/stop`
- `GET /long-session/:id`
- `GET /long-session/:id/summary`

### Health
- `GET /healthz`
- `GET /health/latency`

## Important migration note
Custom voice websocket protocol (`GET /voice` with `turn_start/audio_chunk/turn_end`) has been removed.
Old firmware/clients using `/voice` are not supported after this migration.

## Scripts
- `pnpm dev` -> API dev (alias)
- `pnpm dev:api` -> API dev server
- `pnpm dev:agent` -> LiveKit worker dev mode
- `pnpm start:api` -> API production start
- `pnpm start:agent` -> Worker production start
- `pnpm worker` -> Reminder worker
- `pnpm test:web` -> Local LiveKit web simulator page
- `pnpm test:agent` -> Tool registry smoke script

## Cloud Run deployment shape
Deploy as two services:
1. `mitr-api` (public ingress)
2. `mitr-agent-worker` (private/public based on your setup)

Keep both connected to the same Postgres/Redis/Qdrant/Mem0 services.

## EC2 deployment (Docker Compose + Nginx, test)

Files added under `mitr-backend/deploy/`:
- `docker-compose.prod.yml`
- `nginx.conf`
- `.env.prod.template`
- `deploy.sh`
- `healthcheck.sh`
- `bootstrap-ec2.sh`

### One-time EC2 bootstrap
```bash
sudo bash /opt/mitr/MITR/mitr-backend/deploy/bootstrap-ec2.sh
```

### Deploy on EC2
```bash
cd /opt/mitr/MITR/mitr-backend
cp deploy/.env.prod.template deploy/.env.prod
# edit deploy/.env.prod with real values
bash deploy/deploy.sh
```

### Verify
```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.prod ps
curl -fsS http://127.0.0.1/healthz
curl -fsS http://127.0.0.1/health/latency
```

### GitHub Actions auto-deploy
Workflow:
- `.github/workflows/deploy-backend-ec2.yml`

Required repo secrets:
- `EC2_HOST`
- `EC2_USER`
- `EC2_SSH_KEY` (private key content)
- `GHCR_TOKEN` (token with `read:packages` for EC2 pulls)

Notes:
- Workflow builds and pushes API + agent images to GHCR with cache.
- EC2 deploy is pull-only (`deploy.sh`) with healthcheck and rollback.

## Ingestion / data utilities
- Religious corpus:
```bash
pnpm ingest:religious ./data/religious.json
```
- Stories translation (optional utility):
```bash
pnpm stories:translate ../stories_curated.jsonl ./data/stories.hi.jsonl --target hi-IN --source en-IN
```
- Stories ingestion:
```bash
pnpm ingest:stories ./data/stories.hi.jsonl --chunk-size 1200 --chunk-overlap 150
```
