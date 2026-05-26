from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx
from loguru import logger

from .auth import DeviceAuthContext


def _bool_env(name: str, fallback: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return fallback
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int_env(name: str, fallback: int) -> int:
    try:
        return int(os.getenv(name, str(fallback)))
    except ValueError:
        return fallback


def _now_ms() -> int:
    return int(time.time() * 1000)


def _json_string(value: Any, *, max_chars: int) -> str:
    if isinstance(value, str):
        text = value
    else:
        try:
            text = json.dumps(value, ensure_ascii=False, default=str)
        except Exception:
            text = json.dumps({"repr": repr(value)}, ensure_ascii=False)
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "...[truncated]"


def _metadata_without_empty(values: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in values.items() if value not in {None, ""}}


@dataclass(frozen=True)
class AgnostConfig:
    enabled: bool
    org_id: str
    base_url: str
    timeout_ms: int
    client_config: str
    agent_name: str
    max_payload_chars: int
    api_key: str | None = None

    @classmethod
    def from_env(cls) -> "AgnostConfig":
        return cls(
            enabled=_bool_env("AGNOST_ENABLED", False),
            org_id=os.getenv("AGNOST_ORG_ID", "").strip(),
            base_url=os.getenv("AGNOST_BASE_URL", "https://api.agnost.ai/api/v1").rstrip("/"),
            timeout_ms=_int_env("AGNOST_TIMEOUT_MS", 3000),
            client_config=(
                os.getenv("AGNOST_CLIENT_CONFIG", "reca-voice@local").strip()
                or "reca-voice@local"
            ),
            agent_name=os.getenv("AGNOST_AGENT_NAME", "reca-agent").strip() or "reca-agent",
            max_payload_chars=_int_env("AGNOST_MAX_PAYLOAD_CHARS", 12000),
            api_key=os.getenv("AGNOST_API_KEY", "").strip() or None,
        )

    @property
    def usable(self) -> bool:
        return self.enabled and bool(self.org_id)


class AgnostClient:
    def __init__(self, config: AgnostConfig):
        self._config = config

    @property
    def enabled(self) -> bool:
        return self._config.usable

    def _headers(self) -> dict[str, str]:
        headers = {"x-org-id": self._config.org_id}
        if self._config.api_key:
            headers["Authorization"] = f"Bearer {self._config.api_key}"
        return headers

    async def post_session(self, payload: dict[str, Any]) -> bool:
        return await self._post("/capture-session", payload)

    async def post_event(self, payload: dict[str, Any]) -> bool:
        return await self._post("/capture-event", payload)

    async def _post(self, path: str, payload: dict[str, Any]) -> bool:
        if not self.enabled:
            return False
        try:
            async with httpx.AsyncClient(timeout=self._config.timeout_ms / 1000) as client:
                response = await client.post(
                    f"{self._config.base_url}{path}",
                    headers=self._headers(),
                    json=payload,
                )
            if response.status_code >= 400:
                logger.warning(
                    "Agnost export failed path={} status={} body={}",
                    path,
                    response.status_code,
                    response.text[:500],
                )
                return False
            return True
        except Exception as error:
            logger.warning("Agnost export failed path={} error={!r}", path, error)
            return False


@dataclass
class ToolCapture:
    event_id: str
    primitive_name: str
    args: str
    result: str
    success: bool
    latency: int
    timestamp: int


@dataclass
class PendingTurn:
    event_id: str
    args: str
    timestamp: int
    result_parts: list[str] = field(default_factory=list)
    tool_events: list[ToolCapture] = field(default_factory=list)
    finalized_at: int | None = None

    def append_assistant_text(self, text: str) -> None:
        if text:
            self.result_parts.append(text)

    @property
    def result_text(self) -> str:
        return "".join(self.result_parts).strip()


class AgnostTurnRecorder:
    def __init__(
        self,
        *,
        auth: DeviceAuthContext,
        config: AgnostConfig | None = None,
        client: AgnostClient | None = None,
        session_id: str | None = None,
    ):
        self._auth = auth
        self._config = config or AgnostConfig.from_env()
        self._client = client or AgnostClient(self._config)
        self.session_id = session_id or str(uuid.uuid4())
        self._session_started = False
        self._pending_turn: PendingTurn | None = None

        if self._config.enabled and not self._config.org_id:
            logger.warning("AGNOST_ENABLED=true but AGNOST_ORG_ID is missing; export disabled")

    @property
    def enabled(self) -> bool:
        return self._client.enabled

    @property
    def current_parent_event_id(self) -> str | None:
        return self._pending_turn.event_id if self._pending_turn else None

    @property
    def has_pending_assistant_text(self) -> bool:
        return bool(self._pending_turn and self._pending_turn.result_text)

    def _identity_metadata(self) -> dict[str, Any]:
        return _metadata_without_empty(
            {
                "user_id": self._auth.user_id,
                "user_name": self._auth.user_name,
                "family_id": self._auth.family_id,
                "elder_id": self._auth.elder_id,
                "elder_name": self._auth.elder_name,
                "device_id": self._auth.device_id,
            }
        )

    async def start_session(self) -> None:
        if not self.enabled or self._session_started:
            return

        payload = {
            "session_id": self.session_id,
            "user_data": _metadata_without_empty(
                {
                    "user_id": self._auth.user_id or self._auth.elder_id or self._auth.device_id,
                    "user_name": self._auth.user_name,
                    "elder_id": self._auth.elder_id,
                    "elder_name": self._auth.elder_name,
                    "device_id": self._auth.device_id,
                }
            ),
            "client_config": self._config.client_config,
            "metadata": _metadata_without_empty(
                {
                    **self._identity_metadata(),
                    "language": self._auth.language,
                    "transport": "pipecat-openai-realtime",
                }
            ),
            "timestamp": _now_ms(),
        }
        self._session_started = await self._client.post_session(payload)

    async def begin_user_turn(self, transcript: str, *, timestamp_ms: int | None = None) -> None:
        text = transcript.strip()
        if not text:
            return
        await self.flush_pending_turn()
        if not self.enabled:
            return
        await self.start_session()
        self._pending_turn = PendingTurn(
            event_id=str(uuid.uuid4()),
            args=text,
            timestamp=timestamp_ms or _now_ms(),
        )

    def append_assistant_text(self, text: str) -> None:
        if self._pending_turn:
            self._pending_turn.append_assistant_text(text)

    def mark_turn_output_complete(self, *, timestamp_ms: int | None = None) -> None:
        if self._pending_turn and self._pending_turn.result_text:
            self._pending_turn.finalized_at = timestamp_ms or _now_ms()

    async def complete_assistant_turn(self, *, timestamp_ms: int | None = None) -> None:
        self.mark_turn_output_complete(timestamp_ms=timestamp_ms)
        await self.flush_pending_turn()

    def record_tool_event(
        self,
        *,
        name: str,
        args: dict[str, Any],
        result: Any,
        success: bool,
        latency_ms: int,
        timestamp_ms: int | None = None,
    ) -> None:
        if not self.enabled or not self._pending_turn:
            return
        self._pending_turn.tool_events.append(
            ToolCapture(
                event_id=str(uuid.uuid4()),
                primitive_name=name,
                args=_json_string(args, max_chars=self._config.max_payload_chars),
                result=_json_string(result, max_chars=self._config.max_payload_chars),
                success=success,
                latency=max(0, int(latency_ms)),
                timestamp=timestamp_ms or _now_ms(),
            )
        )

    async def flush_pending_turn(self) -> None:
        turn = self._pending_turn
        if not self.enabled or not turn:
            self._pending_turn = None
            return

        await self.start_session()
        if not self._session_started:
            logger.warning("Agnost session was not accepted; dropping pending turn export")
            self._pending_turn = None
            return

        self._pending_turn = None
        finalized_at = turn.finalized_at or _now_ms()
        agent_payload = {
            "event_id": turn.event_id,
            "session_id": self.session_id,
            "primitive_name": self._config.agent_name,
            "args": turn.args,
            "result": turn.result_text,
            "success": bool(turn.result_text),
            "latency": max(0, finalized_at - turn.timestamp),
            "timestamp": turn.timestamp,
            "metadata": _metadata_without_empty(
                {
                    **self._identity_metadata(),
                    "language": self._auth.language,
                    "source": "openai_realtime",
                }
            ),
        }
        await self._client.post_event(agent_payload)

        for tool in turn.tool_events:
            await self._client.post_event(
                {
                    "event_id": tool.event_id,
                    "parent_id": turn.event_id,
                    "session_id": self.session_id,
                    "primitive_name": tool.primitive_name,
                    "args": tool.args,
                    "result": tool.result,
                    "success": tool.success,
                    "latency": tool.latency,
                    "timestamp": tool.timestamp,
                    "metadata": _metadata_without_empty(
                        {
                            **self._identity_metadata(),
                            "language": self._auth.language,
                            "source": "pipecat_tool",
                        }
                    ),
                }
            )

    async def close(self) -> None:
        await self.flush_pending_turn()
