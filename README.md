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
