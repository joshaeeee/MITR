from __future__ import annotations

import asyncio
import json
import os
import uuid
from collections.abc import Awaitable, Callable
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import WebSocket
from loguru import logger
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.services.openai.realtime import events as realtime_events
from pipecat.services.llm_service import FunctionCallParams, LLMService

from .auth import DeviceAuthContext


_MEMORIES: dict[str, list[dict[str, Any]]] = defaultdict(list)
_REMINDERS: dict[str, list[dict[str, Any]]] = defaultdict(list)
_DIARY: dict[str, list[dict[str, Any]]] = defaultdict(list)
_FLOWS: dict[str, dict[str, Any]] = {}
ToolHook = Callable[[str], Awaitable[None]]
_DEFAULT_ACK_BEFORE_TOOLS = {"news_retrieve", "web_search"}


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
        _tool_schema("memory_get", "Retrieve relevant personal memories."),
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
        "message": "Acknowledge briefly that you are checking this, then wait for the follow-up result.",
        "request": args,
    }


def _followup_instruction(name: str, auth: DeviceAuthContext) -> str:
    return (
        f"The {name} tool result is ready. Answer the user's earlier request now. "
        f"Speak in {auth.language} when possible. Keep it concise and voice-friendly. "
        "Do not call another tool for this same request."
    )


async def _send_realtime_tool_followup(
    params: FunctionCallParams,
    auth: DeviceAuthContext,
    name: str,
    args: dict[str, Any],
    result: dict[str, Any],
) -> bool:
    send_client_event = getattr(params.llm, "send_client_event", None)
    if not callable(send_client_event):
        return False

    payload = {
        "type": "tool_result_ready",
        "tool": name,
        "arguments": args,
        "result": result,
    }
    text = (
        f"{_followup_instruction(name, auth)}\n\n"
        f"Tool result JSON:\n{json.dumps(payload, ensure_ascii=False)}"
    )

    try:
        await send_client_event(
            realtime_events.ConversationItemCreateEvent(
                item=realtime_events.ConversationItem(
                    type="message",
                    role="user",
                    content=[
                        realtime_events.ItemContent(
                            type="input_text",
                            text=text,
                        )
                    ],
                )
            )
        )
        await send_client_event(
            realtime_events.ResponseCreateEvent(
                response=realtime_events.ResponseProperties(
                    output_modalities=["audio"],
                    instructions=_followup_instruction(name, auth),
                    tool_choice="none",
                )
            )
        )
        return True
    except Exception as error:
        logger.warning("Failed to inject realtime tool follow-up for {}: {!r}", name, error)
        return False


async def _execute_backend_tool(
    name: str,
    args: dict[str, Any],
    auth: DeviceAuthContext,
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

    timeout_sec = _int_env("MITR_GATEWAY_BACKEND_TOOL_TIMEOUT_SEC", 55)
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


async def _execute_tool(name: str, args: dict[str, Any], auth: DeviceAuthContext) -> dict[str, Any]:
    backend_result = await _execute_backend_tool(name, args, auth)
    if backend_result is not None:
        return backend_result

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
        ack_before_tools = _csv_env("MITR_GATEWAY_ACK_BEFORE_TOOLS", _DEFAULT_ACK_BEFORE_TOOLS)
        should_ack_before_tool = _bool_env("MITR_GATEWAY_ACK_SLOW_TOOLS", True) and name in ack_before_tools
        if on_tool_start:
            await on_tool_start(name)
        try:
            await _send_tool_event(websocket, name, "start", args)
            if should_ack_before_tool:
                logger.info("Pipecat tool call acknowledging before slow tool: {}", name)
                await params.result_callback(_started_tool_result(name, args, auth))
                min_delay = _float_env("MITR_GATEWAY_TOOL_FOLLOWUP_MIN_DELAY_SEC", 1.2)
                if min_delay > 0:
                    await asyncio.sleep(min_delay)
                result = await _execute_tool(name, args, auth)
                logger.info("Pipecat tool call completed after acknowledgement: {} ok={}", name, result.get("ok"))
                await _send_tool_event(websocket, name, "end", result)
                if not await _send_realtime_tool_followup(params, auth, name, args, result):
                    await _send_tool_event(
                        websocket,
                        name,
                        "error",
                        {
                            "ok": False,
                            "message": "Tool result is ready but the realtime follow-up could not be injected.",
                        },
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
            await params.result_callback(payload)
        finally:
            if on_tool_end:
                await on_tool_end(name)

    timeout_sec = _int_env("MITR_GATEWAY_TOOL_TIMEOUT_SEC", 65)
    for schema in build_tools_schema().standard_tools:
        llm.register_function(
            schema.name,
            handler,
            cancel_on_interruption=True,
            timeout_secs=timeout_sec,
        )
