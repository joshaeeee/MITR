---
name: mem0-agent-memory
description: Standardised framework for using Mem0 as a universal memory layer. Covers memory patterns, metadata conventions, CRUD operations, and retrieval logic.
---

# Mem0 as Universal Memory Infrastructure

Mem0 is the default memory layer for flexible user systems. Before adding a custom table or tool for a user need, check whether it fits one of these patterns.

## Three Patterns

| Pattern | Nature | Operation | Examples |
|---|---|---|---|
| Document | Written once, updated when changed | ADD once, UPDATE on change | Fitness plan, meal plan, user profile, budget |
| Log | Grows over time, usually never edited | ADD every time | Workout log, expense log, food diary, mood log |
| Summary | Periodic rollup of logs | ADD/UPDATE after rollup, archive source logs | Weekly workout summary, monthly expense total |

Identify the pattern first. Then use the structure below and add extra fields as needed.

## Base Memory Structure

Every memory should include at least:

```json
{
  "category": "workout_log"
}
```

Use extra metadata when useful:

```json
{
  "category": "fitness_plan",
  "date": "2026-05-16",
  "status": "active",
  "version": 1,
  "domain": "fitness",
  "record_kind": "document"
}
```

`category` is mandatory. Other fields are flexible.

## Category Reference

| Use case | Document category | Log category | Summary category |
|---|---|---|---|
| Fitness | `fitness_plan` | `workout_log` | `workout_summary` |
| Nutrition | `meal_plan` | `food_log` | `nutrition_summary` |
| Expenses | `budget` | `expense_log` | `expense_summary` |
| Daily planning | `goals` | `todo_log` | — |
| User context | `user_profile` | — | — |

New use case? Create a new category. No migration, setup, or permission needed.

## Reca Mem0 Tools Available

Use Reca tools, not direct client-side Mem0 calls. These tools apply user/elder scope and backend policy.

| Tool | Use for |
|---|---|
| `reca_skill_get` | Load this protocol or another runtime skill |
| `mem0_memory_add` | Add a new Mem0 memory |
| `mem0_memory_search` | Search memories with semantic query and optional filters |
| `mem0_memory_list` | List memories by metadata filters before update/rollup |
| `mem0_memory_get` | Fetch one memory by ID after search/list |
| `mem0_memory_update` | Update one memory by ID |
| `mem0_memory_delete` | Delete one memory by ID, only on explicit user request |

Map CRUD like this:

```text
ADD       -> mem0_memory_add
SEARCH    -> mem0_memory_search
GET       -> mem0_memory_get
GET ALL   -> mem0_memory_list
UPDATE    -> mem0_memory_update
DELETE    -> mem0_memory_delete
```

Use `infer=false` for structured memories that already follow this protocol. Use `infer=true` only for raw conversation that Mem0 should extract from.

If update/delete is needed, first search or list to get the memory ID. Never invent memory IDs.

## Retrieve -> Respond -> Store

Run this loop for substantive personalized turns:

```text
1. RETRIEVE  -> search/list relevant category before responding
2. RESPOND   -> use retrieved context
3. STORE     -> add or update useful new information
```

## Operations

### Add Document

Use for plans and current profiles:

```json
{
  "text": "Fitness plan: 4-day muscle building plan. Monday Push, Wednesday Pull, Friday Legs, Saturday Upper.",
  "metadata": {
    "category": "fitness_plan",
    "status": "active",
    "version": 1
  },
  "infer": false
}
```

### Add Log

Use for append-only events:

```json
{
  "text": "Workout log: Bench 4x8 at 80kg, felt strong, effort 8/10.",
  "metadata": {
    "category": "workout_log",
    "date": "2026-05-16",
    "version": 1,
    "effort_score": 8
  },
  "infer": false
}
```

### Search

Search before answering:

```json
{
  "query": "active fitness plan workout constraints",
  "filters": {
    "category": "fitness_plan",
    "status": "active"
  },
  "limit": 5
}
```

### Update

Use for documents, tasks, snapshots, and summaries. Do not update normal logs except to correct a mistake.

```text
1. Search/list active memory.
2. Get memory ID.
3. Merge the new information.
4. Call mem0_memory_update with full updated text and metadata.
```

### Delete

Delete only on explicit user request:

```text
1. Search/list to identify the memory.
2. Confirm target if ambiguous.
3. Call mem0_memory_delete with memory ID.
```

## Rollups

After enough logs accumulate, create a summary memory and archive or supersede the source logs when update is available.

Example:

```json
{
  "text": "Workout summary: Week of May 12-18: 4/4 sessions, squat 75kg to 80kg, average effort 6.8/10.",
  "metadata": {
    "category": "workout_summary",
    "period": "week",
    "week_start": "2026-05-12",
    "week_end": "2026-05-18"
  },
  "infer": false
}
```

## When To Use Postgres Alongside Mem0

Use Postgres when the user needs:

- precise aggregations
- ordered time-series charts
- exact accounting or compliance
- reminders/notifications
- caregiver dashboards
- hard deletion/audit guarantees

For most conversational systems, start with Mem0 and this protocol.
