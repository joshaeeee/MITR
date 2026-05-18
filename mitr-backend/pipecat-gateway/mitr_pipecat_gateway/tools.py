from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import Awaitable, Callable
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import WebSocket
from loguru import logger
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import FunctionCallResultProperties
from pipecat.services.llm_service import FunctionCallParams, LLMService

from .auth import DeviceAuthContext


_MEMORIES: dict[str, list[dict[str, Any]]] = defaultdict(list)
_REMINDERS: dict[str, list[dict[str, Any]]] = defaultdict(list)
_DIARY: dict[str, list[dict[str, Any]]] = defaultdict(list)
_CONTEXT_CARDS: dict[str, list[dict[str, Any]]] = defaultdict(list)
_FLOWS: dict[str, dict[str, Any]] = {}
ToolHook = Callable[[str], Awaitable[None]]
_DEFAULT_ASYNC_ACK_TOOLS = {
    "memory_add",
    "mem0_memory_add",
    "mem0_memory_update",
    "mem0_memory_delete",
    "reminder_create",
    "reminder_list",
    "nudge_pending_get",
    "nudge_mark_listened",
    "devotional_playlist_get",
    "daily_briefing_get",
    "diary_add",
    "diary_list",
    "flow_start",
    "flow_next",
    "flow_stop",
    "pranayama_guide_get",
    "brain_game_get",
    "festival_context_get",
    "medication_adherence_setup",
    "religious_retrieve",
    "story_retrieve",
    "news_retrieve",
    "web_search",
    "panchang_get",
    "youtube_media_get",
}
_DEFAULT_SYNC_TOOLS = {
    "memory_get",
    "reca_skill_get",
    "mem0_memory_search",
    "mem0_memory_list",
    "mem0_memory_get",
    "context_packet_get",
    "context_memory_add",
    "context_card_upsert",
    "context_card_outcome_record",
    "conversation_planner_get",
    "prompt_outcome_record",
    "medication_response_record",
}
_BACKEND_REQUIRED_TOOLS = {
    "memory_add",
    "reca_skill_get",
    "mem0_memory_add",
    "mem0_memory_search",
    "mem0_memory_list",
    "mem0_memory_get",
    "mem0_memory_update",
    "mem0_memory_delete",
    "memory_get",
    "context_packet_get",
    "context_memory_add",
    "context_card_upsert",
    "context_card_outcome_record",
    "reminder_create",
    "reminder_list",
    "nudge_pending_get",
    "nudge_mark_listened",
    "diary_add",
    "diary_list",
    "conversation_planner_get",
    "prompt_outcome_record",
    "medication_response_record",
    "medication_adherence_setup",
}


@dataclass(frozen=True)
class ToolExecutionPolicy:
    async_ack: bool

    @property
    def cancel_on_interruption(self) -> bool:
        return not self.async_ack


def _int_env(name: str, fallback: int) -> int:
    try:
        return int(os.getenv(name, str(fallback)))
    except ValueError:
        return fallback


def _float_env(name: str, fallback: float) -> float:
    try:
        return float(os.getenv(name, str(fallback)))
    except ValueError:
        return fallback


def _bool_env(name: str, fallback: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return fallback
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _csv_env(name: str, fallback: set[str]) -> set[str]:
    value = os.getenv(name)
    if not value:
        return set(fallback)
    return {item.strip() for item in value.split(",") if item.strip()}


def _matches_tool_name(name: str, names: set[str]) -> bool:
    return "*" in names or name in names


def _configured_async_ack_tools() -> set[str]:
    value = os.getenv("MITR_GATEWAY_ASYNC_ACK_TOOLS")
    if value is not None:
        return _csv_env("MITR_GATEWAY_ASYNC_ACK_TOOLS", _DEFAULT_ASYNC_ACK_TOOLS)
    legacy_value = os.getenv("MITR_GATEWAY_ACK_BEFORE_TOOLS")
    if legacy_value:
        return set(_DEFAULT_ASYNC_ACK_TOOLS) | _csv_env("MITR_GATEWAY_ACK_BEFORE_TOOLS", set())
    return set(_DEFAULT_ASYNC_ACK_TOOLS)


def _tool_execution_policy(name: str) -> ToolExecutionPolicy:
    if not _bool_env("MITR_GATEWAY_ASYNC_TOOL_ACKS", True):
        return ToolExecutionPolicy(async_ack=False)

    forced_sync_tools = _csv_env("MITR_GATEWAY_SYNC_TOOLS", _DEFAULT_SYNC_TOOLS)
    if _matches_tool_name(name, forced_sync_tools):
        return ToolExecutionPolicy(async_ack=False)

    return ToolExecutionPolicy(async_ack=_matches_tool_name(name, _configured_async_ack_tools()))


def _user_key(auth: DeviceAuthContext) -> str:
    return auth.user_id or auth.elder_id or auth.device_id


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _string_arg(args: dict[str, Any], *names: str) -> str:
    for name in names:
        value = args.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _tool_schema(name: str, description: str) -> FunctionSchema:
    return FunctionSchema(
        name=name,
        description=description,
        properties={
            "query": {"type": "string", "description": "User query or search text."},
            "text": {"type": "string", "description": "Text content from the user."},
            "skillName": {"type": "string", "enum": ["memory_protocol"], "description": "Reca runtime skill name."},
            "memoryId": {"type": "string", "description": "Mem0 memory identifier returned by search/list/get."},
            "memory_id": {"type": "string", "description": "Mem0 memory identifier returned by search/list/get."},
            "filters": {"type": "object", "description": "Mem0 metadata filters such as category, status, domain, or record_kind."},
            "infer": {"type": "boolean", "description": "Whether Mem0 should infer/extract facts from raw text. Use false for structured protocol records."},
            "title": {"type": "string", "description": "Optional title."},
            "time": {"type": "string", "description": "Requested reminder or schedule time."},
            "datetimeISO": {"type": "string", "description": "ISO datetime for reminders."},
            "recurrence": {"type": "string", "description": "Optional recurrence rule or natural recurrence."},
            "locale": {"type": "string", "description": "Optional locale for date parsing or display."},
            "language": {"type": "string", "description": "Preferred response/content language."},
            "action": {"type": "string", "description": "Flow or control action."},
            "topic": {"type": "string", "description": "Topic requested by the user."},
            "id": {"type": "string", "description": "Identifier returned by a previous tool call."},
            "k": {"type": "integer", "description": "Maximum number of retrieval results."},
            "tags": {"type": "array", "items": {"type": "string"}, "description": "Memory or diary tags."},
            "sourceTurnId": {"type": "string", "description": "Optional source turn identifier."},
            "nudgeId": {"type": "string", "description": "Nudge identifier."},
            "nudgeIds": {"type": "array", "items": {"type": "string"}, "description": "Nudge identifiers."},
            "nudgeShortId": {"type": "string", "description": "Short nudge identifier."},
            "nudgeShortIds": {"type": "array", "items": {"type": "string"}, "description": "Short nudge identifiers."},
            "nudgeOrdinal": {"type": "integer", "description": "1-based pending nudge ordinal."},
            "preferLive": {"type": "boolean", "description": "Prefer live media or news."},
            "preferLatest": {"type": "boolean", "description": "Prefer latest/current media."},
            "regionHint": {"type": "string", "description": "Optional region hint."},
            "limit": {"type": "integer", "description": "Maximum number of entries."},
            "flowType": {"type": "string", "enum": ["satsang", "story", "companion"]},
            "targetDurationSec": {"type": "integer", "description": "Target guided-flow duration."},
            "paceMode": {"type": "string", "enum": ["interactive", "continuous"]},
            "targetShlokaCount": {"type": "integer", "description": "Target shloka count for satsang."},
            "resumeIfRunning": {"type": "boolean", "description": "Resume existing flow when possible."},
            "restart": {"type": "boolean", "description": "Restart existing flow."},
            "autoLoop": {"type": "boolean", "description": "Continue automatically when possible."},
            "flowId": {"type": "string", "description": "Guided flow identifier."},
            "auto": {"type": "boolean", "description": "Advance automatically."},
            "skipToNext": {"type": "boolean", "description": "Skip to the next major item."},
            "reason": {"type": "string", "description": "Reason for stopping or changing state."},
            "minutes": {"type": "integer", "description": "Requested guide duration in minutes."},
            "type": {"type": "string", "description": "Requested brain-game type."},
            "medicine": {"type": "string", "description": "Medicine name."},
            "city": {"type": "string", "description": "City for local context."},
            "date": {"type": "string", "description": "Date for panchang or current context."},
            "triggerType": {
                "type": "string",
                "enum": [
                    "session_start",
                    "first_use",
                    "reminder_fired",
                    "reminder_acknowledged",
                    "medication_taken",
                    "medication_delayed",
                    "routine_time",
                    "morning",
                    "evening",
                    "caregiver_nudge",
                    "user_quiet",
                    "user_requested",
                    "manual",
                ],
                "description": "Why the assistant is planning this proactive turn.",
            },
            "reminderId": {"type": "string", "description": "Medication or reminder identifier."},
            "reminderTitle": {"type": "string", "description": "Human-readable reminder title."},
            "routineKey": {"type": "string", "description": "Routine anchor key."},
            "routineTitle": {"type": "string", "description": "Human-readable routine title."},
            "recordPrompt": {"type": "boolean", "description": "Whether to record this planned prompt."},
            "promptHistoryId": {"type": "string", "description": "Identifier returned by conversation_planner_get."},
            "promptType": {"type": "string", "description": "Prompt category for the freshness ledger."},
            "promptKey": {"type": "string", "description": "Stable prompt key for cooldowns."},
            "responseState": {
                "type": "string",
                "enum": ["accepted", "refused", "ignored", "unclear", "completed"],
                "description": "How the elder responded to the prompt.",
            },
            "sentiment": {
                "type": "string",
                "enum": ["positive", "neutral", "negative"],
                "description": "Optional sentiment of the elder response.",
            },
            "status": {
                "type": "string",
                "enum": ["taken", "delayed", "refused", "no_response", "unclear"],
                "description": "Medication reminder response status.",
            },
            "visibility": {
                "type": "string",
                "enum": ["private", "caregiver_visible", "internal_only"],
                "description": "Memory visibility policy. Use private by default; caregiver_visible only for care, routines, medication, or safety context.",
            },
            "scheduledAt": {"type": "string", "description": "Scheduled medication/reminder datetime."},
            "responseText": {"type": "string", "description": "Short transcript of the elder response."},
            "metadata": {"type": "object", "description": "Optional structured context."},
            "memoryType": {
                "type": "string",
                "enum": [
                    "profile",
                    "preference",
                    "routine",
                    "relationship",
                    "health_context",
                    "semantic",
                    "episodic",
                    "procedural",
                    "boundary",
                ],
                "description": "Typed memory class for first-party context memory.",
            },
            "subject": {"type": "string", "description": "Short memory subject."},
            "summary": {"type": "string", "description": "Short memory or context-card summary."},
            "importance": {"type": "integer", "description": "Memory/card importance, 0-100."},
            "confidence": {"type": "integer", "description": "Memory confidence, 0-100."},
            "cardId": {"type": "string", "description": "Context card identifier."},
            "cardType": {
                "type": "string",
                "enum": [
                    "medication_followup",
                    "reminder_followup",
                    "event_followup",
                    "family_nudge",
                    "routine_checkin",
                    "preference_learning",
                    "care_signal",
                    "content_offer",
                    "conversation_repair",
                ],
                "description": "Context card type.",
            },
            "dedupeKey": {"type": "string", "description": "Stable context card dedupe key."},
            "mentionPolicy": {
                "type": "string",
                "enum": [
                    "immediate",
                    "first_safe_user_turn",
                    "after_current_request",
                    "when_conversational",
                    "only_if_user_asks",
                ],
            },
            "eventType": {
                "type": "string",
                "enum": ["mentioned", "answered", "completed", "dismissed", "ignored", "snoozed", "expired"],
            },
            "dueAtISO": {"type": "string", "description": "Context card due time as ISO timestamp."},
            "expiresAtISO": {"type": "string", "description": "Context card expiry as ISO timestamp."},
            "maxMentions": {"type": "integer", "description": "Maximum context card mentions."},
            "cooldownMinutes": {"type": "integer", "description": "Minutes before this context card may be mentioned again."},
            "includeDebug": {"type": "boolean", "description": "Include context packet debug ids."},
        },
        required=[],
    )


def _news_retrieve_schema() -> FunctionSchema:
    return FunctionSchema(
        name="news_retrieve",
        description=(
            "Retrieve current-affairs news using Exa. Always use this for latest/current/today/news/"
            "headlines/taaza khabar requests before answering. For generic news, use query "
            "'top news in India today' with freshness='latest'. Summarize ready results with headline, "
            "source, why it matters, and one concrete detail."
        ),
        properties={
            "query": {"type": "string", "description": "Plain-language news query."},
            "freshness": {"type": "string", "enum": ["latest", "recent", "general"]},
            "language": {"type": "string", "description": "Preferred response/content language."},
            "regionCode": {"type": "string", "description": "Country/region code, e.g. IN."},
            "stateOrCity": {"type": "string", "description": "Optional local city/state for local news."},
            "numResults": {"type": "integer", "description": "Number of results, 1-15."},
            "recencyDays": {"type": "integer", "description": "Recency window in days, 1-30."},
        },
        required=["query"],
    )


def _web_search_schema() -> FunctionSchema:
    return FunctionSchema(
        name="web_search",
        description=(
            "Search the web using Exa for current factual context. Prefer news_retrieve for news briefings; "
            "use this for non-news current facts, websites, comparisons, and research links."
        ),
        properties={
            "query": {"type": "string", "description": "Plain-language web search query."},
            "numResults": {"type": "integer", "description": "Number of results, 1-8."},
            "recencyDays": {"type": "integer", "description": "Recency window in days, 1-365."},
            "language": {"type": "string", "description": "Preferred language."},
            "regionCode": {"type": "string", "description": "Country/region code, e.g. IN."},
            "includeDomains": {"type": "array", "items": {"type": "string"}},
            "searchType": {"type": "string", "enum": ["auto", "fast", "instant", "neural", "deep"]},
        },
        required=["query"],
    )


def build_tools_schema() -> ToolsSchema:
    tools = [
        _tool_schema("memory_add", "Store a useful personal memory from the conversation."),
        _tool_schema("reca_skill_get", "Load a Reca runtime skill such as memory_protocol."),
        _tool_schema("mem0_memory_add", "Add a structured Mem0-backed memory in the current Reca user scope."),
        _tool_schema("mem0_memory_search", "Search Mem0-backed memories in the current Reca user scope."),
        _tool_schema("mem0_memory_list", "List Mem0-backed memories by metadata filters in the current Reca user scope."),
        _tool_schema("mem0_memory_get", "Get one Mem0-backed memory by memory ID after scoped search/list."),
        _tool_schema("mem0_memory_update", "Update one Mem0-backed memory by memory ID."),
        _tool_schema("mem0_memory_delete", "Delete one Mem0-backed memory by memory ID only on explicit user request."),
        _tool_schema("memory_get", "Retrieve relevant personal memories."),
        _tool_schema("context_packet_get", "Retrieve the compact ranked memory/context packet for this turn."),
        _tool_schema("context_memory_add", "Store typed first-party Reca memory."),
        _tool_schema("context_card_upsert", "Create or refresh a pending context card/open loop."),
        _tool_schema("context_card_outcome_record", "Record how a context card mention went."),
        _tool_schema("reminder_create", "Create a reminder requested by the user."),
        _tool_schema("reminder_list", "List reminders known for the user."),
        _tool_schema("nudge_pending_get", "Get pending family nudges for the user."),
        _tool_schema("nudge_mark_listened", "Mark a nudge as listened to."),
        _tool_schema("devotional_playlist_get", "Suggest a devotional playlist."),
        _tool_schema("daily_briefing_get", "Provide a short daily briefing."),
        _tool_schema("diary_add", "Add a diary entry."),
        _tool_schema("diary_list", "List recent diary entries."),
        _tool_schema("flow_start", "Start a guided flow."),
        _tool_schema("flow_next", "Advance an active guided flow."),
        _tool_schema("flow_stop", "Stop an active guided flow."),
        _tool_schema("pranayama_guide_get", "Provide a short pranayama guide."),
        _tool_schema("brain_game_get", "Provide a simple voice-friendly brain game."),
        _tool_schema("festival_context_get", "Provide concise festival context."),
        _tool_schema("conversation_planner_get", "Plan the next elder-aware proactive conversation move."),
        _tool_schema("prompt_outcome_record", "Record the elder response to a planned proactive prompt."),
        _tool_schema("medication_response_record", "Record an elder medication reminder response."),
        _tool_schema("medication_adherence_setup", "Capture a medication adherence setup request."),
        _tool_schema("religious_retrieve", "Retrieve religious context for a question."),
        _tool_schema("story_retrieve", "Retrieve a suitable story."),
        _news_retrieve_schema(),
        _web_search_schema(),
        _tool_schema("panchang_get", "Retrieve panchang context."),
        _tool_schema("youtube_media_get", "Find YouTube media for playback."),
    ]
    return ToolsSchema(standard_tools=tools)


async def _send_tool_event(websocket: WebSocket | None, name: str, status: str, payload: Any):
    if websocket is None:
        return
    try:
        await websocket.send_json(
            {
                "type": "tool_event",
                "tool": name,
                "status": status,
                "payload": payload,
                "ts": _now_iso(),
            }
        )
    except Exception as error:
        logger.debug("Failed to send tool_event: {}", str(error))


def _started_tool_result(name: str, args: dict[str, Any], auth: DeviceAuthContext) -> dict[str, Any]:
    return {
        "ok": True,
        "tool": name,
        "status": "started",
        "acknowledgementOnly": True,
        "language": auth.language,
        "message": (
            "Acknowledge briefly that you are doing this now, then wait for the final async tool result."
        ),
        "request": args,
    }


def _finished_tool_result(
    name: str,
    args: dict[str, Any],
    auth: DeviceAuthContext,
    result: dict[str, Any],
) -> dict[str, Any]:
    return {
        "ok": bool(result.get("ok", False)),
        "tool": name,
        "status": "finished",
        "acknowledgementOnly": False,
        "language": auth.language,
        "message": (
            "The async tool result is ready. Answer the user's earlier request now from this result. "
            "If ok is true, confirm the completed action. If ok is false, say briefly that it could not be completed."
        ),
        "request": args,
        "result": result,
    }


async def _execute_backend_tool(
    name: str,
    args: dict[str, Any],
    auth: DeviceAuthContext,
    *,
    timeout_sec: float | None = None,
) -> dict[str, Any] | None:
    if not auth.user_id:
        return None

    backend_base = os.getenv("MITR_BACKEND_BASE_URL", "").rstrip("/")
    if not backend_base:
        return None

    headers: dict[str, str] = {}
    internal_token = os.getenv("MITR_BACKEND_INTERNAL_TOKEN") or os.getenv("INTERNAL_SERVICE_TOKEN")
    if internal_token:
        headers["X-Internal-Service-Token"] = internal_token

    timeout_sec = timeout_sec or _int_env("MITR_GATEWAY_BACKEND_TOOL_TIMEOUT_SEC", 55)
    try:
        async with httpx.AsyncClient(timeout=timeout_sec) as client:
            response = await client.post(
                f"{backend_base}/internal/pipecat/tool",
                headers=headers,
                json={
                    "name": name,
                    "arguments": args,
                    "context": {
                        "userId": auth.user_id,
                        "deviceId": auth.device_id,
                        "familyId": auth.family_id,
                        "elderId": auth.elder_id,
                        "language": auth.language,
                        "sessionId": f"pipecat-{auth.device_id}",
                    },
                },
            )
    except Exception as error:
        logger.warning("Backend Pipecat tool bridge failed for {}: {!r}", name, error)
        return {
            "ok": False,
            "tool": name,
            "status": "backend_error",
            "error": repr(error),
        }

    try:
        payload = response.json()
    except Exception:
        payload = {"error": response.text}

    if response.status_code >= 400:
        return {
            "ok": False,
            "tool": name,
            "backendStatus": response.status_code,
            "error": payload,
        }

    if isinstance(payload, dict):
        return payload
    return {"ok": True, "tool": name, "result": payload}


async def execute_backend_tool_once(
    name: str,
    args: dict[str, Any],
    auth: DeviceAuthContext,
    *,
    timeout_sec: float | None = None,
) -> dict[str, Any] | None:
    return await _execute_backend_tool(name, args, auth, timeout_sec=timeout_sec)


async def _execute_tool(name: str, args: dict[str, Any], auth: DeviceAuthContext) -> dict[str, Any]:
    backend_result = await _execute_backend_tool(name, args, auth)
    if backend_result is not None:
        return backend_result

    if name in _BACKEND_REQUIRED_TOOLS:
        return {
            "ok": False,
            "tool": name,
            "status": "backend_required",
            "error": "This tool requires the verified backend; no local fallback was used.",
        }

    user_key = _user_key(auth)

    if name == "memory_add":
        text = _string_arg(args, "text", "query")
        item = {"id": str(uuid.uuid4()), "text": text, "createdAt": _now_iso()}
        _MEMORIES[user_key].append(item)
        return {"ok": True, "memory": item}

    if name == "memory_get":
        query = _string_arg(args, "query", "text").lower()
        items = _MEMORIES[user_key]
        if query:
            items = [item for item in items if query in str(item.get("text", "")).lower()]
        return {"ok": True, "items": items[-5:]}

    if name == "context_packet_get":
        pending_cards = [
            card
            for card in _CONTEXT_CARDS[user_key]
            if card.get("status", "pending") in {"pending", "snoozed"}
        ]
        must_handle = [
            {
                "cardId": card["id"],
                "type": card.get("cardType", "event_followup"),
                "priority": card.get("priority", 50),
                "title": card.get("title", "pending context"),
                "summary": card.get("summary", ""),
            }
            for card in pending_cards
            if int(card.get("priority", 0)) >= 85
        ][:2]
        may_mention = [
            {
                "cardId": card["id"],
                "type": card.get("cardType", "event_followup"),
                "priority": card.get("priority", 50),
                "title": card.get("title", "pending context"),
                "summary": card.get("summary", ""),
            }
            for card in pending_cards
            if int(card.get("priority", 0)) < 85
        ][:4]
        return {
            "ok": True,
            "version": "local_gateway_context_v1",
            "generatedAt": _now_iso(),
            "situation": "local_gateway_context",
            "mustHandle": must_handle,
            "mayMention": may_mention,
            "memories": _MEMORIES[user_key][-6:],
            "avoid": [],
            "style": {"questionBudget": 1 if must_handle or may_mention else 0, "tone": "warm", "proactiveLevel": "medium"},
        }

    if name == "context_memory_add":
        item = {
            "id": str(uuid.uuid4()),
            "memoryType": _string_arg(args, "memoryType") or "semantic",
            "subject": _string_arg(args, "subject") or "memory",
            "summary": _string_arg(args, "summary", "text"),
            "createdAt": _now_iso(),
        }
        _MEMORIES[user_key].append(item)
        return {"ok": True, "memoryId": item["id"]}

    if name == "context_card_upsert":
        card = {
            "id": str(uuid.uuid4()),
            "cardType": _string_arg(args, "cardType") or "event_followup",
            "title": _string_arg(args, "title") or "pending context",
            "summary": _string_arg(args, "summary", "text"),
            "priority": int(args.get("priority") or 50),
            "status": "pending",
            "createdAt": _now_iso(),
        }
        _CONTEXT_CARDS[user_key].append(card)
        return {"ok": True, "cardId": card["id"]}

    if name == "context_card_outcome_record":
        card_id = _string_arg(args, "cardId")
        event_type = _string_arg(args, "eventType") or "mentioned"
        for card in _CONTEXT_CARDS[user_key]:
            if card.get("id") == card_id:
                if event_type in {"completed", "dismissed", "expired"}:
                    card["status"] = event_type
                if event_type == "mentioned":
                    card["mentionCount"] = int(card.get("mentionCount", 0)) + 1
                break
        return {"ok": True, "cardId": card_id, "eventType": event_type}

    if name == "reminder_create":
        text = _string_arg(args, "text", "query", "title")
        reminder = {
            "id": str(uuid.uuid4()),
            "text": text,
            "time": _string_arg(args, "time"),
            "createdAt": _now_iso(),
            "status": "scheduled_local_gateway",
        }
        _REMINDERS[user_key].append(reminder)
        return {"ok": True, "reminder": reminder}

    if name == "reminder_list":
        return {"ok": True, "items": _REMINDERS[user_key][-10:]}

    if name == "diary_add":
        entry = {
            "id": str(uuid.uuid4()),
            "text": _string_arg(args, "text", "query"),
            "createdAt": _now_iso(),
        }
        _DIARY[user_key].append(entry)
        return {"ok": True, "entry": entry}

    if name == "diary_list":
        return {"ok": True, "items": _DIARY[user_key][-5:]}

    if name == "nudge_pending_get":
        return {"ok": True, "items": []}

    if name == "nudge_mark_listened":
        return {"ok": True, "id": _string_arg(args, "id")}

    if name == "daily_briefing_get":
        return {
            "ok": True,
            "briefing": "Today is a good day to check reminders, hydrate, and take a short walk if comfortable.",
            "generatedAt": _now_iso(),
        }

    if name == "devotional_playlist_get":
        return {
            "ok": True,
            "items": [
                {"title": "Morning bhajans", "description": "Soft devotional songs for the morning."},
                {"title": "Hanuman Chalisa", "description": "A familiar devotional recitation."},
            ],
        }

    if name == "flow_start":
        flow_id = str(uuid.uuid4())
        topic = _string_arg(args, "topic", "query") or "guided conversation"
        _FLOWS[user_key] = {"id": flow_id, "topic": topic, "step": 0}
        return {"ok": True, "flow": {"id": flow_id, "topic": topic, "nextStep": "Let us begin slowly. Please take one comfortable breath."}}

    if name == "flow_next":
        flow = _FLOWS.get(user_key) or {"id": str(uuid.uuid4()), "topic": "guided conversation", "step": 0}
        flow["step"] = int(flow.get("step", 0)) + 1
        _FLOWS[user_key] = flow
        return {"ok": True, "flow": {**flow, "nextStep": "Good. Continue gently, and tell me when you are ready for the next step."}}

    if name == "flow_stop":
        stopped = _FLOWS.pop(user_key, None)
        return {"ok": True, "stopped": stopped is not None}

    if name == "pranayama_guide_get":
        return {"ok": True, "guide": "Inhale gently for four counts, pause briefly, and exhale slowly for six counts. Repeat three times."}

    if name == "brain_game_get":
        return {"ok": True, "game": "Name three fruits that start with the sound 'a'. Take your time."}

    if name == "festival_context_get":
        topic = _string_arg(args, "topic", "query") or "the festival"
        return {"ok": True, "context": f"{topic} is best discussed with date and region. I can share a simple cultural summary."}

    if name == "conversation_planner_get":
        trigger = _string_arg(args, "triggerType") or "session_start"
        prompt_history_id = str(uuid.uuid4())
        if trigger == "reminder_fired":
            reminder_title = _string_arg(args, "reminderTitle", "title") or "dawa"
            prompt_seed = f"{reminder_title} ka samay ho gaya hai. Ho jaye toh bol dijiye, le li."
            intent = "medication_confirmation"
            prompt_key = f"medication_confirmation:{reminder_title.lower()}"
        else:
            prompt_seed = "Main yahin hoon. Aaj dawa, routine, khabar, bhajan, ya family message mein madad kar sakta hoon."
            intent = "onboarding_practice"
            prompt_key = "local_gateway:basic"
        return {
            "ok": True,
            "relationshipStage": "first_use",
            "engagementMode": "cautious",
            "plan": {
                "intent": intent,
                "promptType": "local_gateway",
                "promptKey": prompt_key,
                "promptSeed": prompt_seed,
                "spokenGuidance": "Use this as the source of truth for the next proactive turn.",
                "allowedQuestionCount": 1,
                "tone": "extra_clear",
                "followupPolicy": "retry_10m" if trigger == "reminder_fired" else "none",
                "recordPrompt": True,
                "avoidPromptKeys": [],
                "constraints": ["One short turn.", "Adult-to-adult tone.", "No feature tour."],
                "toolHints": [],
                "promptHistoryId": prompt_history_id,
            },
        }

    if name == "prompt_outcome_record":
        return {"ok": True, "promptHistoryId": _string_arg(args, "promptHistoryId") or str(uuid.uuid4())}

    if name == "medication_response_record":
        return {
            "ok": True,
            "eventId": str(uuid.uuid4()),
            "status": _string_arg(args, "status") or "unclear",
        }

    if name == "medication_adherence_setup":
        return {"ok": True, "status": "captured", "message": "Medication adherence request captured in this gateway session."}

    fallback_tools = {
        "religious_retrieve": "Religious retrieval is available in the Node stack and needs a Python retriever client next.",
        "story_retrieve": "Story retrieval is available in the Node stack and needs a Python retriever client next.",
        "news_retrieve": "News retrieval needs Python Exa/news client wiring next.",
        "web_search": "Web search needs Python web-search provider wiring next.",
        "panchang_get": "Panchang needs Python Prokerala client wiring next.",
        "youtube_media_get": "YouTube media needs Python yt-dlp/media client wiring next.",
    }
    if name in fallback_tools:
        return {
            "ok": False,
            "status": "not_wired",
            "message": fallback_tools[name],
            "query": _string_arg(args, "query", "text", "topic"),
        }

    return {"ok": False, "error": f"Unknown tool: {name}"}


def register_mitr_tools(
    llm: LLMService,
    auth: DeviceAuthContext,
    websocket: WebSocket | None,
    *,
    on_tool_start: ToolHook | None = None,
    on_tool_end: ToolHook | None = None,
):
    async def handler(params: FunctionCallParams):
        args = dict(params.arguments or {})
        name = params.function_name
        logger.info("Pipecat tool call started: {} arg_keys={}", name, sorted(args.keys()))
        should_async_ack = _tool_execution_policy(name).async_ack
        if on_tool_start:
            await on_tool_start(name)
        try:
            await _send_tool_event(websocket, name, "start", args)
            if should_async_ack:
                logger.info("Pipecat async tool call acknowledging start: {}", name)
                await params.result_callback(
                    _started_tool_result(name, args, auth),
                    properties=FunctionCallResultProperties(is_final=False, run_llm=True),
                )
                min_delay = _float_env("MITR_GATEWAY_TOOL_FOLLOWUP_MIN_DELAY_SEC", 1.2)
                if min_delay > 0:
                    await asyncio.sleep(min_delay)
                result = await _execute_tool(name, args, auth)
                logger.info("Pipecat async tool call completed: {} ok={}", name, result.get("ok"))
                await _send_tool_event(websocket, name, "end", result)
                await params.result_callback(
                    _finished_tool_result(name, args, auth, result),
                    properties=FunctionCallResultProperties(run_llm=True),
                )
                return

            result = await _execute_tool(name, args, auth)
            logger.info("Pipecat tool call completed: {} ok={}", name, result.get("ok"))
            await _send_tool_event(websocket, name, "end", result)
            await params.result_callback(result)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            payload = {"ok": False, "error": str(error)}
            logger.warning("Pipecat tool call failed: {} error={}", name, str(error))
            await _send_tool_event(websocket, name, "error", payload)
            if should_async_ack:
                await params.result_callback(
                    _finished_tool_result(name, args, auth, payload),
                    properties=FunctionCallResultProperties(run_llm=True),
                )
            else:
                await params.result_callback(payload)
        finally:
            if on_tool_end:
                await on_tool_end(name)

    timeout_sec = _int_env("MITR_GATEWAY_TOOL_TIMEOUT_SEC", 65)
    for schema in build_tools_schema().standard_tools:
        policy = _tool_execution_policy(schema.name)
        llm.register_function(
            schema.name,
            handler,
            cancel_on_interruption=policy.cancel_on_interruption,
            timeout_secs=timeout_sec,
        )
