# TODOS

## Infrastructure

### Split env.ts into scoped subsystem configs

**What:** Split the monolithic env.ts (142 fields) into scoped config modules: db, mem0, retrieval, livekit, news, exa, sarvam, cartesia, panchang, auth, etc.

**Why:** Lazy env (Phase 1) solves test isolation but doesn't fix module boundary coupling — services still import a 142-field god object. Scoped configs give better validation errors ('MEM0_API_KEY missing' instead of a wall of Zod failures), make dependency graphs explicit, and enable per-subsystem validation at service creation time.

**Context:** `mitr-backend/src/config/env.ts` parses the entire runtime environment at import time. After the lazy env PR lands, this file still contains one giant Zod schema covering ~12 subsystems. The natural Phase 2 is to split it into `config/db.ts`, `config/mem0.ts`, `config/retrieval.ts`, etc. Each exports a typed config object parsed lazily or at subsystem init. 27 service files currently `import { env } from '../config/env.js'` and would need to switch to their subsystem import. Start with the 3 hard-required fields (POSTGRES_URL, MEM0_API_KEY, QDRANT_URL) since those cause the most test pain.

**Effort:** L
**Priority:** P2
**Depends on:** Lazy env refactor (Phase 1) landing first

### Dependency injection for service config

**What:** Refactor services to accept config/clients via constructor parameters instead of importing global env directly.

**Why:** Even with scoped configs, services still reach out to module-level state. DI makes services fully testable with mock configs, enables runtime config swapping, and makes dependency graphs explicit in the type system.

**Context:** 27 service files currently import env directly. The highest-value targets are the 5-6 most-tested services: Mem0Service, ReligiousRetriever, NewsService, PanchangService, YoutubeStreamService, EmbeddingService. Each would accept a typed config object in its constructor. A composition root in `index.ts` and `agent-worker/main.ts` would wire everything. The codebase is not yet large enough for a DI container — manual constructor injection is sufficient.

**Effort:** XL
**Priority:** P4
**Depends on:** Scoped subsystem configs (Phase 2)

## Completed
