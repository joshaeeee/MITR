from __future__ import annotations

import asyncio
import os
import time
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
from pipecat.frames.frames import FunctionCallResultProperties, LLMRunFrame
from pipecat.services.llm_service import FunctionCallParams, LLMService

from .auth import DeviceAuthContext


_MEMORIES: dict[str, list[dict[str, Any]]] = defaultdict(list)
_REMINDERS: dict[str, list[dict[str, Any]]] = defaultdict(list)
_DIARY: dict[str, list[dict[str, Any]]] = defaultdict(list)
_CONTEXT_CARDS: dict[str, list[dict[str, Any]]] = defaultdict(list)
_FLOWS: dict[str, dict[str, Any]] = {}
ToolStartHook = Callable[[str, dict[str, Any]], Awaitable[None]]
ToolEndHook = Callable[[str, dict[str, Any], Any, bool, int], Awaitable[None]]
_DEFAULT_ASYNC_ACK_TOOLS: set[str] = set()
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
    "swiggy_auth_status",
    "swiggy_get_addresses",
    "swiggy_select_delivery_address",
    "swiggy_mcp_call",
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
    "swiggy_auth_status",
    "swiggy_get_addresses",
    "swiggy_select_delivery_address",
    "swiggy_mcp_call",
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


def _is_swiggy_tool(name: str) -> bool:
    return name.startswith("swiggy_")


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


def _async_start_runs_llm(name: str) -> bool:
    return not _is_swiggy_tool(name)


def _async_followup_delay_sec(name: str) -> float:
    if _is_swiggy_tool(name):
        return 0.0
    return _float_env("MITR_GATEWAY_TOOL_FOLLOWUP_MIN_DELAY_SEC", 1.2)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _string_arg(args: dict[str, Any], *names: str) -> str:
    for name in names:
        value = args.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


_TOOL_ARGUMENTS: dict[str, dict[str, Any]] = {
    "memory_add": {"text": {"type": "string", "description": "Fact the user asked to remember."}},
    "reca_skill_get": {"skillName": {"type": "string", "enum": ["memory_protocol"]}},
    "mem0_memory_add": {
        "text": {"type": "string"},
        "metadata": {"type": "object"},
        "infer": {"type": "boolean"},
    },
    "mem0_memory_search": {
        "query": {"type": "string"},
        "filters": {"type": "object"},
        "limit": {"type": "integer"},
    },
    "mem0_memory_list": {"filters": {"type": "object"}, "limit": {"type": "integer"}},
    "mem0_memory_get": {"memoryId": {"type": "string"}, "memory_id": {"type": "string"}},
    "mem0_memory_update": {
        "memoryId": {"type": "string"},
        "memory_id": {"type": "string"},
        "text": {"type": "string"},
        "metadata": {"type": "object"},
    },
    "mem0_memory_delete": {"memoryId": {"type": "string"}, "memory_id": {"type": "string"}},
    "memory_get": {"query": {"type": "string"}, "k": {"type": "integer"}},
    "context_packet_get": {"triggerType": {"type": "string"}, "includeDebug": {"type": "boolean"}},
    "context_memory_add": {
        "memoryType": {"type": "string"},
        "subject": {"type": "string"},
        "summary": {"type": "string"},
        "text": {"type": "string"},
        "visibility": {"type": "string"},
        "importance": {"type": "integer"},
        "confidence": {"type": "integer"},
        "metadata": {"type": "object"},
    },
    "context_card_upsert": {
        "cardType": {"type": "string"},
        "subject": {"type": "string"},
        "summary": {"type": "string"},
        "dedupeKey": {"type": "string"},
        "dueAtISO": {"type": "string"},
        "expiresAtISO": {"type": "string"},
        "mentionPolicy": {"type": "string"},
        "importance": {"type": "integer"},
    },
    "context_card_outcome_record": {
        "cardId": {"type": "string"},
        "eventType": {"type": "string"},
        "responseText": {"type": "string"},
    },
    "reminder_create": {
        "title": {"type": "string"},
        "time": {"type": "string"},
        "datetimeISO": {"type": "string"},
        "recurrence": {"type": "string"},
        "locale": {"type": "string"},
    },
    "reminder_list": {"status": {"type": "string"}, "limit": {"type": "integer"}},
    "nudge_pending_get": {"limit": {"type": "integer"}},
    "nudge_mark_listened": {
        "nudgeId": {"type": "string"},
        "nudgeIds": {"type": "array", "items": {"type": "string"}},
        "nudgeShortId": {"type": "string"},
        "nudgeShortIds": {"type": "array", "items": {"type": "string"}},
        "nudgeOrdinal": {"type": "integer"},
    },
    "diary_add": {"text": {"type": "string"}, "tags": {"type": "array", "items": {"type": "string"}}},
    "diary_list": {"limit": {"type": "integer"}, "tags": {"type": "array", "items": {"type": "string"}}},
    "flow_start": {
        "flowType": {"type": "string"},
        "topic": {"type": "string"},
        "targetDurationSec": {"type": "integer"},
        "paceMode": {"type": "string"},
        "resumeIfRunning": {"type": "boolean"},
        "restart": {"type": "boolean"},
        "autoLoop": {"type": "boolean"},
    },
    "flow_next": {"flowId": {"type": "string"}, "auto": {"type": "boolean"}, "skipToNext": {"type": "boolean"}},
    "flow_stop": {"flowId": {"type": "string"}, "reason": {"type": "string"}},
    "pranayama_guide_get": {"minutes": {"type": "integer"}},
    "brain_game_get": {"type": {"type": "string"}},
    "festival_context_get": {"city": {"type": "string"}, "date": {"type": "string"}, "language": {"type": "string"}},
    "conversation_planner_get": {
        "triggerType": {"type": "string"},
        "reminderId": {"type": "string"},
        "reminderTitle": {"type": "string"},
        "routineKey": {"type": "string"},
        "routineTitle": {"type": "string"},
        "recordPrompt": {"type": "boolean"},
    },
    "prompt_outcome_record": {
        "promptHistoryId": {"type": "string"},
        "promptType": {"type": "string"},
        "promptKey": {"type": "string"},
        "responseState": {"type": "string"},
        "sentiment": {"type": "string"},
        "responseText": {"type": "string"},
    },
    "medication_response_record": {
        "status": {"type": "string"},
        "medicine": {"type": "string"},
        "reminderId": {"type": "string"},
        "scheduledAt": {"type": "string"},
        "responseText": {"type": "string"},
    },
    "medication_adherence_setup": {
        "medicine": {"type": "string"},
        "time": {"type": "string"},
        "recurrence": {"type": "string"},
    },
    "religious_retrieve": {"query": {"type": "string"}, "topic": {"type": "string"}},
    "story_retrieve": {"query": {"type": "string"}, "topic": {"type": "string"}},
    "panchang_get": {"date": {"type": "string"}, "city": {"type": "string"}, "language": {"type": "string"}},
    "youtube_media_get": {
        "query": {"type": "string"},
        "topic": {"type": "string"},
        "preferLive": {"type": "boolean"},
        "preferLatest": {"type": "boolean"},
    },
}


_TOOL_REQUIRED_ARGS: dict[str, list[str]] = {
    "memory_add": ["text"],
    "reca_skill_get": ["skillName"],
    "mem0_memory_add": ["text"],
    "mem0_memory_get": ["memoryId"],
    "mem0_memory_update": ["memoryId", "text"],
    "mem0_memory_delete": ["memoryId"],
    "reminder_create": ["title"],
}


def _tool_schema(name: str, description: str) -> FunctionSchema:
    return FunctionSchema(
        name=name,
        description=description,
        properties=_TOOL_ARGUMENTS.get(name, {}),
        required=_TOOL_REQUIRED_ARGS.get(name, []),
    )


def _news_retrieve_schema() -> FunctionSchema:
    return FunctionSchema(
        name="news_retrieve",
        description=(
            "Retrieve current-affairs news using Exa before answering any latest, current, "
            "today, headlines, or taaza khabar request. Write the query in plain language "
            "from the user's actual intent; for generic news use query='top news in India "
            "today' and freshness='latest'. Do not default to local news unless the user "
            "asks for local/regional news or names a place; if local news is requested "
            "without a place, ask one short clarification question instead of calling. If "
            "the result is pending, acknowledge briefly and wait for the ready result. "
            "When ready, summarize only from tool output with headline, source, why it "
            "matters, and one concrete detail; collapse duplicate coverage of the same "
            "story."
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
            "Search the web using Exa for current factual context, websites, comparisons, "
            "official pages, recommendations, or research links. Use news_retrieve instead "
            "for news briefings, headlines, latest/current events, or taaza khabar. Include "
            "domains only when the user asks for a specific site/source or when official "
            "sources are required. If results are pending, acknowledge briefly and wait; "
            "when ready, answer from the returned source links/summaries and do not invent "
            "missing details."
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


def _swiggy_select_delivery_address_schema() -> FunctionSchema:
    return FunctionSchema(
        name="swiggy_select_delivery_address",
        description=(
            "Remember the Swiggy delivery address selected by the user. Use only after "
            "swiggy_get_addresses returns saved addresses and the user clearly chooses "
            "one by label, ordinal, or short description. Pass the exact addressId "
            "returned by swiggy_get_addresses; never invent or read the raw ID aloud. "
            "After this succeeds, continue the original Food/Instamart ordering request "
            "without asking for final order confirmation yet."
        ),
        properties={
            "addressId": {"type": "string", "description": "Swiggy addressId returned by swiggy_get_addresses."},
            "label": {"type": "string", "description": "Optional address label such as Home or Work."},
            "displayText": {"type": "string", "description": "Voice-safe address summary. Do not include raw coordinates."},
        },
        required=["addressId"],
    )


def _swiggy_mcp_call_schema() -> FunctionSchema:
    return FunctionSchema(
        name="swiggy_mcp_call",
        description=(
            "Call an allowlisted Swiggy MCP tool for Food, Instamart, or Dineout after "
            "swiggy_auth_status confirms Swiggy is connected. Choose server=food for "
            "restaurants/meals/snacks, server=im for groceries/essentials/Instamart, and "
            "server=dineout for table bookings. For Food/Instamart, a delivery address "
            "must be selected before search, cart, or checkout. Offer at most three "
            "voice-friendly options from results and never read raw restaurantId, spinId, "
            "cart IDs, tokens, or internal codes aloud. For place_food_order, checkout, "
            "book_table, or delete_address, call only after the user explicitly confirms "
            "the exact action, total amount, address, and payment method if applicable; "
            "set userConfirmed=true only after that confirmation. If a final paid action "
            "fails or times out, check the relevant order/status tool before retrying."
        ),
        properties={
            "server": {"type": "string", "enum": ["food", "im", "dineout"], "description": "Swiggy MCP server."},
            "toolName": {"type": "string", "description": "Swiggy MCP tool name, e.g. search_restaurants or search_products."},
            "toolArguments": {"type": "object", "description": "Arguments for the selected Swiggy MCP tool."},
            "userConfirmed": {"type": "boolean", "description": "True only after the user confirms the exact final action."},
        },
        required=["server", "toolName"],
    )


def build_tools_schema() -> ToolsSchema:
    tools = [
        _tool_schema(
            "memory_add",
            "Store a single personal fact the user has explicitly asked you to remember. "
            "Explicit remember requests always use this tool, not context_memory_add. "
            "Call when the user says something like 'yaad rakhna', 'remember this', "
            "'note kar lo', 'isko save kar lo', or 'bhoolna mat'. Save only the fact "
            "they asked you to remember. Do not use for structured artifacts like plans "
            "or routines - those use mem0_memory_add. Do not use for silent relationship "
            "memory like preferences and habits when the user did not ask you to remember "
            "them - those use context_memory_add.",
        ),
        _tool_schema(
            "reca_skill_get",
            "Load a Reca runtime skill that returns instructions for a structured workflow. "
            "Call with skillName='memory_protocol' before generating any reusable artifact "
            "for the user - a fitness plan, diet plan, study schedule, routine, budget, "
            "tracker, or recipe. You must wait for the returned instructions before "
            "generating the artifact. The returned MD file tells you what to do next, "
            "including how to save the artifact to Mem0.",
        ),
        _tool_schema(
            "mem0_memory_add",
            "Save a structured memory to Mem0. Call this immediately after generating any "
            "reusable artifact (plan, routine, schedule, tracker, budget, recipe). Save "
            "the full artifact text, not a summary. Use infer=false and set category to "
            "match the artifact type (fitness_plan, meal_plan, study_plan, etc.). Also "
            "call this to append a log entry when the user reports progress, completion, "
            "or a skip - use the corresponding log category (workout_log, food_log, "
            "study_log). Do not announce the save to the user.",
        ),
        _tool_schema(
            "mem0_memory_search",
            "Search structured Mem0 memories in the current Reca user scope. Use this "
            "when the user asks to recall, continue, update, or inspect a saved plan, "
            "routine, schedule, tracker, budget, recipe, or log and you do not yet know "
            "the memory ID. For direct recall requests like 'mera workout plan batao', "
            "call this silently before saying anything speculative; do not ask whether "
            "the plan exists before checking. Provide a specific query and metadata "
            "filters such as category, status, domain, object_type, or record_kind when "
            "known. After the result, answer only from returned memories. If the result "
            "is empty or unavailable, say you could not confirm it from saved memory "
            "right now. Do not use this for general conversation context; use memory_get "
            "or context_packet_get instead.",
        ),
        _tool_schema(
            "mem0_memory_list",
            "List structured Mem0 memories by metadata filters in the current Reca user "
            "scope. Use when browsing a known category/domain before updating a document, "
            "creating a rollup, or finding the active version of a saved artifact. Call "
            "silently before speaking when the user directly asks for saved artifacts; "
            "do not speculate before the result. Keep limits small unless the user "
            "explicitly asks to see many records.",
        ),
        _tool_schema(
            "mem0_memory_get",
            "Get one structured Mem0 memory by memory ID after scoped search/list found "
            "it. Use before updating or quoting a saved artifact so you have the exact "
            "current content. Answer from the returned content only. Do not invent memory "
            "IDs.",
        ),
        _tool_schema(
            "mem0_memory_update",
            "Update one structured Mem0 memory by memory ID. Use for living documents, "
            "active snapshots, plans, routines, trackers, budgets, recipes, or rollups. "
            "Do not use for append-only logs unless correcting a mistake; append progress "
            "or completion logs with mem0_memory_add instead. Save the full updated text "
            "rather than a terse summary.",
        ),
        _tool_schema(
            "mem0_memory_delete",
            "Delete one Mem0 memory by memory ID only when the user explicitly asks to "
            "delete, remove, or forget that specific saved artifact or memory. Search/list "
            "first if the memory ID is unknown. Do not delete based on vague dissatisfaction "
            "or inferred preference changes.",
        ),
        _tool_schema(
            "memory_get",
            "Retrieve relevant personal memories when the user asks what you remember, "
            "asks to recall a saved detail, or a direct answer depends on explicit saved "
            "memory. Call silently before speaking for direct recall requests; do not "
            "speculate or ask whether the memory exists before checking. If no memory is "
            "returned, say only that you could not confirm it from saved memory right now; "
            "never claim the user never said it.",
        ),
        _tool_schema(
            "context_packet_get",
            "Retrieve the compact ranked memory/context packet for this turn. Use before "
            "assistant-initiated greetings, proactive topics, routine check-ins, missed "
            "reminder follow-ups, or gently mentioning pending context cards. Do not use "
            "to answer a direct user request when the current conversation already has "
            "enough information. Handle mustHandle items first and mention at most one "
            "mayMention item in a spoken turn.",
        ),
        _tool_schema(
            "context_memory_add",
            "Silently save durable personal context the user reveals in passing. This is "
            "a background capture tool: call it even when the user did not ask you to "
            "remember anything, and continue the spoken conversation naturally without "
            "announcing the save. Decision rule: if the user reveals a durable "
            "preference, routine, identity detail, relationship, habit, belief, or "
            "meaningful interest without explicitly asking you to remember it, call this "
            "tool before or alongside your normal reply. "
            "Examples that should call this tool: 'mujhe Krishnamurti ki talks roz "
            "sunna achcha lagta hai', 'main har subah mandir jata hoon', 'meri beti "
            "Bangalore mein rehti hai', 'mujhe chai bina chini pasand hai'. Never call "
            "this when the user says 'yaad rakhna', 'remember this', 'note kar lo', "
            "'save this', or otherwise explicitly asks you to remember; use memory_add "
            "instead. Do not call for one-off statements with no personal weight. Do not "
            "call for plans or artifacts (use mem0_memory_add instead).",
        ),
        _tool_schema(
            "context_card_upsert",
            "Create or refresh a future conversational open loop such as a doctor visit "
            "follow-up tomorrow, a pending family callback, or a routine check-in. Use "
            "only for specific future context that should be remembered and surfaced later, "
            "not for casual chat or general preferences. Set a stable dedupeKey when the "
            "same open loop may be refreshed.",
        ),
        _tool_schema(
            "context_card_outcome_record",
            "Record what happened after a context card was mentioned so Mitr does not "
            "repeat it awkwardly. Call with eventType='mentioned' when you bring up the "
            "card, then call again after the user responds with completed, dismissed, "
            "ignored, snoozed, answered, or another matching outcome. Do not announce this "
            "recording to the user.",
        ),
        _tool_schema(
            "reminder_create",
            "Create a schedule reminder or alarm only when the user asks to be reminded "
            "about medicine, appointments, routines, calls, or time-bound tasks. Ask a "
            "short clarification if the time/date is missing or ambiguous. Do not use for "
            "family nudges/messages or for silently inferred follow-ups.",
        ),
        _tool_schema(
            "reminder_list",
            "List schedule/alarm reminders known for the current user. Use when the user "
            "asks what reminders they have, whether a reminder exists, or wants to manage "
            "reminders. Not for retrieving family messages or context cards.",
        ),
        _tool_schema(
            "nudge_pending_get",
            "Get unheard family nudges/messages for the user in playback order: urgent, "
            "important, gentle, then queue order. Use before handling family nudges or "
            "starting deeper proactive usage, not during ordinary chat. Handle one nudge "
            "at a time and use the returned nudgeId/nudgeShortId/nudgeOrdinal for follow-up "
            "calls.",
        ),
        _tool_schema(
            "nudge_mark_listened",
            "Mark only the family nudge(s) just played or read as listened. Use the ID, "
            "short ID, or ordinal returned by nudge_pending_get; omit args only when you "
            "intentionally want the first pending nudge auto-selected. For voice nudges, "
            "respect returned playback fields and do not mark unrelated pending nudges.",
        ),
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
        _tool_schema(
            "conversation_planner_get",
            "Plan the next elder-aware proactive conversation move. Use before proactive "
            "greetings, routine check-ins, reminder follow-ups, family bridge prompts, "
            "or assistant-initiated questions that were not already determined by "
            "context_packet_get. Treat returned promptSeed, allowedQuestionCount, "
            "followupPolicy, and constraints as planning guidance, then speak naturally "
            "instead of reading it as a script.",
        ),
        _tool_schema(
            "prompt_outcome_record",
            "Record the elder's response to a planned proactive prompt. Call after the "
            "user responds to a prompt from conversation_planner_get, using the returned "
            "promptHistoryId and the closest responseState. Do not call for ordinary "
            "user-initiated conversation.",
        ),
        _tool_schema(
            "medication_response_record",
            "Record how the elder responded to a medication reminder or medication "
            "check-in before continuing the conversation. Decision rule: when the "
            "previous assistant turn asked about a medicine/reminder, or the user says "
            "they took, skipped, refused, delayed, forgot, or are unsure about a medicine "
            "dose, call this tool even if reminderId is unavailable. Examples that should "
            "call this tool: 'haan, maine BP ki dawai le li', 'abhi nahi li, thodi der "
            "mein lunga', 'aaj skip kar di', 'pata nahi li thi ya nahi'. Use "
            "status=taken, delayed, refused, no_response, or unclear based on what the "
            "user said. Keep responseText short and factual. Do not diagnose or add "
            "medical interpretation.",
        ),
        _tool_schema(
            "medication_adherence_setup",
            "Capture a medication adherence setup request when the user wants recurring "
            "medicine reminders or medication tracking configured. Use only for setup or "
            "configuration intent, not for recording a single reminder response; use "
            "medication_response_record for that.",
        ),
        _tool_schema("religious_retrieve", "Retrieve religious context for a question."),
        _tool_schema("story_retrieve", "Retrieve a suitable story."),
        _news_retrieve_schema(),
        _web_search_schema(),
        _tool_schema("panchang_get", "Retrieve panchang context."),
        _tool_schema("youtube_media_get", "Find YouTube media for playback."),
        _tool_schema(
            "swiggy_auth_status",
            "Check whether Swiggy is connected for this user. Call this silently before "
            "any Swiggy Food, Instamart, Dineout, cart, checkout, address, or order "
            "tracking action. If connected=false, briefly tell the user Swiggy must be "
            "connected in the Mitr app and do not ask for OTPs, passwords, or tokens by "
            "voice. If connected=true but selectedAddress is missing for Food/Instamart, "
            "call swiggy_get_addresses next without speaking. If connected=true and "
            "selectedAddress is present, call the next Swiggy tool when the original "
            "request has enough details; otherwise ask one short clarification question.",
        ),
        _tool_schema(
            "swiggy_get_addresses",
            "Get saved Swiggy delivery addresses for Food and Instamart. Call after "
            "swiggy_auth_status when no selected delivery address is available, before "
            "search/cart/checkout, or when the user changes delivery location. Present at "
            "most three voice-safe labels or short summaries and ask the user to choose "
            "one. If there are no usable addresses, tell the user to add or select an "
            "address in Swiggy or the Mitr app.",
        ),
        _swiggy_select_delivery_address_schema(),
        _swiggy_mcp_call_schema(),
    ]
    return ToolsSchema(standard_tools=tools)


def build_gemini_function_declarations() -> list[dict[str, Any]]:
    declarations: list[dict[str, Any]] = []
    for schema in build_tools_schema().standard_tools:
        properties = dict(schema.properties or {})
        parameters = {
            "type": "object",
            "properties": properties,
            "additionalProperties": False,
        }
        required = list(schema.required or [])
        if required:
            parameters["required"] = required
        declarations.append(
            {
                "name": schema.name,
                "description": schema.description,
                "parameters_json_schema": parameters,
            }
        )
    return declarations


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


def _swiggy_inner_result(result: dict[str, Any]) -> dict[str, Any]:
    payload = result.get("result")
    if isinstance(payload, dict) and isinstance(payload.get("result"), dict):
        return payload["result"]
    if isinstance(payload, dict):
        return payload
    return {}


def _swiggy_finished_context(name: str, result: dict[str, Any]) -> dict[str, Any]:
    inner = _swiggy_inner_result(result)
    context: dict[str, Any] = {
        "tool": name,
        "mustRespond": True,
        "status": inner.get("status") or result.get("status"),
    }

    if name == "swiggy_auth_status":
        auth_result = result.get("result") if isinstance(result.get("result"), dict) else result
        selected_address = auth_result.get("selectedAddress") if isinstance(auth_result, dict) else None
        connected = bool(auth_result.get("connected")) if isinstance(auth_result, dict) else False
        if isinstance(auth_result, dict) and connected and not selected_address:
            next_action = "call_swiggy_get_addresses"
        elif connected and selected_address:
            next_action = "continue_original_ordering_request_or_ask_missing_details"
        else:
            next_action = "explain_auth_status"
        context.update(
            {
                "connected": connected,
                "selectedAddress": selected_address,
                "nextAction": next_action,
                "nextTool": "swiggy_get_addresses" if next_action == "call_swiggy_get_addresses" else None,
                "speakToUser": next_action != "call_swiggy_get_addresses",
            }
        )
        return context

    if name == "swiggy_get_addresses":
        addresses = inner.get("addresses") if isinstance(inner.get("addresses"), list) else []
        has_addresses = len(addresses) > 0
        context.update(
            {
                "addresses": addresses,
                "addressCount": len(addresses),
                "nextAction": "ask_user_to_choose_address" if has_addresses else "ask_user_to_add_or_select_address",
                "nextTool": None,
                "speakToUser": True,
            }
        )
        return context

    if name == "swiggy_select_delivery_address":
        context.update(
            {
                "selectedAddress": result.get("result") if isinstance(result.get("result"), dict) else inner,
                "nextAction": "continue_original_ordering_request",
                "nextTool": None,
                "speakToUser": False,
            }
        )
        return context

    if name == "swiggy_mcp_call":
        for key in (
            "restaurants",
            "items",
            "cart",
            "orders",
            "order",
            "booking",
            "coupons",
            "locations",
            "slots",
        ):
            value = inner.get(key)
            if value is not None:
                context[key] = value
        context["nextAction"] = "present_options_or_request_confirmation"
        context["nextTool"] = None
        context["speakToUser"] = True
        return context

    context["nextAction"] = "respond_with_next_step"
    context["nextTool"] = None
    context["speakToUser"] = True
    return context


def _swiggy_finished_message(name: str, result: dict[str, Any]) -> str:
    context = _swiggy_finished_context(name, result)

    if name == "swiggy_auth_status":
        if context.get("connected") and context.get("nextAction") == "call_swiggy_get_addresses":
            return (
                "Swiggy auth is active but no delivery address is selected. "
                "Do not speak to the user yet. Do not ask for order confirmation. "
                "Do not say confirmation is missing. Immediately call swiggy_get_addresses now."
            )
        if context.get("connected"):
            return (
                "Swiggy auth is active and a delivery address is selected. If the original user "
                "request has enough details to order, search, manage a cart, track an order, or "
                "book Dineout, immediately call the next Swiggy tool for that request. If required "
                "details are missing, ask one short clarification question. Only if the user's "
                "entire request was to check Swiggy connection status, answer briefly. Do not ask "
                "for final order confirmation until a cart/action and amount are ready."
            )
        return (
            "Swiggy is not connected or the session expired. Tell the user briefly to connect Swiggy "
            "in the Mitr app. Do not ask for OTPs, passwords, tokens, or order confirmation."
        )

    if name == "swiggy_get_addresses":
        if int(context.get("addressCount") or 0) > 0:
            return (
                "Swiggy returned saved delivery addresses. Read the available address labels or short "
                "summaries and ask the user to choose one. Do not ask for order confirmation yet."
            )
        return (
            "Swiggy returned no usable saved delivery addresses. Tell the user to add or select an "
            "address in Swiggy or the Mitr app. Do not ask for order confirmation."
        )

    if name == "swiggy_select_delivery_address":
        return (
            "The user-selected Swiggy address was saved. Continue the original ordering request now. "
            "Search or manage the cart as needed. Do not ask for final order confirmation until a "
            "specific cart/action and amount are ready."
        )

    if name == "swiggy_mcp_call":
        return (
            "The Swiggy MCP result is ready. Present matching restaurants/items, summarize cart/order "
            "status, or ask for final confirmation only if the next action is checkout, place_food_order, "
            "book_table, or delete_address with the exact amount/action/address ready. Never stay silent."
        )

    return "The Swiggy tool result is ready. Continue the user's request with the next concrete step."


def _finished_tool_result(
    name: str,
    args: dict[str, Any],
    auth: DeviceAuthContext,
    result: dict[str, Any],
) -> dict[str, Any]:
    message = (
        "The async tool result is ready. Answer the user's earlier request now from this result. "
        "If ok is true, confirm the completed action. If ok is false, say briefly that it could not be completed."
    )
    if _is_swiggy_tool(name):
        message = _swiggy_finished_message(name, result)
    return {
        "ok": bool(result.get("ok", False)),
        "tool": name,
        "status": "finished",
        "acknowledgementOnly": False,
        "language": auth.language,
        "message": message,
        "request": args,
        **({"swiggy": _swiggy_finished_context(name, result)} if _is_swiggy_tool(name) else {}),
        "result": result,
    }


def _sync_tool_result(
    name: str,
    args: dict[str, Any],
    auth: DeviceAuthContext,
    result: dict[str, Any],
) -> dict[str, Any]:
    if name == "reca_skill_get":
        return {
            "ok": bool(result.get("ok", False)),
            "tool": name,
            "status": "finished",
            "acknowledgementOnly": False,
            "language": auth.language,
            "message": (
                "The requested Reca skill instructions are loaded. Follow the returned "
                "instructions now and generate the user's requested artifact in this turn. "
                "Do not stop after loading the skill. If the skill says to save the artifact "
                "after generation, call the appropriate memory tool after generating it."
            ),
            "request": args,
            "result": result,
        }
    if _is_swiggy_tool(name):
        return _finished_tool_result(name, args, auth, result)
    return result


def _finished_tool_result_properties(
    name: str,
    params: FunctionCallParams | None = None,
) -> FunctionCallResultProperties | None:
    llm = getattr(params, "llm", None)
    if llm is None:
        return FunctionCallResultProperties(run_llm=True)

    async def run_after_context_update() -> None:
        logger.info("Triggering LLM run after tool result context update: {}", name)
        await llm.push_frame(LLMRunFrame())

    return FunctionCallResultProperties(
        run_llm=False,
        on_context_updated=run_after_context_update,
    )


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


async def execute_gemini_live_tool(
    name: str,
    args: dict[str, Any],
    auth: DeviceAuthContext,
    websocket: WebSocket | None = None,
    *,
    on_tool_start: ToolStartHook | None = None,
    on_tool_end: ToolEndHook | None = None,
) -> dict[str, Any]:
    started_at = time.monotonic()
    logger.info("Gemini Live tool call started: {} arg_keys={}", name, sorted(args.keys()))
    if on_tool_start:
        await on_tool_start(name, args)
    try:
        await _send_tool_event(websocket, name, "start", args)
        result = await _execute_tool(name, args, auth)
        latency_ms = int((time.monotonic() - started_at) * 1000)
        if on_tool_end:
            await on_tool_end(name, args, result, bool(result.get("ok")), latency_ms)
        logger.info("Gemini Live tool call completed: {} ok={}", name, result.get("ok"))
        await _send_tool_event(websocket, name, "end", result)

        if _tool_execution_policy(name).async_ack:
            return _finished_tool_result(name, args, auth, result)
        return _sync_tool_result(name, args, auth, result)
    except asyncio.CancelledError:
        raise
    except Exception as error:
        payload = {"ok": False, "error": str(error)}
        latency_ms = int((time.monotonic() - started_at) * 1000)
        if on_tool_end:
            await on_tool_end(name, args, payload, False, latency_ms)
        logger.warning("Gemini Live tool call failed: {} error={}", name, str(error))
        await _send_tool_event(websocket, name, "error", payload)
        if _tool_execution_policy(name).async_ack:
            return _finished_tool_result(name, args, auth, payload)
        return _sync_tool_result(name, args, auth, payload)


def register_mitr_tools(
    llm: LLMService,
    auth: DeviceAuthContext,
    websocket: WebSocket | None,
    *,
    on_tool_start: ToolStartHook | None = None,
    on_tool_end: ToolEndHook | None = None,
):
    async def handler(params: FunctionCallParams):
        args = dict(params.arguments or {})
        name = params.function_name
        started_at = time.monotonic()
        logger.info("Pipecat tool call started: {} arg_keys={}", name, sorted(args.keys()))
        should_async_ack = _tool_execution_policy(name).async_ack
        if on_tool_start:
            await on_tool_start(name, args)
        try:
            await _send_tool_event(websocket, name, "start", args)
            if should_async_ack:
                if _async_start_runs_llm(name):
                    logger.info("Pipecat async tool call acknowledging start: {}", name)
                    await params.result_callback(
                        _started_tool_result(name, args, auth),
                        properties=FunctionCallResultProperties(
                            is_final=False,
                            run_llm=True,
                        ),
                    )
                else:
                    logger.info(
                        "Pipecat async tool call running without intermediate model callback: {}",
                        name,
                    )
                min_delay = _async_followup_delay_sec(name)
                if min_delay > 0:
                    await asyncio.sleep(min_delay)
                result = await _execute_tool(name, args, auth)
                latency_ms = int((time.monotonic() - started_at) * 1000)
                if on_tool_end:
                    await on_tool_end(name, args, result, bool(result.get("ok")), latency_ms)
                logger.info("Pipecat async tool call completed: {} ok={}", name, result.get("ok"))
                await _send_tool_event(websocket, name, "end", result)
                await params.result_callback(
                    _finished_tool_result(name, args, auth, result),
                    properties=FunctionCallResultProperties(run_llm=True),
                )
                return

            result = await _execute_tool(name, args, auth)
            latency_ms = int((time.monotonic() - started_at) * 1000)
            if on_tool_end:
                await on_tool_end(name, args, result, bool(result.get("ok")), latency_ms)
            logger.info("Pipecat tool call completed: {} ok={}", name, result.get("ok"))
            await _send_tool_event(websocket, name, "end", result)
            callback_result = _sync_tool_result(name, args, auth, result)
            await params.result_callback(
                callback_result,
                properties=_finished_tool_result_properties(name, params),
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            payload = {"ok": False, "error": str(error)}
            latency_ms = int((time.monotonic() - started_at) * 1000)
            if on_tool_end:
                await on_tool_end(name, args, payload, False, latency_ms)
            logger.warning("Pipecat tool call failed: {} error={}", name, str(error))
            await _send_tool_event(websocket, name, "error", payload)
            if should_async_ack:
                await params.result_callback(
                    _finished_tool_result(name, args, auth, payload),
                    properties=FunctionCallResultProperties(run_llm=True),
                )
            else:
                callback_result = _sync_tool_result(name, args, auth, payload)
                await params.result_callback(
                    callback_result,
                    properties=_finished_tool_result_properties(name, params),
                )
    timeout_sec = _int_env("MITR_GATEWAY_TOOL_TIMEOUT_SEC", 65)
    for schema in build_tools_schema().standard_tools:
        policy = _tool_execution_policy(schema.name)
        llm.register_function(
            schema.name,
            handler,
            cancel_on_interruption=policy.cancel_on_interruption,
            timeout_secs=timeout_sec,
        )
