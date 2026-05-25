import json
import os
import re
from pathlib import Path
from typing import Any

from loguru import logger
from pipecat.audio.utils import create_stream_resampler
from pipecat.frames.frames import Frame, InputAudioRawFrame, LLMUpdateSettingsFrame
from pipecat.pipeline.task import PipelineTask
from pipecat.processors.aggregators.llm_response_universal import (
    LLMAssistantAggregatorParams,
    LLMContextAggregatorPair,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.openai.realtime.llm import OpenAIRealtimeLLMService
from pipecat.services.settings import LLMSettings
from pipecat.utils.context.llm_context_summarization import (
    LLMAutoContextSummarizationConfig,
    LLMContextSummaryConfig,
)

from .auth import DeviceAuthContext
from .tools import execute_backend_tool_once

OPENAI_REALTIME_SAMPLE_RATE = 24000
_REALTIME2_REASONING_EFFORTS = {"minimal", "low", "medium", "high"}
_REALTIME2_TRUNCATION_MODES = {"auto", "disabled"}
_CONTEXT_SUMMARY_DEFAULT_MODEL = "gpt-4.1-mini"
_CONTEXT_SUMMARY_DEFAULT_MAX_CONTEXT_TOKENS = 8000
_CONTEXT_SUMMARY_DEFAULT_MAX_UNSUMMARIZED_MESSAGES = 20
_CONTEXT_SUMMARY_DEFAULT_TARGET_TOKENS = 6000
_CONTEXT_SUMMARY_DEFAULT_KEEP_MESSAGES = 4
_CONTEXT_SUMMARY_DEFAULT_TIMEOUT_SEC = 120.0


def _int_env(name: str, fallback: int) -> int:
    try:
        return int(os.getenv(name, str(fallback)))
    except ValueError:
        return fallback


def _openai_realtime_max_output_tokens() -> int | str:
    value = os.getenv("OPENAI_REALTIME_MAX_OUTPUT_TOKENS", "1024").strip().lower()
    if value in {"inf", "infinite", "unlimited"}:
        return "inf"
    try:
        tokens = int(value)
    except ValueError as error:
        raise RuntimeError(
            "OPENAI_REALTIME_MAX_OUTPUT_TOKENS must be a positive integer or inf."
        ) from error
    if tokens <= 0:
        raise RuntimeError("OPENAI_REALTIME_MAX_OUTPUT_TOKENS must be positive.")
    return tokens


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


def _positive_int_env(name: str, fallback: int) -> int:
    value = os.getenv(name)
    if value is None or not value.strip():
        return fallback
    try:
        parsed = int(value)
    except ValueError as error:
        raise RuntimeError(f"{name} must be a positive integer.") from error
    if parsed <= 0:
        raise RuntimeError(f"{name} must be a positive integer.")
    return parsed


def _nonnegative_int_env(name: str, fallback: int) -> int:
    value = os.getenv(name)
    if value is None or not value.strip():
        return fallback
    try:
        parsed = int(value)
    except ValueError as error:
        raise RuntimeError(f"{name} must be zero or a positive integer.") from error
    if parsed < 0:
        raise RuntimeError(f"{name} must be zero or a positive integer.")
    return parsed


def _optional_positive_int_env(name: str, fallback: int | None) -> int | None:
    value = os.getenv(name)
    if value is None or not value.strip():
        return fallback
    normalized = value.strip().lower()
    if normalized in {"none", "off", "false", "disabled"}:
        return None
    try:
        parsed = int(normalized)
    except ValueError as error:
        raise RuntimeError(f"{name} must be a positive integer or none.") from error
    if parsed <= 0:
        raise RuntimeError(f"{name} must be a positive integer or none.")
    return parsed


def _positive_float_env(name: str, fallback: float) -> float:
    value = os.getenv(name)
    if value is None or not value.strip():
        return fallback
    try:
        parsed = float(value)
    except ValueError as error:
        raise RuntimeError(f"{name} must be a positive number.") from error
    if parsed <= 0:
        raise RuntimeError(f"{name} must be a positive number.")
    return parsed


def _optional_timeout_env(name: str) -> int | None:
    try:
        value = int(os.getenv(name, "0"))
    except ValueError:
        return None
    return value if value > 0 else None


def _openai_realtime_model() -> str:
    return os.getenv("OPENAI_REALTIME_MODEL", "gpt-realtime-2").strip()


def _context_summary_model() -> str:
    return (
        os.getenv("MITR_GATEWAY_CONTEXT_SUMMARY_MODEL")
        or os.getenv("OPENAI_CONTEXT_SUMMARY_MODEL")
        or _CONTEXT_SUMMARY_DEFAULT_MODEL
    ).strip()


def _context_summary_llm(api_key: str) -> OpenAILLMService:
    return OpenAILLMService(
        api_key=api_key,
        settings=OpenAILLMService.Settings(
            model=_context_summary_model(),
            temperature=_float_env("MITR_GATEWAY_CONTEXT_SUMMARY_TEMPERATURE", 0.2),
        ),
    )


def _context_summarization_assistant_params(api_key: str) -> LLMAssistantAggregatorParams:
    if not _bool_env("MITR_GATEWAY_CONTEXT_SUMMARIZATION", True):
        return LLMAssistantAggregatorParams()

    summary_config = LLMContextSummaryConfig(
        target_context_tokens=_positive_int_env(
            "MITR_GATEWAY_CONTEXT_SUMMARY_TARGET_TOKENS",
            _CONTEXT_SUMMARY_DEFAULT_TARGET_TOKENS,
        ),
        min_messages_after_summary=_nonnegative_int_env(
            "MITR_GATEWAY_CONTEXT_SUMMARY_KEEP_MESSAGES",
            _CONTEXT_SUMMARY_DEFAULT_KEEP_MESSAGES,
        ),
        llm=_context_summary_llm(api_key),
        summarization_timeout=_positive_float_env(
            "MITR_GATEWAY_CONTEXT_SUMMARY_TIMEOUT_SEC",
            _CONTEXT_SUMMARY_DEFAULT_TIMEOUT_SEC,
        ),
    )
    auto_config = LLMAutoContextSummarizationConfig(
        max_context_tokens=_optional_positive_int_env(
            "MITR_GATEWAY_CONTEXT_SUMMARY_MAX_CONTEXT_TOKENS",
            _CONTEXT_SUMMARY_DEFAULT_MAX_CONTEXT_TOKENS,
        ),
        max_unsummarized_messages=_optional_positive_int_env(
            "MITR_GATEWAY_CONTEXT_SUMMARY_MAX_UNSUMMARIZED_MESSAGES",
            _CONTEXT_SUMMARY_DEFAULT_MAX_UNSUMMARIZED_MESSAGES,
        ),
        summary_config=summary_config,
    )

    logger.info(
        "Pipecat auto context summarization enabled: model={} max_context_tokens={} "
        "max_unsummarized_messages={} target_tokens={} keep_messages={}",
        _context_summary_model(),
        auto_config.max_context_tokens,
        auto_config.max_unsummarized_messages,
        auto_config.summary_config.target_context_tokens,
        auto_config.summary_config.min_messages_after_summary,
    )
    return LLMAssistantAggregatorParams(
        enable_auto_context_summarization=True,
        auto_context_summarization_config=auto_config,
    )


def _register_context_summarization_logging(context_aggregator: LLMContextAggregatorPair) -> None:
    assistant_aggregator = context_aggregator.assistant()

    @assistant_aggregator.event_handler("on_summary_applied")
    async def on_summary_applied(aggregator, _summarizer, event):
        logger.info(
            "Pipecat context summary applied: original_messages={} new_messages={} "
            "summarized_messages={} preserved_messages={}",
            event.original_message_count,
            event.new_message_count,
            event.summarized_message_count,
            event.preserved_message_count,
        )
        if not _bool_env("MITR_GATEWAY_CONTEXT_SUMMARY_LOG_CONTENT", False):
            return

        summary = _latest_context_summary_text(aggregator.context.get_messages())
        if not summary:
            logger.info("Pipecat context summary content logging requested, but no summary found")
            return

        max_chars = _positive_int_env("MITR_GATEWAY_CONTEXT_SUMMARY_LOG_MAX_CHARS", 1200)
        preview = summary[:max_chars]
        if len(summary) > max_chars:
            preview += "...[truncated]"
        logger.info(
            "Pipecat context summary content: chars={} logged_chars={} text={}",
            len(summary),
            len(preview),
            preview,
        )


def _latest_context_summary_text(messages: list[Any]) -> str | None:
    for message in messages:
        if not isinstance(message, dict):
            continue
        content = message.get("content")
        if isinstance(content, str) and content.startswith("Conversation summary:"):
            return content
    return None


def _openai_realtime2_session_extra_fields(model: str) -> dict[str, object]:
    reasoning_effort = os.getenv("OPENAI_REALTIME_REASONING_EFFORT", "").strip().lower()
    truncation = os.getenv("OPENAI_REALTIME_TRUNCATION", "").strip().lower()
    retention_ratio = os.getenv("OPENAI_REALTIME_TRUNCATION_RETENTION_RATIO", "").strip()
    post_instructions_token_limit = os.getenv(
        "OPENAI_REALTIME_TRUNCATION_POST_INSTRUCTIONS_TOKEN_LIMIT",
        "",
    ).strip()
    has_realtime2_options = bool(
        reasoning_effort or truncation or retention_ratio or post_instructions_token_limit
    )
    if not has_realtime2_options:
        return {}

    if not model.startswith("gpt-realtime-2"):
        raise RuntimeError(
            "OPENAI_REALTIME_REASONING_EFFORT and OPENAI_REALTIME_TRUNCATION* require "
            "OPENAI_REALTIME_MODEL=gpt-realtime-2. Do not enable Realtime 2-only "
            f"session fields with model={model!r}."
        )

    extras: dict[str, object] = {}
    if reasoning_effort:
        if reasoning_effort not in _REALTIME2_REASONING_EFFORTS:
            allowed = ", ".join(sorted(_REALTIME2_REASONING_EFFORTS))
            raise RuntimeError(
                f"Invalid OPENAI_REALTIME_REASONING_EFFORT={reasoning_effort!r}; "
                f"expected one of: {allowed}."
            )
        extras["reasoning"] = {"effort": reasoning_effort}

    if retention_ratio:
        if truncation and truncation != "retention_ratio":
            raise RuntimeError(
                "OPENAI_REALTIME_TRUNCATION_RETENTION_RATIO cannot be combined with "
                "OPENAI_REALTIME_TRUNCATION unless it is set to retention_ratio."
            )
        try:
            ratio = float(retention_ratio)
        except ValueError as error:
            raise RuntimeError(
                "OPENAI_REALTIME_TRUNCATION_RETENTION_RATIO must be a number between 0 and 1."
            ) from error
        if ratio <= 0 or ratio >= 1:
            raise RuntimeError(
                "OPENAI_REALTIME_TRUNCATION_RETENTION_RATIO must be greater than 0 and less than 1."
            )
        truncation_config: dict[str, object] = {
            "type": "retention_ratio",
            "retention_ratio": ratio,
        }
        if post_instructions_token_limit:
            try:
                token_limit = int(post_instructions_token_limit)
            except ValueError as error:
                raise RuntimeError(
                    "OPENAI_REALTIME_TRUNCATION_POST_INSTRUCTIONS_TOKEN_LIMIT must be "
                    "a positive integer."
                ) from error
            if token_limit <= 0:
                raise RuntimeError(
                    "OPENAI_REALTIME_TRUNCATION_POST_INSTRUCTIONS_TOKEN_LIMIT must be "
                    "a positive integer."
                )
            truncation_config["token_limits"] = {"post_instructions": token_limit}
        extras["truncation"] = truncation_config
    elif truncation:
        if post_instructions_token_limit:
            raise RuntimeError(
                "OPENAI_REALTIME_TRUNCATION_POST_INSTRUCTIONS_TOKEN_LIMIT requires "
                "OPENAI_REALTIME_TRUNCATION=retention_ratio and "
                "OPENAI_REALTIME_TRUNCATION_RETENTION_RATIO."
            )
        if truncation not in _REALTIME2_TRUNCATION_MODES:
            allowed = ", ".join(sorted(_REALTIME2_TRUNCATION_MODES | {"retention_ratio"}))
            raise RuntimeError(
                f"Invalid OPENAI_REALTIME_TRUNCATION={truncation!r}; expected one of: {allowed}."
            )
        extras["truncation"] = truncation
    elif post_instructions_token_limit:
        raise RuntimeError(
            "OPENAI_REALTIME_TRUNCATION_POST_INSTRUCTIONS_TOKEN_LIMIT requires "
            "OPENAI_REALTIME_TRUNCATION=retention_ratio and "
            "OPENAI_REALTIME_TRUNCATION_RETENTION_RATIO."
        )

    return extras


class MitrRealtime2SessionOptionsMixin:
    _mitr_realtime2_session_options_logged = False

    async def send_client_event(self, event):  # type: ignore[override]
        payload: dict[str, Any] = event.model_dump(exclude_none=True)
        if payload.get("type") == "session.update":
            model = str(getattr(self._settings, "model", None) or _openai_realtime_model())
            extras = _openai_realtime2_session_extra_fields(model)
            if extras:
                session = payload.setdefault("session", {})
                if not isinstance(session, dict):
                    raise RuntimeError("OpenAI Realtime session.update payload is not an object.")
                session.update(extras)
                if not self._mitr_realtime2_session_options_logged:
                    logger.info(
                        "OpenAI Realtime 2 session options enabled for model={}: {}",
                        model,
                        sorted(extras.keys()),
                    )
                    self._mitr_realtime2_session_options_logged = True

        await self._ws_send(payload)


PROMPT_TEMPLATE_PATH = Path(__file__).resolve().parent / "prompts" / "mitr_system_prompt.md"
PROMPT_VARIABLE_PATTERN = re.compile(
    r"\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\}"
)


def _prompt_value(value: str | None) -> str:
    return value if value else "unknown"


def _system_prompt_template_context(auth: DeviceAuthContext) -> dict[str, str]:
    return {
        "auth.language": _prompt_value(auth.language),
        "auth.device_id": _prompt_value(auth.device_id),
        "auth.user_id": _prompt_value(auth.user_id),
        "auth.family_id": _prompt_value(auth.family_id),
        "auth.elder_id": _prompt_value(auth.elder_id),
        "language": _prompt_value(auth.language),
        "device_id": _prompt_value(auth.device_id),
        "user_id": _prompt_value(auth.user_id),
        "family_id": _prompt_value(auth.family_id),
        "elder_id": _prompt_value(auth.elder_id),
    }


def _load_system_prompt_template() -> str:
    if not PROMPT_TEMPLATE_PATH.exists():
        raise RuntimeError(f"Missing Mitr system prompt template: {PROMPT_TEMPLATE_PATH}")
    return PROMPT_TEMPLATE_PATH.read_text(encoding="utf-8")


def _system_instruction(auth: DeviceAuthContext) -> str:
    context = _system_prompt_template_context(auth)

    def replace_variable(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in context:
            raise RuntimeError(f"Unknown variable in Mitr system prompt template: {{{name}}}")
        return context[name]

    return PROMPT_VARIABLE_PATTERN.sub(replace_variable, _load_system_prompt_template())


def _system_instruction_with_context_packet(auth: DeviceAuthContext, payload: dict[str, object]) -> str:
    instruction = _system_instruction(auth)
    if not isinstance(payload, dict) or not payload.get("ok"):
        return instruction

    compact = json.dumps(payload, ensure_ascii=False)
    max_chars = _int_env("MITR_GATEWAY_CONTEXT_PACKET_MAX_CHARS", 5000)
    if len(compact) > max_chars:
        compact = compact[:max_chars] + "...[truncated]"

    return (
        f"{instruction}\n\n"
        "Runtime context packet for this connection. Use it as current context; do not read it aloud. "
        "Handle mustHandle items before optional topics unless the user is distressed or asks something urgent.\n"
        f"{compact}"
    )


def _response_output_text(evt: Any) -> str:
    parts: list[str] = []
    response = getattr(evt, "response", None)
    for item in getattr(response, "output", []) or []:
        for content in getattr(item, "content", []) or []:
            text = (
                getattr(content, "transcript", None)
                or getattr(content, "text", None)
                or getattr(content, "output_text", None)
            )
            if isinstance(text, str) and text:
                parts.append(text)
    return "".join(parts)


async def _fetch_runtime_context_packet(auth: DeviceAuthContext) -> dict[str, object] | None:
    if os.getenv("MITR_GATEWAY_INJECT_BOOT_CONTEXT", "false").strip().lower() not in {"1", "true", "yes", "on"}:
        return None

    try:
        result = await execute_backend_tool_once(
            "context_packet_get",
            {"triggerType": "session_start"},
            auth,
            timeout_sec=_float_env("MITR_GATEWAY_CONTEXT_PACKET_BACKGROUND_TIMEOUT_SEC", 1.0),
        )
    except Exception as error:
        logger.debug("Runtime context packet fetch failed: {}", str(error))
        return None

    payload = result.get("result") if isinstance(result, dict) and isinstance(result.get("result"), dict) else result
    return payload if isinstance(payload, dict) and payload.get("ok") else None


async def _queue_runtime_context_update(task: PipelineTask, llm: OpenAIRealtimeLLMService, auth: DeviceAuthContext) -> None:
    try:
        payload = await _fetch_runtime_context_packet(auth)
        if not payload:
            return

        await task.queue_frame(
            LLMUpdateSettingsFrame(
                delta=LLMSettings(system_instruction=_system_instruction_with_context_packet(auth, payload)),
                service=llm,
            )
        )
        logger.info("Runtime context packet injected asynchronously", device_id=auth.device_id)
    except Exception as error:
        logger.debug("Runtime context packet async injection failed: {}", str(error))


class PCM16Resampler(FrameProcessor):
    def __init__(self, *, target_sample_rate: int):
        super().__init__()
        self._target_sample_rate = target_sample_rate
        self._resampler = create_stream_resampler()
        self._frame_count = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if (
            direction == FrameDirection.DOWNSTREAM
            and isinstance(frame, InputAudioRawFrame)
            and frame.sample_rate != self._target_sample_rate
        ):
            audio = await self._resampler.resample(
                frame.audio,
                frame.sample_rate,
                self._target_sample_rate,
            )
            if not audio:
                return
            self._frame_count += 1
            if self._frame_count == 1 or self._frame_count % 100 == 0:
                logger.info(
                    "Resampled ESP32 audio frame #{}: {} Hz -> {} Hz, {} -> {} bytes",
                    self._frame_count,
                    frame.sample_rate,
                    self._target_sample_rate,
                    len(frame.audio),
                    len(audio),
                )
            frame = InputAudioRawFrame(
                audio=audio,
                sample_rate=self._target_sample_rate,
                num_channels=frame.num_channels,
            )

        await self.push_frame(frame, direction)
