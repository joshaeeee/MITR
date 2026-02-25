# MITR

Voice-first spiritual companion backend built on LiveKit + OpenAI Realtime, with async tools for low-latency responses.

## What This Supports
- Real-time Hindi/English voice conversation
- Structured satsang flow (`flow_start` / `flow_next` / `flow_stop`)
- Async media/news/retrieval followups
- Memory, reminders, diary, panchang, festivals, stories, breathing, brain games
- Auto ambience track during satsang (server-published LiveKit audio track)

## Project Layout
- `mitr-backend/` — API + Agent worker + tools/services
- `stories_curated.jsonl` — curated story corpus data
- `features.txt` — feature notes

## Quick Start
1. Install deps
```bash
cd mitr-backend
pnpm install
```

2. Configure env
```bash
cp .env.example .env
# fill API keys and LiveKit credentials
```

3. Run API
```bash
pnpm dev:api
```

4. Run Agent worker (new terminal)
```bash
pnpm dev:agent
```

5. Optional web simulator
```bash
pnpm test:web
```

## Local Testing (End-to-End)
Use this section when you want to verify the full stack locally without guessing.

### 1) Preflight
- Ensure `mitr-backend/.env` is configured from `.env.example`.
- Required services/keys should be valid: LiveKit, OpenAI Realtime, Postgres, Redis, and any enabled tool providers (Exa, Mem0, Prokerala, etc.).
- Ensure `ffmpeg` is installed (required for satsang ambience track publishing).

Quick checks:
```bash
cd mitr-backend
pnpm typecheck
pnpm build
```

### 2) Start all local processes
Terminal A:
```bash
cd mitr-backend
pnpm dev:api
```

Terminal B:
```bash
cd mitr-backend
pnpm dev:agent
```

Terminal C (web simulator):
```bash
cd mitr-backend
pnpm test:web
```
Open `http://localhost:8787`.

### 3) Connect and run voice test
In web simulator:
1. Set host as your API host (`http://localhost:<api-port>` if local API).
2. Enter a test `userId`.
3. Click `Connect`.
4. Speak the prompts from the tool matrix below.

### 4) Fast smoke test checklist
Run these in order:
1. Health: `GET /healthz` should return healthy.
2. Voice connect: simulator connects and microphone is active.
3. Basic satsang: say “Satsang shuru karo” and verify `flow_start`.
4. Continue flow: say “Agle shlok par jao” and verify `flow_next`.
5. Stop flow: say “Satsang stop karo” and verify `flow_stop`.
6. Async news: say “Latest Maharashtra news batao” and verify pending-first + followup.
7. Async YouTube: ask for a bhajan and verify pending-first + playback-ready event.
8. Memory roundtrip: save memory, then ask recall.
9. Reminder roundtrip: create future reminder, then list reminders.

### 5) Log signals to confirm success
Look for these in `pnpm dev:agent` logs:
- `Agent tools registered`
- `received tool call from the realtime API`
- `Tool call execution finished` with `isError: false`
- For async tools: first `status: pending`, then corresponding `*_ready`
- For satsang ambience:
  - `Satsang ambience track started`
  - `Satsang ambience track stopped`

### 6) Optional direct API checks
```bash
# health
curl -s http://localhost:8787/healthz

# onboarding status (replace user)
curl -s "http://localhost:8787/onboarding/status?userId=user-local-web-1"
```

### 7) If something fails
1. Validate env vars in `mitr-backend/.env`.
2. Confirm Redis/Postgres are reachable.
3. Restart agent worker after env or code changes.
4. Check tool timeout warnings in logs and verify provider credentials.
5. Re-run `pnpm typecheck && pnpm build` to catch structural issues.

## Tool Test Prompts (Say These)
Use these utterances to force different tools/features.

### 1) Satsang Flow (`flow_*`)
- "Sat­sang shuru karo Bhagavad Gita par."
- "Isko continuous mode me chalao."
- "Agle shlok par jao."
- "Is satsang ko stop karo."

Expected:
- `flow_start` called
- `flow_next` on continue
- `flow_stop` on stop
- Ambient background audio auto-start/stop with satsang

### 2) Religious Retrieval (`religious_retrieve`)
- "Gussa control karne par Gita ka pramaan do."
- "Bhakti par do chhote shastriya references do."

Expected:
- quick ack (if async pending)
- grounded citations in followup

### 3) Story Retrieval (`story_retrieve`)
- "Koi chhoti prernaadayak kahani sunao."
- "Lok katha sunao, North India wali."

Expected:
- async retrieval result + narrated story summary

### 4) Memory (`memory_add`, `memory_get`)
- "Yaad rakhna, meri maa ka janmadin 12 March hai."
- "Maine jo birthday bataya tha, yaad hai?"

Expected:
- memory save confirmation
- memory recall

### 5) Reminders (`reminder_create`, `reminder_list`)
- "Kal subah 7 baje dawa lene ka reminder laga do."
- "Mere active reminders batao."

Expected:
- create success for future time
- explicit error for past datetime

### 6) News (`news_retrieve`, async)
- "Maharashtra ki latest news detail me batao."
- "Aaj Uttarakhand ki badi khabrein kya hain?"

Expected:
- fast pending response
- background fetch + followup with items

### 7) Panchang (`panchang_get`, async)
- "Aaj ka tithi kya hai?"
- "Aaj Rahu Kaal kab hai?"
- "Aaj ka nakshatra aur sunrise/sunset batao."

Expected:
- location-aware panchang response via followup

### 8) Devotional Media (`devotional_playlist_get`, `youtube_media_get`)
- "Aaj ke liye koi bhajan recommend karo."
- "Hanuman Chalisa ka audio chalao."
- "Purane hindi bhajan lagao."

Expected:
- playlist suggestion
- async YouTube resolve (pending -> ready)

### 9) Daily Briefing (`daily_briefing_get`)
- "Mera morning briefing do."
- "Aaj ka daily spiritual briefing batao."

### 10) Diary (`diary_add`, `diary_list`)
- "Diary me likho: aaj maine 20 minute dhyan kiya."
- "Meri recent diary entries sunao."

### 11) Pranayama (`pranayama_guide_get`)
- "5 minute ka simple pranayama routine do."
- "Anulom vilom ka safe guide batao."

### 12) Brain Game (`brain_game_get`)
- "Koi short brain game khelo mere saath."
- "Memory game do."

### 13) Festival Context (`festival_context_get`)
- "Mahashivratri ka mahatva batao."
- "Aaj koi vrat/festival hai kya?"

### 14) Medication Support (`medication_adherence_setup`)
- "Meri medicine routine set karne me help karo."

## Notes for Testing
- Some tools are intentionally async for fast voice latency.
- In async cases, first response can be "pending" and detailed output comes in followup.
- Satsang ambience is published as a separate LiveKit audio track by the backend.

## Current Tool Surface
`religious_retrieve`, `story_retrieve`, `memory_add`, `memory_get`, `reminder_create`, `reminder_list`, `news_retrieve`, `panchang_get`, `devotional_playlist_get`, `youtube_media_get`, `daily_briefing_get`, `diary_add`, `diary_list`, `flow_start`, `flow_next`, `flow_stop`, `pranayama_guide_get`, `brain_game_get`, `festival_context_get`, `medication_adherence_setup`
