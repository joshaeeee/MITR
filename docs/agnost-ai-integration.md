# Agnost AI Integration Notes

This note maps Agnost AI's transcript ingestion contract to the current Mitr/Reca backend. It is based on:

- Agnost's `AGNOST AI - Voice Agent Transcript Ingestion Guide`.
- Reca's product/transcript overview from May 18, 2026.
- Current backend schema and Pipecat gateway code.

## What Agnost Expects

Agnost wants a normalized event graph per voice conversation:

1. Create exactly one `capture-session` per Reca conversation.
2. Emit one agent `capture-event` per user -> assistant turn pair.
3. Put the final user transcript in `args`.
4. Put the merged assistant TTS text in `result`.
5. Emit every tool call as its own `capture-event`.
6. Set tool `parent_id` to the agent event that invoked the tool.
7. Generate every `event_id` client-side as a UUID.
8. Send timestamps as Unix milliseconds and latency as integer milliseconds.
9. Send `x-org-id` on every request, sourced from configuration.

Important detail: Agnost explicitly does not want separate assistant output events. If Reca says three consecutive assistant messages after one user input, those three texts should be concatenated into the same agent event's `result`.

## Current Reca Data Sources

### `conversation_turns`

Defined in `mitr-backend/src/db/schema.ts`.

This table already matches Agnost's main turn-pair shape:

- `session_id` -> Agnost `session_id`
- `user_id` -> `user_data.user_id`
- `user_text` -> agent event `args`
- `assistant_text` -> agent event `result`
- `language` -> session/event metadata
- `created_at` -> event timestamp

Limitation: this table does not store tool calls, parent-child event IDs, per-turn latency, or multi-assistant-message boundaries. It is useful for backfill, but incomplete for full Agnost analytics.

### `user_input_transcripts`

Defined in `mitr-backend/src/db/schema.ts` and written by `UserTranscriptService`.

This table stores finalized user STT transcripts and feeds the internal insights worker:

- `session_id`
- `user_id`
- `transcript`
- `language`
- `source`
- `created_at`

Limitation: this is user-only. It cannot satisfy Agnost's required user -> assistant pair unless joined with another source.

### Pipecat Gateway Runtime

The live voice path is in `mitr-backend/pipecat-gateway/mitr_pipecat_gateway/bot.py` and tool execution is in `mitr-backend/pipecat-gateway/mitr_pipecat_gateway/tools.py`.

This is the right place for production Agnost export because it can observe:

- Final user transcript events from Realtime/Pipecat.
- Assistant output text before or during TTS.
- Tool calls, arguments, results, success/failure, and latency.
- Session metadata from `DeviceAuthContext`: user, elder, family, device, and language.

The gateway now includes a disabled-by-default Agnost exporter in `mitr-backend/pipecat-gateway/mitr_pipecat_gateway/agnost.py`. It captures finalized user turns, merged assistant transcript deltas, and tool results from the live Pipecat/OpenAI Realtime path.

## Recommended Implementation

Implement Agnost ingestion as a gateway-side exporter, not as a database-only batch job.

Reason: Agnost's model depends on exact runtime structure: parent-child tool calls, merged assistant outputs, and latency. The Pipecat gateway has the highest-fidelity view of that structure. The database currently has useful partial records but not enough to reconstruct the graph reliably.

### Proposed Flow

1. On voice session start, call `POST /api/v1/capture-session` when `AGNOST_ENABLED=true`.
2. Maintain an in-memory `AgnostSessionBuffer` for the active Pipecat session.
3. When the user final transcript is available, start a pending agent turn:
   - Generate `agent_event_id`.
   - Store `args` as the final STT text.
   - Store `started_at_ms`.
4. When the assistant emits one or more text/TTS outputs, append them to the pending turn's assistant output list.
5. When a tool is called during that turn:
   - Generate `tool_event_id`.
   - Capture tool name, JSON args, JSON result, success/failure, timestamps, and latency.
   - Set `parent_id` to `agent_event_id`.
6. When the turn is complete, emit the agent event:
   - `primitive_name`: `reca-agent`
   - `args`: final user text
   - `result`: merged assistant text
   - `latency`: first user-final timestamp to final assistant-output timestamp
7. Emit tool events with their parent IDs.
8. Flush pending events before session close.

Tool events can be sent before or after the parent event as long as IDs are generated client-side. For operational simplicity, queue both locally and send parent first, then children, when the turn closes.

## Payload Mapping

### Capture Session

```json
{
  "session_id": "<pipecat-or-backend-session-id>",
  "user_data": {
    "user_id": "<stable-user-or-elder-id>",
    "device_id": "<device-id>"
  },
  "client_config": "reca-voice@<release-or-git-sha>",
  "metadata": {
    "language": "hi-IN",
    "family_id": "<family-id>",
    "elder_id": "<elder-id>",
    "transport": "pipecat-openai-realtime"
  },
  "timestamp": 1714867200000
}
```

### Agent Turn Event

```json
{
  "event_id": "<uuid>",
  "session_id": "<session-id>",
  "primitive_name": "reca-agent",
  "args": "Reca, satsang shuru karo. Bilkul starting se karna.",
  "result": "Theek hai. Aaj hum dheere-dheere shuru karte hain... Aaj ka vichar hai...",
  "success": true,
  "latency": 5200,
  "timestamp": 1714867201000,
  "metadata": {
    "language": "hi-IN",
    "source": "openai_realtime"
  }
}
```

### Tool Event

```json
{
  "event_id": "<uuid>",
  "parent_id": "<agent-event-uuid>",
  "session_id": "<session-id>",
  "primitive_name": "flow_start",
  "args": "{\"mode\":\"satsang\",\"topic\":\"intro\",\"language\":\"hi-IN\"}",
  "result": "{\"flow_id\":\"satsang-intro-001\",\"status\":\"started\"}",
  "success": true,
  "latency": 290,
  "timestamp": 1714867201500
}
```

## Privacy and Safety Defaults

Agnost will receive sensitive elder conversation content. Before enabling this in production:

- Gate it behind `AGNOST_ENABLED=false` by default.
- Store `AGNOST_ORG_ID` and any API key/token in environment config, not source.
- Prefer pseudonymous `user_id` or `elder_id` if Agnost does not require direct identifiers.
- Do not send phone numbers, emails, family names, or raw caregiver metadata unless explicitly needed.
- Redact or summarize tool results that can contain private memory records.
- Keep gateway transcript logging disabled in production; Agnost export should be explicit and separately controlled.

## Backfill Option

For historical data, use `conversation_turns` only:

- Create one Agnost session per `session_id`.
- Emit one agent event per row.
- Use `user_text` and `assistant_text`.
- Do not invent tool events or latency.
- Mark metadata with `"backfill": true` and `"source": "conversation_turns"`.

Do not backfill from `user_input_transcripts` alone unless Agnost accepts user-only traces, because it lacks assistant responses.

## Open Questions for Agnost

1. Can `capture-event` be sent after the turn closes, or do they expect streaming/near-realtime events?
2. What auth is required beyond `x-org-id`, if any?
3. Are `user_data.email` and similar direct identifiers optional in production?
4. What is their max accepted size for `result` and JSON-encoded tool output?
5. Should failed or interrupted turns be sent with `success: false`, or omitted?
6. Do they want wake-word turns, partial STT, and assistant interruption fragments excluded? Recommendation: exclude them from scoring and only send finalized active conversation turns.

## Runtime Configuration

Gateway env vars:

- `AGNOST_ENABLED=false`
- `AGNOST_ORG_ID=`
- `AGNOST_BASE_URL=https://api.agnost.ai/api/v1`
- `AGNOST_CLIENT_CONFIG=reca-voice@prod`
- `AGNOST_AGENT_NAME=reca-agent`
- `AGNOST_TIMEOUT_MS=3000`
- `AGNOST_MAX_PAYLOAD_CHARS=12000`
- `AGNOST_API_KEY=` optional bearer token if Agnost enables one later.

The production deploy bootstrap copies these from the canonical `.env.prod` into the narrow Pipecat gateway env file.

## Implementation Checklist

- [x] Add gateway env vars: `AGNOST_ENABLED`, `AGNOST_ORG_ID`, `AGNOST_BASE_URL`, and optional timeout/client settings.
- [x] Create a gateway `agnost.py` exporter using `httpx`.
- [x] Add a per-session buffer keyed by a generated Agnost/Pipecat session ID.
- [x] Hook final STT events into pending agent turn creation.
- [x] Hook assistant text/TTS output into pending agent turn result merging.
- [x] Wrap tool execution to capture tool events and latency.
- [x] Flush parent agent events and child tool events at turn boundary and session close.
- [x] Add tests for merged assistant outputs, tool parent IDs, and disabled mode.
- [ ] Add a backfill script from `conversation_turns` if historical Agnost analytics are needed.
