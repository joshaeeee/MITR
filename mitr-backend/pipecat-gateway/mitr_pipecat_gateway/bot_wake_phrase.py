import asyncio
import os
import re
import time
import unicodedata
from collections import deque
from typing import Awaitable, Callable

from fastapi import WebSocket
from loguru import logger
from pipecat.audio.utils import create_stream_resampler
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    InterimTranscriptionFrame,
    LLMFullResponseEndFrame,
    LLMContextFrame,
    LLMRunFrame,
    LLMTextFrame,
    OutputAudioRawFrame,
    StartFrame,
    TTSTextFrame,
    TranscriptionFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.services.openai.llm import OpenAILLMService
from pipecat.services.openai.realtime.events import (
    AudioConfiguration,
    AudioInput,
    AudioOutput,
    PCMAudioFormat,
    SemanticTurnDetection,
    SessionProperties,
    TurnDetection,
)
from pipecat.services.openai.realtime.llm import OpenAIRealtimeLLMService
from pipecat.services.openai.stt import OpenAIRealtimeSTTService
from pipecat.services.google.gemini_live.llm import (
    GeminiLiveLLMService,
    GeminiModalities,
    GeminiVADParams,
)
from pipecat.services.tts_service import TextAggregationMode
from pipecat.transcriptions.language import Language
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)
from pipecat.turns.user_start.transcription_user_turn_start_strategy import (
    TranscriptionUserTurnStartStrategy,
)
from pipecat.turns.user_start.vad_user_turn_start_strategy import VADUserTurnStartStrategy
from pipecat.turns.user_start.wake_phrase_user_turn_start_strategy import (
    WakePhraseUserTurnStartStrategy,
)
from pipecat.turns.user_stop.external_user_turn_stop_strategy import ExternalUserTurnStopStrategy
from pipecat.turns.types import ProcessFrameResult
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from .auth import DeviceAuthContext
from .agnost import AgnostConfig, AgnostTurnRecorder
from .bot_common import (
    OPENAI_REALTIME_SAMPLE_RATE,
    MitrRealtime2SessionOptionsMixin,
    PCM16Resampler,
    _context_summarization_assistant_params,
    _int_env,
    _openai_realtime_max_output_tokens,
    _openai_realtime_model,
    _optional_timeout_env,
    _queue_runtime_context_update,
    _register_context_summarization_logging,
    _response_output_text,
    _system_instruction,
)
from .serializer import Esp32PCMSerializer
from .tools import (
    build_gemini_function_declarations,
    build_tools_schema,
    execute_gemini_live_tool,
    register_mitr_tools,
)


GEMINI_LIVE_DEFAULT_MODEL = "models/gemini-3.1-flash-live-preview"
_PIPELINE_OPENAI_REALTIME = "openai_realtime"
_PIPELINE_OPENAI_LLM_ELEVENLABS = "openai_llm_elevenlabs"
_PIPELINE_ALIASES = {
    "realtime": _PIPELINE_OPENAI_REALTIME,
    "openai": _PIPELINE_OPENAI_REALTIME,
    "openai-realtime": _PIPELINE_OPENAI_REALTIME,
    "openai_realtime": _PIPELINE_OPENAI_REALTIME,
    "elevenlabs": _PIPELINE_OPENAI_LLM_ELEVENLABS,
    "openai-elevenlabs": _PIPELINE_OPENAI_LLM_ELEVENLABS,
    "openai_llm_elevenlabs": _PIPELINE_OPENAI_LLM_ELEVENLABS,
    "stt-llm-tts": _PIPELINE_OPENAI_LLM_ELEVENLABS,
    "stt_llm_tts": _PIPELINE_OPENAI_LLM_ELEVENLABS,
}


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


def _optional_float_env(name: str) -> float | None:
    value = os.getenv(name)
    if value is None or not value.strip():
        return None
    try:
        return float(value)
    except ValueError as error:
        raise RuntimeError(f"{name} must be a number.") from error


def _gateway_pipeline_mode() -> str:
    value = (
        os.getenv("MITR_GATEWAY_PIPELINE_MODE")
        or os.getenv("MITR_GATEWAY_PIPELINE")
        or _PIPELINE_OPENAI_REALTIME
    )
    normalized = value.strip().lower()
    mode = _PIPELINE_ALIASES.get(normalized)
    if mode:
        return mode
    raise RuntimeError(
        "MITR_GATEWAY_PIPELINE_MODE must be openai_realtime or openai_llm_elevenlabs; "
        f"got {value!r}."
    )


def _realtime_provider() -> str:
    provider = os.getenv("MITR_GATEWAY_REALTIME_PROVIDER", "openai").strip().lower()
    aliases = {
        "openai_realtime": "openai",
        "google": "gemini_live",
        "gemini": "gemini_live",
        "gemini-live": "gemini_live",
    }
    provider = aliases.get(provider, provider)
    if provider not in {"openai", "gemini_live"}:
        raise RuntimeError(
            "MITR_GATEWAY_REALTIME_PROVIDER must be openai or gemini_live; "
            f"got {provider!r}."
        )
    return provider


def _gemini_live_model() -> str:
    requested = os.getenv("GEMINI_LIVE_MODEL", GEMINI_LIVE_DEFAULT_MODEL).strip()
    if not requested:
        return GEMINI_LIVE_DEFAULT_MODEL
    return requested


def _gemini_live_voice() -> str:
    return os.getenv("GEMINI_LIVE_VOICE", "Charon").strip() or "Charon"


def _gemini_live_service_mode() -> str:
    return os.getenv("GEMINI_LIVE_SERVICE", "direct_sdk").strip().lower().replace("-", "_")


def _gemini_live_language(auth: DeviceAuthContext) -> Language:
    return _language(os.getenv("GEMINI_LIVE_LANGUAGE") or auth.language or "en-US")


def _gemini_live_language_code(value: str) -> str:
    try:
        from pipecat.services.google.gemini_live.llm import language_to_gemini_language

        return language_to_gemini_language(_language(value)) or "en-US"
    except Exception:
        return value or "en-US"


def _gemini_live_system_instruction(auth: DeviceAuthContext) -> str:
    return _system_instruction(auth)


def _gemini_live_audio_send_pacing() -> bool:
    return _bool_env("GEMINI_LIVE_AUDIO_SEND_PACING", False)


def _gemini_live_input_batch_ms() -> int:
    batch_ms = _int_env("GEMINI_LIVE_INPUT_BATCH_MS", 20)
    if batch_ms < 0:
        raise RuntimeError("GEMINI_LIVE_INPUT_BATCH_MS must be non-negative")
    return batch_ms


def _gemini_live_backlog_input_batch_ms() -> int:
    batch_ms = _int_env("GEMINI_LIVE_BACKLOG_INPUT_BATCH_MS", 80)
    if batch_ms < 0:
        raise RuntimeError("GEMINI_LIVE_BACKLOG_INPUT_BATCH_MS must be non-negative")
    return batch_ms


def _gemini_live_explicit_vad_signal() -> bool:
    return _bool_env("GEMINI_LIVE_EXPLICIT_VAD_SIGNAL", False)


def _gemini_live_preconnect_on_connect() -> bool:
    return _bool_env("GEMINI_LIVE_PRECONNECT_ON_CONNECT", True)


def _gemini_live_activity_mode() -> str:
    mode = os.getenv("GEMINI_LIVE_ACTIVITY_MODE", "manual").strip().lower().replace("-", "_")
    if mode in {"explicit", "client", "client_vad", "manual_vad"}:
        return "manual"
    if mode in {"server", "server_vad", "automatic"}:
        return "auto"
    return mode


def _gemini_live_thinking_budget() -> int | None:
    value = os.getenv("GEMINI_LIVE_THINKING_BUDGET", "0").strip()
    if value.lower() in {"", "none", "default"}:
        return None
    try:
        return int(value)
    except ValueError as error:
        raise RuntimeError("GEMINI_LIVE_THINKING_BUDGET must be an integer, none, or default") from error


def _gemini_live_max_output_tokens() -> int | None:
    value = os.getenv("GEMINI_LIVE_MAX_OUTPUT_TOKENS", "default").strip()
    if value.lower() in {"", "none", "default"}:
        return None
    try:
        tokens = int(value)
    except ValueError as error:
        raise RuntimeError("GEMINI_LIVE_MAX_OUTPUT_TOKENS must be an integer, none, or default") from error
    if tokens <= 0:
        raise RuntimeError("GEMINI_LIVE_MAX_OUTPUT_TOKENS must be positive")
    return tokens


def _gemini_live_temperature() -> float | None:
    value = os.getenv("GEMINI_LIVE_TEMPERATURE", "0.2").strip()
    if value.lower() in {"", "none", "default"}:
        return None
    try:
        temperature = float(value)
    except ValueError as error:
        raise RuntimeError("GEMINI_LIVE_TEMPERATURE must be a number, none, or default") from error
    if temperature < 0:
        raise RuntimeError("GEMINI_LIVE_TEMPERATURE must be non-negative")
    return temperature


def _gemini_live_top_p() -> float | None:
    value = os.getenv("GEMINI_LIVE_TOP_P", "0.8").strip()
    if value.lower() in {"", "none", "default"}:
        return None
    try:
        top_p = float(value)
    except ValueError as error:
        raise RuntimeError("GEMINI_LIVE_TOP_P must be a number, none, or default") from error
    if not 0 < top_p <= 1:
        raise RuntimeError("GEMINI_LIVE_TOP_P must be greater than 0 and less than or equal to 1")
    return top_p


def _gemini_live_stale_output_guard_ms() -> int:
    guard_ms = _int_env("GEMINI_LIVE_STALE_OUTPUT_GUARD_MS", 0)
    if guard_ms < 0:
        raise RuntimeError("GEMINI_LIVE_STALE_OUTPUT_GUARD_MS must be non-negative")
    return guard_ms


def _gemini_live_server_vad_enabled() -> bool:
    return _bool_env("GEMINI_LIVE_SERVER_VAD", True)


def _gemini_live_server_vad_start_ms() -> int:
    value = _int_env("GEMINI_LIVE_SERVER_VAD_START_MS", 40)
    if value < 0:
        raise RuntimeError("GEMINI_LIVE_SERVER_VAD_START_MS must be non-negative")
    return value


def _gemini_live_server_vad_stop_ms() -> int:
    value = _int_env("GEMINI_LIVE_SERVER_VAD_STOP_MS", 120)
    if value < 0:
        raise RuntimeError("GEMINI_LIVE_SERVER_VAD_STOP_MS must be non-negative")
    return value


def _gemini_live_server_vad_preroll_ms() -> int:
    value = _int_env("GEMINI_LIVE_SERVER_VAD_PREROLL_MS", 180)
    if value < 0:
        raise RuntimeError("GEMINI_LIVE_SERVER_VAD_PREROLL_MS must be non-negative")
    return value


def _gemini_live_server_vad_speech_peak() -> float:
    value = _float_env("GEMINI_LIVE_SERVER_VAD_SPEECH_PEAK", 0.035)
    if value < 0:
        raise RuntimeError("GEMINI_LIVE_SERVER_VAD_SPEECH_PEAK must be non-negative")
    return value


def _gemini_live_server_vad_silence_peak() -> float:
    value = _float_env("GEMINI_LIVE_SERVER_VAD_SILENCE_PEAK", 0.014)
    if value < 0:
        raise RuntimeError("GEMINI_LIVE_SERVER_VAD_SILENCE_PEAK must be non-negative")
    return value


def _gemini_live_preconnect_before_listening() -> bool:
    return _bool_env("GEMINI_LIVE_PRECONNECT_BEFORE_LISTENING", False)


def _gemini_live_preconnect_timeout_sec() -> float:
    timeout = _float_env("GEMINI_LIVE_PRECONNECT_TIMEOUT_SEC", 2.0)
    if timeout <= 0:
        raise RuntimeError("GEMINI_LIVE_PRECONNECT_TIMEOUT_SEC must be positive")
    return timeout


def _echo_suppression_tail_ms(*, gemini_live: bool) -> int:
    if "MITR_GATEWAY_ECHO_SUPPRESSION_TAIL_MS" in os.environ:
        return _int_env("MITR_GATEWAY_ECHO_SUPPRESSION_TAIL_MS", 2500)
    if gemini_live:
        return _int_env("GEMINI_LIVE_ECHO_SUPPRESSION_TAIL_MS", 1200)
    return 2500


def _openai_llm_model() -> str:
    return os.getenv("OPENAI_LLM_MODEL", "gpt-4.1-mini").strip()


def _openai_realtime_stt_model(*, gemini_live: bool) -> str:
    configured = os.getenv("OPENAI_REALTIME_WAKE_STT_MODEL") or os.getenv(
        "OPENAI_REALTIME_STT_MODEL"
    )
    if configured and configured.strip():
        return configured.strip()
    if gemini_live:
        return "gpt-4o-mini-transcribe"
    return "gpt-4o-transcribe"


def _openai_llm_max_tokens() -> int:
    value = os.getenv("OPENAI_LLM_MAX_TOKENS", "512").strip()
    try:
        tokens = int(value)
    except ValueError as error:
        raise RuntimeError("OPENAI_LLM_MAX_TOKENS must be a positive integer.") from error
    if tokens <= 0:
        raise RuntimeError("OPENAI_LLM_MAX_TOKENS must be positive.")
    return tokens


def _elevenlabs_voice_id() -> str | None:
    return os.getenv("ELEVENLABS_VOICE_ID") or os.getenv("ELEVENLABS_VOICE")


def _elevenlabs_text_aggregation_mode() -> TextAggregationMode:
    value = os.getenv("ELEVENLABS_TEXT_AGGREGATION_MODE", "token").strip().lower()
    if value == "token":
        return TextAggregationMode.TOKEN
    if value == "sentence":
        return TextAggregationMode.SENTENCE
    raise RuntimeError("ELEVENLABS_TEXT_AGGREGATION_MODE must be token or sentence.")


def _elevenlabs_auto_mode(text_aggregation_mode: TextAggregationMode) -> bool:
    value = os.getenv("ELEVENLABS_AUTO_MODE")
    if value is None or not value.strip():
        return text_aggregation_mode != TextAggregationMode.TOKEN
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _elevenlabs_language(auth: DeviceAuthContext) -> Language:
    return _language(os.getenv("ELEVENLABS_TTS_LANGUAGE") or auth.language or "en")


def _wake_phrases() -> list[str]:
    value = os.getenv(
        "MITR_GATEWAY_WAKE_PHRASES",
        (
            "hi mitr,hey mitr,hi mitra,hey mitra,"
            "hi reca,hey reca,hi rekha,hey rekha,hi r e k a,hey r e k a,"
            "hi reka,hey reka,hi esp,hey esp,hi e s p,"
            "हाय मित्र,हे मित्र,हाय रेका,हाय रेखा"
        ),
    )
    return [phrase.strip() for phrase in value.split(",") if phrase.strip()]


def _wake_idle_timeout() -> float:
    if "MITR_GATEWAY_WAKE_IDLE_TIMEOUT_SEC" in os.environ:
        return _float_env("MITR_GATEWAY_WAKE_IDLE_TIMEOUT_SEC", 45.0)
    return _float_env("MITR_GATEWAY_WAKE_PHRASE_TIMEOUT_SEC", 45.0)


def _gemini_live_wake_idle_timeout() -> float:
    timeout = _float_env("GEMINI_LIVE_WAKE_IDLE_TIMEOUT_SEC", 15.0)
    if timeout <= 0:
        raise RuntimeError("GEMINI_LIVE_WAKE_IDLE_TIMEOUT_SEC must be positive")
    return timeout


def _post_wake_turn_start_strategies():
    return [
        VADUserTurnStartStrategy(enable_interruptions=False),
        TranscriptionUserTurnStartStrategy(enable_interruptions=False),
    ]


def _wake_use_interim_transcripts() -> bool:
    return _bool_env("MITR_GATEWAY_WAKE_USE_INTERIM_TRANSCRIPTS", True)


def _wake_stt_pre_ready_flush_batch_ms() -> int:
    batch_ms = _int_env("MITR_GATEWAY_WAKE_STT_PRE_READY_FLUSH_BATCH_MS", 240)
    if batch_ms <= 0:
        raise RuntimeError("MITR_GATEWAY_WAKE_STT_PRE_READY_FLUSH_BATCH_MS must be positive")
    return batch_ms


def _wake_stt_async_connect() -> bool:
    return _bool_env("MITR_GATEWAY_WAKE_STT_ASYNC_CONNECT", True)


def _gemini_live_transcript_wake_preroll_sec() -> float:
    if "GEMINI_LIVE_TRANSCRIPT_WAKE_PREROLL_SEC" in os.environ:
        value = _float_env("GEMINI_LIVE_TRANSCRIPT_WAKE_PREROLL_SEC", 0.5)
    else:
        value = _float_env("MITR_GATEWAY_WAKE_PHRASE_PREROLL_SEC", 0.5)
    if value < 0:
        raise RuntimeError("GEMINI_LIVE_TRANSCRIPT_WAKE_PREROLL_SEC must be non-negative")
    return value


def _gemini_live_preroll_flush_batch_ms() -> int:
    batch_ms = _int_env("GEMINI_LIVE_PREROLL_FLUSH_BATCH_MS", 80)
    if batch_ms < 0:
        raise RuntimeError("GEMINI_LIVE_PREROLL_FLUSH_BATCH_MS must be non-negative")
    return batch_ms


def _user_safe_gateway_error(source: str, message: str) -> str:
    if source == "openai_realtime_stt" and "invalid_api_key" in message:
        return (
            "OpenAI realtime STT rejected OPENAI_API_KEY (invalid_api_key). "
            "Wake-word transcription is disabled until the key is fixed."
        )
    return message


def _language(value: str) -> Language:
    try:
        return Language(value)
    except ValueError:
        language = value.split("-", 1)[0].lower()
        try:
            return Language(language)
        except ValueError:
            return Language.EN


def _openai_turn_detection() -> TurnDetection | SemanticTurnDetection | bool:
    mode = os.getenv("OPENAI_REALTIME_TURN_DETECTION", "manual").strip().lower()
    if mode in {"off", "false", "none", "disabled", "manual"}:
        return False
    raise RuntimeError(
        "Wake-phrase gateway requires OPENAI_REALTIME_TURN_DETECTION=manual. "
        "OpenAIRealtimeSTTService owns speech detection and the Realtime LLM "
        "must not auto-create responses."
    )


def _describe_turn_detection(turn_detection: TurnDetection | SemanticTurnDetection | bool) -> str:
    if turn_detection is False:
        return "manual"
    if isinstance(turn_detection, SemanticTurnDetection):
        return (
            f"semantic_vad eagerness={turn_detection.eagerness} "
            f"interrupt_response={turn_detection.interrupt_response}"
        )
    return (
        "server_vad "
        f"threshold={turn_detection.threshold} "
        f"silence_duration_ms={turn_detection.silence_duration_ms} "
        f"prefix_padding_ms={turn_detection.prefix_padding_ms}"
    )


def _log_background_task_failure(task: asyncio.Task, label: str):
    try:
        task.result()
    except asyncio.CancelledError:
        return
    except Exception as error:
        logger.warning("{} failed: {}", label, error)


def _schedule_latency_background(coro, label: str) -> asyncio.Task:
    task = asyncio.create_task(coro)
    task.add_done_callback(lambda done: _log_background_task_failure(done, label))
    return task


async def _warm_gemini_live_session(llm, *, timeout_sec: float, label: str) -> bool:
    try:
        await asyncio.wait_for(llm.preconnect(wait_ready=True), timeout=timeout_sec)
        logger.info("{} ready", label)
        return True
    except asyncio.TimeoutError:
        logger.warning("{} still connecting after {}s", label, timeout_sec)
        return False


async def _preconnect_gemini_live_for_client(llm) -> asyncio.Task | None:
    if not _gemini_live_preconnect_on_connect():
        return None

    timeout_sec = _gemini_live_preconnect_timeout_sec()
    if _gemini_live_preconnect_before_listening():
        await _warm_gemini_live_session(
            llm,
            timeout_sec=timeout_sec,
            label="Gemini Live session preconnect before listening",
        )
        return None

    task = _schedule_latency_background(
        _warm_gemini_live_session(
            llm,
            timeout_sec=timeout_sec,
            label="Gemini Live session background preconnect",
        ),
        "Gemini Live session background preconnect",
    )
    logger.info("Gemini Live session preconnect started in background")
    return task


async def _start_gemini_live_preconnect_early(
    llm,
    *,
    gemini_direct: bool,
) -> asyncio.Task | None:
    if not gemini_direct:
        return None
    return await _preconnect_gemini_live_for_client(llm)


def _strip_wake_phrase_punctuation(text: str) -> str:
    normalized = unicodedata.normalize("NFC", text)
    return "".join(
        char
        if char.isspace() or not unicodedata.category(char).startswith(("P", "S", "C"))
        else " "
        for char in normalized
    )


def _wake_phrase_pattern(phrase: str) -> re.Pattern:
    normalized = _strip_wake_phrase_punctuation(phrase).strip()
    body = r"\s*".join(re.escape(word) for word in normalized.split())
    return re.compile(r"(?<!\w)" + body + r"(?!\w)", re.IGNORECASE)


def _wake_phrase_aliases(phrases: list[str] | None = None) -> list[str]:
    configured = phrases if phrases is not None else _wake_phrases()
    aliases = set(configured)
    normalized = {_strip_wake_phrase_punctuation(phrase).strip().lower() for phrase in configured}

    def add_if_configured(triggers: set[str], extra_aliases: set[str]):
        if normalized & triggers:
            aliases.update(extra_aliases)

    add_if_configured(
        {"hi esp", "hey esp", "hi e s p", "hey e s p"},
        {"हाय ईएसपी", "हे ईएसपी", "हाय ई एस पी", "हे ई एस पी"},
    )
    add_if_configured(
        {"hi reca", "hey reca", "hi reka", "hey reka", "hi rekha", "hey rekha"},
        {"हाय रेका", "हे रेका", "हाय रेखा", "हे रेखा"},
    )
    add_if_configured(
        {"hi r e k a", "hey r e k a"},
        {"हाय आर ई के ए", "हे आर ई के ए"},
    )
    add_if_configured(
        {"hi mitr", "hey mitr", "hi mitra", "hey mitra"},
        {
            "hi meter",
            "hey meter",
            "hi miter",
            "hey miter",
            "hi mitter",
            "hey mitter",
            "hi mithra",
            "hey mithra",
            "hi meet her",
            "hey meet her",
            "हाय मित्र",
            "हे मित्र",
            "हाय मित्रा",
            "हे मित्रा",
        },
    )

    return sorted((phrase for phrase in aliases if phrase.strip()), key=len, reverse=True)


class UnicodeWakePhraseUserTurnStartStrategy(WakePhraseUserTurnStartStrategy):
    def __init__(
        self,
        *,
        phrases: list[str],
        include_interim_transcripts: bool = True,
        **kwargs,
    ):
        super().__init__(phrases=phrases, **kwargs)
        self._phrases = _wake_phrase_aliases(phrases)
        self._patterns = [_wake_phrase_pattern(phrase) for phrase in self._phrases]
        self._include_interim_transcripts = include_interim_transcripts
        self._compact_accumulated_text = ""

    @staticmethod
    def _strip_punctuation(text: str) -> str:
        return _strip_wake_phrase_punctuation(text)

    async def _process_idle(self, frame: Frame) -> ProcessFrameResult:
        if (
            self._include_interim_transcripts
            and isinstance(frame, InterimTranscriptionFrame)
            and self._check_wake_phrase(frame.text)
        ):
            await self.trigger_user_turn_started()
            return ProcessFrameResult.STOP

        return await super()._process_idle(frame)

    def _check_wake_phrase(self, text: str) -> bool:
        clean = self._strip_punctuation(text)
        self._accumulated_text = (self._accumulated_text + " " + clean)[-250:]
        self._compact_accumulated_text = (self._compact_accumulated_text + clean)[-250:]

        for i, pattern in enumerate(self._patterns):
            if pattern.search(self._accumulated_text) or pattern.search(
                self._compact_accumulated_text
            ):
                phrase = self._phrases[i]
                logger.debug("{} wake phrase detected: {!r}", self, phrase)
                self._transition_to_awake(phrase)
                return True

        return False

    def _transition_to_awake(self, phrase: str):
        self._compact_accumulated_text = ""
        super()._transition_to_awake(phrase)

    def _transition_to_idle(self):
        self._compact_accumulated_text = ""
        super()._transition_to_idle()


class WakeOnlyOpenAIRealtimeSTTService(OpenAIRealtimeSTTService):
    _PERMANENT_ERROR_CODES = {"invalid_api_key", "insufficient_quota"}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._wake_listening = True
        self._pre_ready_audio_buffer: deque[tuple[InputAudioRawFrame, FrameDirection]] = deque()
        self._pre_ready_audio_bytes = 0
        self._max_pre_ready_audio_bytes = int(
            _int_env("ESP32_AUDIO_IN_SAMPLE_RATE", 16000)
            * max(_float_env("MITR_GATEWAY_WAKE_STT_PRE_READY_BUFFER_SEC", 1.5), 0.0)
            * 2
        )
        self._pre_ready_flush_batch_ms = _wake_stt_pre_ready_flush_batch_ms()
        self._async_connect = _wake_stt_async_connect()
        self._connect_task: asyncio.Task | None = None

    def _clear_pre_ready_audio_buffer(self):
        self._pre_ready_audio_buffer.clear()
        self._pre_ready_audio_bytes = 0

    def _buffer_pre_ready_audio(self, frame: InputAudioRawFrame, direction: FrameDirection):
        if self._max_pre_ready_audio_bytes <= 0:
            return
        self._pre_ready_audio_buffer.append((frame, direction))
        self._pre_ready_audio_bytes += len(frame.audio)
        while (
            self._pre_ready_audio_buffer
            and self._pre_ready_audio_bytes > self._max_pre_ready_audio_bytes
        ):
            dropped, _direction = self._pre_ready_audio_buffer.popleft()
            self._pre_ready_audio_bytes -= len(dropped.audio)

    async def _flush_pre_ready_audio_buffer(self):
        batch = bytearray()
        batch_sample_rate: int | None = None
        batch_channels = 1
        batch_direction = FrameDirection.DOWNSTREAM
        batch_limit_bytes = 0

        async def flush_batch():
            nonlocal batch, batch_sample_rate, batch_channels, batch_direction, batch_limit_bytes
            if not batch:
                return
            if self._wake_listening:
                await super(WakeOnlyOpenAIRealtimeSTTService, self).process_audio_frame(
                    InputAudioRawFrame(
                        audio=bytes(batch),
                        sample_rate=batch_sample_rate or _int_env("ESP32_AUDIO_IN_SAMPLE_RATE", 16000),
                        num_channels=batch_channels,
                    ),
                    batch_direction,
                )
            batch = bytearray()
            batch_sample_rate = None
            batch_channels = 1
            batch_direction = FrameDirection.DOWNSTREAM
            batch_limit_bytes = 0

        while self._pre_ready_audio_buffer:
            frame, direction = self._pre_ready_audio_buffer.popleft()
            self._pre_ready_audio_bytes -= len(frame.audio)
            frame_limit_bytes = int(
                frame.sample_rate
                * max(frame.num_channels, 1)
                * 2
                * self._pre_ready_flush_batch_ms
                / 1000
            )
            if (
                batch
                and (
                    batch_sample_rate != frame.sample_rate
                    or batch_channels != frame.num_channels
                    or batch_direction != direction
                    or len(batch) + len(frame.audio) > batch_limit_bytes
                )
            ):
                await flush_batch()

            if not batch:
                batch_sample_rate = frame.sample_rate
                batch_channels = frame.num_channels
                batch_direction = direction
                batch_limit_bytes = max(frame_limit_bytes, len(frame.audio))

            batch.extend(frame.audio)

        await flush_batch()
        self._pre_ready_audio_bytes = 0

    async def set_wake_listening(self, enabled: bool, *, wait_for_clear: bool = True):
        if self._wake_listening == enabled:
            return
        self._wake_listening = enabled
        if not enabled:
            self._clear_pre_ready_audio_buffer()
        logger.info("OpenAI wake transcription {}", "enabled" if enabled else "bypassed")
        if self._websocket:
            clear_buffer = self._clear_audio_buffer()
            if wait_for_clear:
                await clear_buffer
            else:
                _schedule_latency_background(
                    clear_buffer,
                    "OpenAI wake transcription buffer clear",
                )

    async def process_audio_frame(self, frame: InputAudioRawFrame, direction: FrameDirection):
        if not self._wake_listening:
            return
        if not self._session_ready:
            self._buffer_pre_ready_audio(frame, direction)
            return
        await super().process_audio_frame(frame, direction)

    async def start(self, frame: StartFrame):
        if not self._async_connect:
            await super().start(frame)
            return

        await super(OpenAIRealtimeSTTService, self).start(frame)
        if self._connect_task is None or self._connect_task.done():
            self._connect_task = self.create_task(
                self._connect(),
                name="wake_stt_connect",
            )
            self._connect_task.add_done_callback(
                lambda done: _log_background_task_failure(done, "OpenAI wake STT connect")
            )

    async def _cancel_connect_task(self):
        if self._connect_task and not self._connect_task.done():
            await self.cancel_task(self._connect_task, timeout=1.0)
        self._connect_task = None

    async def stop(self, frame: EndFrame):
        await self._cancel_connect_task()
        await super().stop(frame)

    async def cancel(self, frame: CancelFrame):
        await self._cancel_connect_task()
        await super().cancel(frame)

    async def _handle_session_updated(self, evt: dict):
        await super()._handle_session_updated(evt)
        await self._flush_pre_ready_audio_buffer()

    async def _handle_error(self, evt: dict):
        error = evt.get("error", {})
        error_code = error.get("code", "")
        if error_code in self._PERMANENT_ERROR_CODES:
            self._reconnect_on_error = False
            self._wake_listening = False
            self._reconnect_audio_buffer.clear()
            self._clear_pre_ready_audio_buffer()
            error_msg = error.get("message", "Unknown error")
            msg = f"OpenAI Realtime STT error [{error_code}]: {error_msg}"
            await self.push_error(error_msg=msg)
            raise Exception(msg)
        await super()._handle_error(evt)


class WakePhraseDetector(FrameProcessor):
    """Runs wake phrase strategy without LLM context aggregation."""

    def __init__(self, wake_phrase: WakePhraseUserTurnStartStrategy):
        super().__init__()
        self._wake_phrase = wake_phrase
        self._strategy_started = False

    async def _start_strategy(self):
        if self._strategy_started:
            return
        await self._wake_phrase.setup(self.task_manager)
        self._strategy_started = True

    async def _cleanup_strategy(self):
        if not self._strategy_started:
            return
        await self._wake_phrase.cleanup()
        self._strategy_started = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, StartFrame):
            await self.push_frame(frame, direction)
            await self._start_strategy()
            return

        if isinstance(frame, EndFrame):
            await self.push_frame(frame, direction)
            await self._cleanup_strategy()
            return

        if isinstance(frame, CancelFrame):
            await self._cleanup_strategy()
            await self.push_frame(frame, direction)
            return

        if self._strategy_started:
            await self._wake_phrase.process_frame(frame)

        if isinstance(frame, (TranscriptionFrame, InterimTranscriptionFrame)):
            return

        await self.push_frame(frame, direction)


class WakePhraseRealtimeGate(FrameProcessor):
    def __init__(
        self,
        *,
        preroll_sec: float,
        forward_audio_when_awake: bool = True,
        preroll_flush_batch_ms: int = 0,
    ):
        super().__init__()
        self._awake = False
        self._forward_audio_when_awake = forward_audio_when_awake
        self._preroll_flush_batch_ms = max(preroll_flush_batch_ms, 0)
        self._pending_stop = False
        self._buffer: deque[InputAudioRawFrame] = deque()
        self._buffer_bytes = 0
        self._max_buffer_bytes = int(
            _int_env("ESP32_AUDIO_IN_SAMPLE_RATE", 16000) * max(preroll_sec, 0.0) * 2
        )
        self._dropped_llm_frames = 0

    async def wake(self, phrase: str):
        if self._awake:
            return

        self._awake = True
        logger.info(
            "Pipecat wake phrase detected: {!r}; flushing {} buffered audio frames",
            phrase,
            len(self._buffer),
        )

        await self.push_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        if self._forward_audio_when_awake:
            await self._flush_buffered_audio()
        else:
            self._buffer.clear()
        self._buffer_bytes = 0

        if self._pending_stop:
            self._pending_stop = False
            await self.push_frame(UserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)

    async def sleep(self):
        if self._awake:
            logger.info("Pipecat wake phrase timeout; gate closed")
        self._awake = False
        self._pending_stop = False
        self._buffer.clear()
        self._buffer_bytes = 0
        self._dropped_llm_frames = 0

    def _buffer_audio(self, frame: InputAudioRawFrame):
        self._buffer.append(frame)
        self._buffer_bytes += len(frame.audio)
        while self._buffer and self._buffer_bytes > self._max_buffer_bytes:
            dropped = self._buffer.popleft()
            self._buffer_bytes -= len(dropped.audio)

    async def _flush_buffered_audio(self):
        if self._preroll_flush_batch_ms <= 0:
            while self._buffer:
                await self.push_frame(self._buffer.popleft(), FrameDirection.DOWNSTREAM)
            self._buffer_bytes = 0
            return

        batch = bytearray()
        batch_sample_rate: int | None = None
        batch_channels = 1
        batch_limit_bytes = 0

        async def flush_batch():
            nonlocal batch, batch_sample_rate, batch_channels, batch_limit_bytes
            if not batch:
                return
            await self.push_frame(
                InputAudioRawFrame(
                    audio=bytes(batch),
                    sample_rate=batch_sample_rate or _int_env("ESP32_AUDIO_IN_SAMPLE_RATE", 16000),
                    num_channels=batch_channels,
                ),
                FrameDirection.DOWNSTREAM,
            )
            batch = bytearray()
            batch_sample_rate = None
            batch_channels = 1
            batch_limit_bytes = 0

        while self._buffer:
            frame = self._buffer.popleft()
            self._buffer_bytes -= len(frame.audio)
            frame_limit_bytes = int(
                frame.sample_rate
                * max(frame.num_channels, 1)
                * 2
                * self._preroll_flush_batch_ms
                / 1000
            )
            if (
                batch
                and (
                    batch_sample_rate != frame.sample_rate
                    or batch_channels != frame.num_channels
                    or len(batch) + len(frame.audio) > batch_limit_bytes
                )
            ):
                await flush_batch()

            if not batch:
                batch_sample_rate = frame.sample_rate
                batch_channels = frame.num_channels
                batch_limit_bytes = max(frame_limit_bytes, len(frame.audio))

            batch.extend(frame.audio)

        await flush_batch()
        self._buffer_bytes = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if direction != FrameDirection.DOWNSTREAM:
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, InputAudioRawFrame) and not self._awake:
            self._buffer_audio(frame)
            return

        if isinstance(frame, InputAudioRawFrame) and not self._forward_audio_when_awake:
            return

        if isinstance(frame, (LLMContextFrame, LLMRunFrame)) and not self._awake:
            self._dropped_llm_frames += 1
            if self._dropped_llm_frames == 1 or self._dropped_llm_frames % 20 == 0:
                logger.info(
                    "Wake gate dropped {} while sleeping; dropped_llm_frames={}",
                    frame.__class__.__name__,
                    self._dropped_llm_frames,
                )
            return

        if isinstance(frame, UserStartedSpeakingFrame) and not self._awake:
            return

        if isinstance(frame, UserStoppedSpeakingFrame) and not self._awake:
            self._pending_stop = True
            return

        await self.push_frame(frame, direction)


async def _open_transcript_wake_fast(
    *,
    stt: WakeOnlyOpenAIRealtimeSTTService,
    gate: WakePhraseRealtimeGate,
    notify_awake,
    phrase: str,
) -> list[asyncio.Task]:
    """Open Gemini's audio path before slower wake-side effects complete."""

    await stt.set_wake_listening(False, wait_for_clear=False)
    background_tasks = [
        _schedule_latency_background(
            notify_awake(phrase),
            "wake notification",
        ),
    ]
    await gate.wake(phrase)
    return background_tasks


class DirectGeminiLiveAudioService(FrameProcessor):
    def __init__(
        self,
        *,
        auth: DeviceAuthContext,
        output_sample_rate: int,
        on_latency_event: Callable[[dict], Awaitable[None]] | None = None,
        websocket: WebSocket | None = None,
        on_tool_start: Callable[[str, dict], Awaitable[None]] | None = None,
        on_tool_end: Callable[[str, dict, object, bool, int], Awaitable[None]] | None = None,
        on_activity: Callable[[], Awaitable[None]] | None = None,
    ):
        super().__init__()
        self._auth = auth
        self._output_sample_rate = output_sample_rate
        self._on_latency_event = on_latency_event
        self._websocket = websocket
        self._on_tool_start = on_tool_start
        self._on_tool_end = on_tool_end
        self._on_activity = on_activity
        self._tool_declarations = build_gemini_function_declarations()
        self._tool_tasks: set[asyncio.Task] = set()
        self._audio_queue: asyncio.Queue[InputAudioRawFrame | str | None] = asyncio.Queue()
        self._session_task: asyncio.Task | None = None
        self._closed = False
        self._session_ready = asyncio.Event()
        self._response_audio_frames = 0
        self._input_audio_frames = 0
        self._first_input_at: float | None = None
        self._last_input_at: float | None = None
        self._turn_started_at: float | None = None
        self._first_response_at: float | None = None
        self._first_audio_sent_at: float | None = None
        self._last_audio_sent_at: float | None = None
        self._activity_start_sent_at: float | None = None
        self._activity_end_sent_at: float | None = None
        self._awake = False
        self._user_activity_open = False
        self._last_activity_notify_at: float | None = None
        self._last_user_stop_at: float | None = None
        self._dropped_output_while_user_active = 0
        self._dropped_stale_output_after_user_stop = 0
        self._dropped_output_while_sleeping = 0
        self._dropped_input_while_user_inactive = 0
        self._pacing_enabled = _gemini_live_audio_send_pacing()
        self._input_batch_ms = _gemini_live_input_batch_ms()
        self._backlog_input_batch_ms = _gemini_live_backlog_input_batch_ms()
        self._stale_output_guard_ms = _gemini_live_stale_output_guard_ms()
        self._activity_mode = _gemini_live_activity_mode()
        self._server_vad_enabled = (
            self._activity_mode == "manual" and _gemini_live_server_vad_enabled()
        )
        self._server_vad_start_ms = _gemini_live_server_vad_start_ms()
        self._server_vad_stop_ms = _gemini_live_server_vad_stop_ms()
        self._server_vad_preroll_ms = _gemini_live_server_vad_preroll_ms()
        self._server_vad_speech_peak = _gemini_live_server_vad_speech_peak()
        self._server_vad_silence_peak = _gemini_live_server_vad_silence_peak()
        self._vad_speech_ms = 0.0
        self._vad_silence_ms = 0.0
        self._vad_speech_seen = False
        self._vad_preroll: deque[InputAudioRawFrame] = deque()
        self._vad_preroll_ms = 0.0
        self._output_resampler = create_stream_resampler()

    def _drain_pending_input_for_sleep(self):
        dropped = 0
        while True:
            try:
                item = self._audio_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if item is None:
                self._audio_queue.put_nowait(None)
                break
            dropped += 1
        if dropped:
            logger.info("Gemini Live dropped {} queued input item(s) while going to sleep", dropped)

    async def set_awake(self, awake: bool):
        if awake:
            self._awake = True
            self._dropped_output_while_sleeping = 0
            self._reset_vad_state(clear_preroll=True)
            return

        was_activity_open = self._user_activity_open
        self._awake = False
        self._user_activity_open = False
        self._last_user_stop_at = time.perf_counter()
        self._reset_vad_state(clear_preroll=True)
        self._drain_pending_input_for_sleep()
        if was_activity_open and self._activity_mode == "manual":
            await self._ensure_session()
            await self._audio_queue.put("activity_end")

    async def _notify_activity(self, *, force: bool = False):
        if self._on_activity is None:
            return
        now = time.perf_counter()
        if (
            not force
            and self._last_activity_notify_at is not None
            and now - self._last_activity_notify_at < 1.0
        ):
            return
        self._last_activity_notify_at = now
        try:
            await self._on_activity()
        except Exception as error:
            logger.warning("Gemini Live activity callback failed: {}", str(error))

    def _frame_duration_ms(self, frame: InputAudioRawFrame) -> float:
        return len(frame.audio) / max(frame.sample_rate * frame.num_channels * 2, 1) * 1000

    def _frame_peak(self, frame: InputAudioRawFrame) -> float:
        peak = 0
        audio = frame.audio
        for index in range(0, len(audio) - 1, 2):
            sample = int.from_bytes(audio[index:index + 2], "little", signed=True)
            peak = max(peak, abs(sample))
        return peak / 32768

    def _reset_vad_state(self, *, clear_preroll: bool = False):
        self._vad_speech_ms = 0.0
        self._vad_silence_ms = 0.0
        self._vad_speech_seen = False
        if clear_preroll:
            self._vad_preroll.clear()
            self._vad_preroll_ms = 0.0

    def _remember_vad_preroll(self, frame: InputAudioRawFrame, duration_ms: float):
        if self._server_vad_preroll_ms <= 0:
            return
        self._vad_preroll.append(frame)
        self._vad_preroll_ms += duration_ms
        while self._vad_preroll and self._vad_preroll_ms > self._server_vad_preroll_ms:
            dropped = self._vad_preroll.popleft()
            self._vad_preroll_ms -= self._frame_duration_ms(dropped)

    async def _queue_vad_preroll(self):
        while self._vad_preroll:
            await self._audio_queue.put(self._vad_preroll.popleft())
        self._vad_preroll_ms = 0.0

    async def _begin_user_activity(self, direction: FrameDirection, *, forward_frame: bool = True):
        if self._user_activity_open:
            await self._notify_activity()
            if forward_frame:
                await self.push_frame(UserStartedSpeakingFrame(), direction)
            return False
        self._turn_started_at = time.perf_counter()
        self._first_input_at = None
        self._last_input_at = None
        self._first_response_at = None
        self._first_audio_sent_at = None
        self._last_audio_sent_at = None
        self._activity_start_sent_at = None
        self._activity_end_sent_at = None
        self._response_audio_frames = 0
        self._input_audio_frames = 0
        self._user_activity_open = True
        self._last_user_stop_at = None
        self._dropped_output_while_user_active = 0
        self._dropped_stale_output_after_user_stop = 0
        self._dropped_input_while_user_inactive = 0
        self._reset_vad_state()
        await self._ensure_session()
        if self._activity_mode == "manual":
            await self._audio_queue.put("activity_start")
        await self._notify_activity(force=True)
        if forward_frame:
            await self.push_frame(UserStartedSpeakingFrame(), direction)
        return True

    async def _end_user_activity(self, direction: FrameDirection, *, forward_frame: bool = True):
        if self._activity_mode == "manual" and not self._user_activity_open:
            await self._notify_activity()
            if forward_frame:
                await self.push_frame(UserStoppedSpeakingFrame(), direction)
            return False
        await self._ensure_session()
        self._user_activity_open = False
        self._last_user_stop_at = time.perf_counter()
        self._reset_vad_state(clear_preroll=True)
        await self._audio_queue.put(
            "activity_end" if self._activity_mode == "manual" else "audio_stream_end"
        )
        await self._notify_activity(force=True)
        if forward_frame:
            await self.push_frame(UserStoppedSpeakingFrame(), direction)
        return True

    async def _ensure_session(self):
        if self._closed:
            return
        if self._session_task is None or self._session_task.done():
            self._session_ready.clear()
            self._session_task = asyncio.create_task(self._run_session())

    async def preconnect(self, *, wait_ready: bool = False):
        await self._ensure_session()
        if wait_ready and self._session_task is not None:
            await self._session_ready.wait()

    async def _run_session(self):
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY", ""))
        language = _gemini_live_language_code(self._auth.language or "en-US")
        realtime_input_config = (
            types.RealtimeInputConfig(
                automatic_activity_detection=types.AutomaticActivityDetection(disabled=True),
                activity_handling=types.ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
                turn_coverage=types.TurnCoverage.TURN_INCLUDES_ONLY_ACTIVITY,
            )
            if self._activity_mode == "manual"
            else None
        )
        thinking_budget = _gemini_live_thinking_budget()
        tools = (
            [
                types.Tool(
                    function_declarations=[
                        types.FunctionDeclaration(**declaration)
                        for declaration in self._tool_declarations
                    ]
                )
            ]
            if self._tool_declarations
            else None
        )
        config = types.LiveConnectConfig(
            response_modalities=[types.Modality.AUDIO],
            tools=tools,
            realtime_input_config=realtime_input_config,
            thinking_config=(
                types.ThinkingConfig(thinking_budget=thinking_budget)
                if thinking_budget is not None
                else None
            ),
            max_output_tokens=_gemini_live_max_output_tokens(),
            temperature=_gemini_live_temperature(),
            top_p=_gemini_live_top_p(),
            explicit_vad_signal=(
                True
                if self._activity_mode == "manual" and _gemini_live_explicit_vad_signal()
                else None
            ),
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name=_gemini_live_voice(),
                    )
                ),
                language_code=language,
            ),
            system_instruction=types.Content(
                role="system",
                parts=[types.Part(text=_gemini_live_system_instruction(self._auth))],
            ),
        )
        logger.info(
            "Connecting to Gemini Live direct SDK service: model={} voice={} language={}",
            _gemini_live_model(),
            _gemini_live_voice(),
            language,
        )
        receive_task = None
        send_task = None
        async with client.aio.live.connect(model=_gemini_live_model(), config=config) as session:
            try:
                logger.info("Connected to Gemini Live direct SDK service")
                self._session_ready.set()
                receive_task = asyncio.create_task(self._receive_audio(session, types))
                send_task = asyncio.create_task(self._send_audio(session, types))
                done, pending = await asyncio.wait(
                    {receive_task, send_task},
                    return_when=asyncio.FIRST_EXCEPTION,
                )
                for task in pending:
                    task.cancel()
                for result in await asyncio.gather(*done, return_exceptions=True):
                    if isinstance(result, Exception) and not self._closed:
                        raise result
            finally:
                self._session_ready.clear()
                tasks = [task for task in (receive_task, send_task) if task is not None]
                for task in tasks:
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

    async def _send_audio(self, session, types):
        batch = bytearray()
        batch_sample_rate: int | None = None
        batch_channels = 1

        async def flush_batch():
            nonlocal batch, batch_sample_rate, batch_channels
            if not batch:
                return
            sample_rate = batch_sample_rate or OPENAI_REALTIME_SAMPLE_RATE
            audio = bytes(batch)
            batch = bytearray()
            batch_sample_rate = None
            batch_channels = 1
            await session.send_realtime_input(
                audio=types.Blob(
                    data=audio,
                    mime_type=f"audio/pcm;rate={sample_rate}",
                )
            )
            sent_at = time.perf_counter()
            self._first_audio_sent_at = self._first_audio_sent_at or sent_at
            self._last_audio_sent_at = sent_at
            if self._pacing_enabled:
                duration = len(audio) / max(sample_rate * batch_channels * 2, 1)
                await asyncio.sleep(min(max(duration, 0.0), 0.04))

        while True:
            frame = await self._audio_queue.get()
            if frame is None:
                await flush_batch()
                return
            if frame == "activity_start":
                await flush_batch()
                logger.info("Gemini Live input activity start")
                await session.send_realtime_input(activity_start=types.ActivityStart())
                self._activity_start_sent_at = time.perf_counter()
                continue
            if frame == "activity_end":
                await flush_batch()
                logger.info("Gemini Live input activity end")
                await session.send_realtime_input(activity_end=types.ActivityEnd())
                self._activity_end_sent_at = time.perf_counter()
                continue
            if frame == "audio_stream_end":
                await flush_batch()
                logger.info("Gemini Live input audio stream end")
                await session.send_realtime_input(audio_stream_end=True)
                continue
            now = time.perf_counter()
            self._input_audio_frames += 1
            self._first_input_at = self._first_input_at or now
            self._last_input_at = now
            if self._input_audio_frames == 1 or self._input_audio_frames % 100 == 0:
                logger.info(
                    "Gemini Live input audio frame #{}: {} bytes queue_depth={} pacing={} "
                    "live_batch_ms={} backlog_batch_ms={}",
                    self._input_audio_frames,
                    len(frame.audio),
                    self._audio_queue.qsize(),
                    self._pacing_enabled,
                    self._input_batch_ms,
                    self._backlog_input_batch_ms,
                )
            if self._input_batch_ms == 0:
                batch.extend(frame.audio)
                batch_sample_rate = frame.sample_rate
                batch_channels = frame.num_channels
                await flush_batch()
                continue
            if batch_sample_rate is not None and batch_sample_rate != frame.sample_rate:
                await flush_batch()
            batch.extend(frame.audio)
            batch_sample_rate = frame.sample_rate
            batch_channels = frame.num_channels
            batch_duration_ms = len(batch) / max(frame.sample_rate * frame.num_channels * 2, 1) * 1000
            target_batch_ms = self._input_batch_ms
            if (
                self._backlog_input_batch_ms > target_batch_ms
                and self._audio_queue.qsize() > 0
            ):
                target_batch_ms = self._backlog_input_batch_ms
            if batch_duration_ms >= target_batch_ms:
                await flush_batch()

    def _latency_ms(self, now: float, started_at: float | None) -> int | None:
        if started_at is None:
            return None
        return max(0, round((now - started_at) * 1000))

    def _emit_first_audio_latency(self, now: float):
        payload = {
            "turn_to_first_audio_ms": self._latency_ms(now, self._turn_started_at),
            "stop_to_first_audio_ms": self._latency_ms(now, self._last_user_stop_at),
            "activity_end_to_first_audio_ms": self._latency_ms(
                now,
                self._activity_end_sent_at,
            ),
            "first_input_to_first_audio_ms": self._latency_ms(now, self._first_input_at),
            "last_input_to_first_audio_ms": self._latency_ms(now, self._last_input_at),
            "first_audio_send_to_first_audio_ms": self._latency_ms(
                now,
                self._first_audio_sent_at,
            ),
            "last_audio_send_to_first_audio_ms": self._latency_ms(
                now,
                self._last_audio_sent_at,
            ),
            "input_frames": self._input_audio_frames,
            "dropped_output_while_user_active": self._dropped_output_while_user_active,
            "dropped_stale_output_after_user_stop": self._dropped_stale_output_after_user_stop,
        }
        logger.info("Gemini Live first audio latency: {}", payload)
        if self._on_latency_event is not None:
            _schedule_latency_background(
                self._on_latency_event(payload),
                "Gemini Live first audio latency event",
            )

    async def _run_single_tool_call(self, types, function_call):
        name = getattr(function_call, "name", None) or ""
        args = getattr(function_call, "args", None) or {}
        call_id = getattr(function_call, "id", None)
        if not name:
            return types.FunctionResponse(
                id=call_id,
                name="unknown_tool",
                response={"error": "Gemini function call did not include a name."},
            )
        if not isinstance(args, dict):
            args = {}
        result = await execute_gemini_live_tool(
            name,
            dict(args),
            self._auth,
            self._websocket,
            on_tool_start=self._on_tool_start,
            on_tool_end=self._on_tool_end,
        )
        response: dict[str, object]
        if isinstance(result, dict) and result.get("ok") is False:
            response = {"error": result}
        else:
            response = {"output": result}
        return types.FunctionResponse(
            id=call_id,
            name=name,
            response=response,
        )

    async def _send_tool_responses(self, session, types, function_calls):
        calls = list(function_calls or [])
        if not calls:
            return
        try:
            responses = await asyncio.gather(
                *(self._run_single_tool_call(types, call) for call in calls),
            )
            await session.send_tool_response(function_responses=responses)
            logger.info("Gemini Live sent {} tool response(s)", len(responses))
            await self._notify_activity(force=True)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.warning("Gemini Live tool response handling failed: {}", str(error))

    def _schedule_tool_responses(self, session, types, tool_call):
        function_calls = getattr(tool_call, "function_calls", None) or []
        task = asyncio.create_task(
            self._send_tool_responses(session, types, function_calls),
            name="gemini_live_tool_responses",
        )
        self._tool_tasks.add(task)

        def done_callback(done: asyncio.Task):
            self._tool_tasks.discard(done)
            _log_background_task_failure(done, "Gemini Live tool response")

        task.add_done_callback(done_callback)

    async def _receive_audio(self, session, types=None):
        if types is None:
            from google.genai import types as genai_types

            types = genai_types
        try:
            while not self._closed:
                async for message in session.receive():
                    tool_call = getattr(message, "tool_call", None)
                    if tool_call:
                        function_calls = getattr(tool_call, "function_calls", None) or []
                        logger.info(
                            "Gemini Live received {} tool call(s)",
                            len(function_calls),
                        )
                        await self._notify_activity(force=True)
                        self._schedule_tool_responses(session, types, tool_call)
                        continue
                    if not message.data:
                        continue
                    audio = message.data
                    now = time.perf_counter()
                    if not self._awake:
                        self._dropped_output_while_sleeping += 1
                        if (
                            self._dropped_output_while_sleeping == 1
                            or self._dropped_output_while_sleeping % 20 == 0
                        ):
                            logger.info(
                                "Gemini Live dropped output while wake gate is sleeping; "
                                "dropped_frames={}",
                                self._dropped_output_while_sleeping,
                            )
                        continue
                    if self._user_activity_open:
                        self._dropped_output_while_user_active += 1
                        if (
                            self._dropped_output_while_user_active == 1
                            or self._dropped_output_while_user_active % 50 == 0
                        ):
                            logger.info(
                                "Gemini Live dropped assistant audio while user turn is active; dropped_frames={}",
                                self._dropped_output_while_user_active,
                            )
                        continue
                    if (
                        self._last_user_stop_at is not None
                        and self._dropped_output_while_user_active > 0
                        and self._stale_output_guard_ms > 0
                        and (now - self._last_user_stop_at) * 1000 < self._stale_output_guard_ms
                    ):
                        self._dropped_stale_output_after_user_stop += 1
                        if (
                            self._dropped_stale_output_after_user_stop == 1
                            or self._dropped_stale_output_after_user_stop % 50 == 0
                        ):
                            logger.info(
                                "Gemini Live dropped stale assistant audio after barge-in stop; dropped_frames={}",
                                self._dropped_stale_output_after_user_stop,
                            )
                        continue
                    source_rate = 24000
                    if self._output_sample_rate != source_rate:
                        audio = await self._output_resampler.resample(
                            audio,
                            source_rate,
                            self._output_sample_rate,
                        )
                        if not audio:
                            continue
                    self._response_audio_frames += 1
                    if self._response_audio_frames == 1 or self._response_audio_frames % 100 == 0:
                        since_turn_ms = (
                            (now - self._turn_started_at) * 1000
                            if self._turn_started_at is not None
                            else None
                        )
                        since_first_input_ms = (
                            (now - self._first_input_at) * 1000
                            if self._first_input_at is not None
                            else None
                        )
                        since_last_input_ms = (
                            (now - self._last_input_at) * 1000
                            if self._last_input_at is not None
                            else None
                        )
                        logger.info(
                            "Gemini Live direct SDK output audio frame #{}: {} bytes at {} Hz "
                            "latency_ms turn={} first_input={} last_input={}",
                            self._response_audio_frames,
                            len(audio),
                            self._output_sample_rate,
                            round(since_turn_ms) if since_turn_ms is not None else None,
                            round(since_first_input_ms) if since_first_input_ms is not None else None,
                            round(since_last_input_ms) if since_last_input_ms is not None else None,
                        )
                    if self._response_audio_frames == 1:
                        self._first_response_at = now
                        self._emit_first_audio_latency(now)
                    await self._notify_activity()
                    await self.push_frame(
                        OutputAudioRawFrame(
                            audio=audio,
                            sample_rate=self._output_sample_rate,
                            num_channels=1,
                        ),
                        FrameDirection.DOWNSTREAM,
                    )
        except Exception as error:
            if self._closed or "1000" in str(error):
                logger.debug("Gemini Live direct SDK receive loop closed: {}", str(error))
                return
            raise

    async def _close(self):
        if self._closed:
            return
        self._closed = True
        await self._audio_queue.put(None)
        for task in list(self._tool_tasks):
            task.cancel()
        if self._tool_tasks:
            await asyncio.gather(*self._tool_tasks, return_exceptions=True)
            self._tool_tasks.clear()
        if self._session_task:
            self._session_task.cancel()
            try:
                await self._session_task
            except asyncio.CancelledError:
                pass

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, StartFrame):
            await self._ensure_session()
            await self.push_frame(frame, direction)
            return

        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, UserStartedSpeakingFrame):
            self._reset_vad_state(clear_preroll=True)
            await self._begin_user_activity(direction)
            return

        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, InputAudioRawFrame):
            if self._server_vad_enabled:
                duration_ms = self._frame_duration_ms(frame)
                peak = self._frame_peak(frame)
                if not self._user_activity_open:
                    self._remember_vad_preroll(frame, duration_ms)
                    if peak >= self._server_vad_speech_peak:
                        self._vad_speech_ms += duration_ms
                    else:
                        self._vad_speech_ms = 0.0
                    if self._vad_speech_ms >= self._server_vad_start_ms:
                        logger.info(
                            "Gemini Live server VAD started turn: speech_ms={} peak={:.3f}",
                            round(self._vad_speech_ms),
                            peak,
                        )
                        await self._begin_user_activity(direction)
                        await self._queue_vad_preroll()
                        self._vad_speech_seen = True
                    else:
                        self._dropped_input_while_user_inactive += 1
                    return

            if self._activity_mode == "manual" and not self._user_activity_open:
                self._dropped_input_while_user_inactive += 1
                if (
                    self._dropped_input_while_user_inactive == 1
                    or self._dropped_input_while_user_inactive % 100 == 0
                ):
                    logger.info(
                        "Gemini Live dropped mic audio outside active user turn; dropped_frames={}",
                        self._dropped_input_while_user_inactive,
                    )
                return
            await self._ensure_session()
            await self._audio_queue.put(frame)
            if self._user_activity_open:
                await self._notify_activity()
            if self._server_vad_enabled:
                duration_ms = self._frame_duration_ms(frame)
                peak = self._frame_peak(frame)
                if peak >= self._server_vad_speech_peak:
                    self._vad_speech_seen = True
                    self._vad_silence_ms = 0.0
                elif self._vad_speech_seen and peak <= self._server_vad_silence_peak:
                    self._vad_silence_ms += duration_ms
                    if self._vad_silence_ms >= self._server_vad_stop_ms:
                        logger.info(
                            "Gemini Live server VAD stopped turn: silence_ms={} peak={:.3f}",
                            round(self._vad_silence_ms),
                            peak,
                        )
                        await self._end_user_activity(direction)
                else:
                    self._vad_silence_ms = 0.0
            return

        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, UserStoppedSpeakingFrame):
            await self._end_user_activity(direction)
            return

        if isinstance(frame, (CancelFrame, EndFrame)):
            await self._close()

        await self.push_frame(frame, direction)


class TranscriptDebug(FrameProcessor):
    def __init__(self, websocket: WebSocket | None = None):
        super().__init__()
        self._websocket = websocket

    async def _send_transcript_event(self, *, status: str, text: str):
        if self._websocket is None:
            return
        try:
            await self._websocket.send_json({"type": "transcript", "status": status, "text": text})
        except Exception as error:
            logger.debug("Failed to send transcript event: {}", str(error))

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, TranscriptionFrame):
                if _bool_env("MITR_GATEWAY_LOG_TRANSCRIPTS", False):
                    logger.info("OpenAI STT final: {!r}", frame.text)
                await self._send_transcript_event(status="final", text=frame.text)
            elif isinstance(frame, InterimTranscriptionFrame):
                if _bool_env("MITR_GATEWAY_LOG_TRANSCRIPTS", False):
                    logger.info("OpenAI STT interim: {!r}", frame.text)
                if _bool_env("MITR_GATEWAY_SEND_INTERIM_TRANSCRIPTS", False):
                    await self._send_transcript_event(status="interim", text=frame.text)

        await self.push_frame(frame, direction)


class AgnostTranscriptCapture(FrameProcessor):
    def __init__(self, recorder: AgnostTurnRecorder):
        super().__init__()
        self._recorder = recorder

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, TranscriptionFrame):
            await self._recorder.begin_user_turn(frame.text)

        await self.push_frame(frame, direction)


class AgnostAssistantCapture(FrameProcessor):
    def __init__(self, recorder: AgnostTurnRecorder):
        super().__init__()
        self._recorder = recorder

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, (LLMTextFrame, TTSTextFrame)) and frame.text:
                self._recorder.append_assistant_text(frame.text)
            elif isinstance(frame, LLMFullResponseEndFrame):
                await self._recorder.complete_assistant_turn()

        await self.push_frame(frame, direction)


class EchoSuppressionState:
    def __init__(self, *, enabled: bool, tail_ms: int):
        self._enabled = enabled
        self._tail_sec = max(tail_ms, 0) / 1000
        self._playback_until = 0.0
        self._mute_until = 0.0
        self._output_frames = 0
        self._dropped_input_frames = 0

    @property
    def enabled(self) -> bool:
        return self._enabled

    @property
    def tail_ms(self) -> int:
        return int(self._tail_sec * 1000)

    def note_output_audio(self, frame: OutputAudioRawFrame):
        if not self._enabled:
            return

        now = time.monotonic()
        sample_rate = frame.sample_rate or 16000
        channels = max(frame.num_channels, 1)
        duration_sec = len(frame.audio) / (sample_rate * channels * 2)
        playback_start = max(self._playback_until, now)
        self._playback_until = playback_start + duration_sec
        self._mute_until = self._playback_until + self._tail_sec
        self._output_frames += 1

        if self._output_frames == 1 or self._output_frames % 100 == 0:
            logger.info(
                "Echo suppression armed from output frame #{}: duration={}ms mute_tail={}ms",
                self._output_frames,
                round(duration_sec * 1000),
                self.tail_ms,
            )

    def should_drop_input(self) -> bool:
        return self._enabled and time.monotonic() < self._mute_until

    def note_dropped_input(self):
        self._dropped_input_frames += 1
        if self._dropped_input_frames == 1 or self._dropped_input_frames % 100 == 0:
            remaining_ms = max(0, round((self._mute_until - time.monotonic()) * 1000))
            logger.info(
                "Echo suppression dropped mic/control frame #{} while assistant audio is "
                "active; remaining={}ms",
                self._dropped_input_frames,
                remaining_ms,
            )


class ToolActivityState:
    def __init__(self, *, tail_ms: int):
        self._active_count = 0
        self._tail_sec = max(tail_ms, 0) / 1000
        self._mute_until = 0.0
        self._dropped_input_frames = 0

    @property
    def tail_ms(self) -> int:
        return int(self._tail_sec * 1000)

    async def start(self, name: str, _args: dict | None = None):
        self._active_count += 1
        logger.info("Tool input suppression active: {} active_count={}", name, self._active_count)

    async def finish(
        self,
        name: str,
        _args: dict | None = None,
        _result: object | None = None,
        _success: bool | None = None,
        _latency_ms: int | None = None,
    ):
        self._active_count = max(0, self._active_count - 1)
        self._mute_until = time.monotonic() + self._tail_sec
        logger.info("Tool input suppression released: {} active_count={}", name, self._active_count)

    def should_drop_input(self) -> bool:
        return self._active_count > 0 or time.monotonic() < self._mute_until

    def note_dropped_input(self):
        self._dropped_input_frames += 1
        if self._dropped_input_frames == 1 or self._dropped_input_frames % 100 == 0:
            logger.info(
                "Tool input suppression dropped mic/control frame #{} while tool result is pending",
                self._dropped_input_frames,
            )


class EchoSuppressionInputGate(FrameProcessor):
    def __init__(self, state: EchoSuppressionState, tool_state: ToolActivityState):
        super().__init__()
        self._state = state
        self._tool_state = tool_state

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        is_input_or_turn_control = isinstance(
            frame,
            (InputAudioRawFrame, UserStartedSpeakingFrame, UserStoppedSpeakingFrame),
        )

        if (
            direction == FrameDirection.DOWNSTREAM
            and is_input_or_turn_control
            and self._tool_state.should_drop_input()
        ):
            self._tool_state.note_dropped_input()
            return

        if (
            direction == FrameDirection.DOWNSTREAM
            and is_input_or_turn_control
            and self._state.should_drop_input()
        ):
            self._state.note_dropped_input()
            return

        await self.push_frame(frame, direction)


class EchoSuppressionOutputTracker(FrameProcessor):
    def __init__(self, state: EchoSuppressionState):
        super().__init__()
        self._state = state

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, OutputAudioRawFrame):
            self._state.note_output_audio(frame)

        await self.push_frame(frame, direction)


class MitrWakePhraseOpenAIRealtimeLLMService(
    MitrRealtime2SessionOptionsMixin,
    OpenAIRealtimeLLMService,
):
    def __init__(self, *args, agnost_recorder: AgnostTurnRecorder | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        self._mitr_input_audio_frames = 0
        self._mitr_output_audio_started = False
        self._mitr_agnost_recorder = agnost_recorder

    async def _send_user_audio(self, frame: InputAudioRawFrame):
        self._mitr_input_audio_frames += 1
        if self._mitr_input_audio_frames == 1 or self._mitr_input_audio_frames % 100 == 0:
            logger.info(
                "OpenAI wake-phrase input audio frame #{}: {} bytes at {} Hz",
                self._mitr_input_audio_frames,
                len(frame.audio),
                frame.sample_rate,
            )
        await super()._send_user_audio(frame)

    async def _handle_evt_audio_delta(self, evt):
        if not self._mitr_output_audio_started:
            self._mitr_output_audio_started = True
            logger.info("OpenAI wake-phrase output audio started")
        await super()._handle_evt_audio_delta(evt)

    async def _handle_evt_audio_done(self, evt):
        self._mitr_output_audio_started = False
        logger.info("OpenAI wake-phrase output audio done")
        await super()._handle_evt_audio_done(evt)

    async def _handle_evt_audio_transcript_delta(self, evt):
        if self._mitr_agnost_recorder and evt.delta:
            self._mitr_agnost_recorder.append_assistant_text(evt.delta)
        await super()._handle_evt_audio_transcript_delta(evt)

    async def _handle_evt_text_delta(self, evt):
        if self._mitr_agnost_recorder and evt.delta:
            self._mitr_agnost_recorder.append_assistant_text(evt.delta)
        await super()._handle_evt_text_delta(evt)

    async def _handle_evt_response_done(self, evt):
        if self._mitr_agnost_recorder:
            if not self._mitr_agnost_recorder.has_pending_assistant_text:
                self._mitr_agnost_recorder.append_assistant_text(_response_output_text(evt))
            await self._mitr_agnost_recorder.complete_assistant_turn()
        await super()._handle_evt_response_done(evt)

    async def _handle_evt_speech_started(self, evt):
        logger.info("OpenAI wake-phrase turn detection: speech_started; interruption suppressed")
        await self.broadcast_frame(UserStartedSpeakingFrame)

    async def _handle_evt_speech_stopped(self, evt):
        logger.info("OpenAI wake-phrase turn detection: speech_stopped")
        await super()._handle_evt_speech_stopped(evt)


def _build_openai_realtime_llm(api_key: str, auth: DeviceAuthContext, agnost: AgnostTurnRecorder):
    turn_detection = _openai_turn_detection()
    llm = MitrWakePhraseOpenAIRealtimeLLMService(
        api_key=api_key,
        agnost_recorder=agnost,
        settings=OpenAIRealtimeLLMService.Settings(
            model=_openai_realtime_model(),
            system_instruction=_system_instruction(auth),
            session_properties=SessionProperties(
                output_modalities=["audio"],
                audio=AudioConfiguration(
                    input=AudioInput(
                        format=PCMAudioFormat(),
                        turn_detection=turn_detection,
                    ),
                    output=AudioOutput(
                        format=PCMAudioFormat(),
                        voice=os.getenv("OPENAI_REALTIME_VOICE", "marin"),
                    ),
                ),
                max_output_tokens=_openai_realtime_max_output_tokens(),
                tools=build_tools_schema(),
                tool_choice="auto",
            ),
        ),
    )
    return llm, turn_detection


def _build_openai_streaming_llm(api_key: str, auth: DeviceAuthContext) -> OpenAILLMService:
    settings_kwargs = {
        "model": _openai_llm_model(),
        "system_instruction": _system_instruction(auth),
        "max_tokens": _openai_llm_max_tokens(),
    }
    temperature = _optional_float_env("OPENAI_LLM_TEMPERATURE")
    if temperature is not None:
        settings_kwargs["temperature"] = temperature
    top_p = _optional_float_env("OPENAI_LLM_TOP_P")
    if top_p is not None:
        settings_kwargs["top_p"] = top_p
    return OpenAILLMService(
        api_key=api_key,
        settings=OpenAILLMService.Settings(**settings_kwargs),
    )


def _build_elevenlabs_tts(auth: DeviceAuthContext, *, sample_rate: int) -> ElevenLabsTTSService:
    text_aggregation_mode = _elevenlabs_text_aggregation_mode()
    return ElevenLabsTTSService(
        api_key=os.getenv("ELEVENLABS_API_KEY", ""),
        sample_rate=sample_rate,
        auto_mode=_elevenlabs_auto_mode(text_aggregation_mode),
        enable_logging=_bool_env("ELEVENLABS_ENABLE_LOGGING", False),
        text_aggregation_mode=text_aggregation_mode,
        settings=ElevenLabsTTSService.Settings(
            model=os.getenv("ELEVENLABS_TTS_MODEL", "eleven_turbo_v2_5"),
            voice=_elevenlabs_voice_id(),
            language=_elevenlabs_language(auth),
            stability=_optional_float_env("ELEVENLABS_STABILITY"),
            similarity_boost=_optional_float_env("ELEVENLABS_SIMILARITY_BOOST"),
            style=_optional_float_env("ELEVENLABS_STYLE"),
            use_speaker_boost=None
            if os.getenv("ELEVENLABS_USE_SPEAKER_BOOST") is None
            else _bool_env("ELEVENLABS_USE_SPEAKER_BOOST", False),
            speed=_optional_float_env("ELEVENLABS_SPEED"),
            apply_text_normalization=os.getenv("ELEVENLABS_APPLY_TEXT_NORMALIZATION") or None,
        ),
    )


class MitrWakePhraseGeminiLiveLLMService(GeminiLiveLLMService):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._mitr_input_audio_frames = 0

    async def _send_user_audio(self, frame: InputAudioRawFrame):
        self._mitr_input_audio_frames += 1
        if self._mitr_input_audio_frames == 1 or self._mitr_input_audio_frames % 100 == 0:
            logger.info(
                "Gemini Live wake-phrase input audio frame #{}: {} bytes at {} Hz",
                self._mitr_input_audio_frames,
                len(frame.audio),
                frame.sample_rate,
            )
        await super()._send_user_audio(frame)


async def _run_openai_realtime_bot(websocket: WebSocket, auth: DeviceAuthContext) -> None:
    packet_ms = _int_env("ESP32_AUDIO_PACKET_MS", 20)
    out_rate = _int_env("ESP32_AUDIO_OUT_SAMPLE_RATE", 16000)
    packet_bytes = int(out_rate * packet_ms / 1000) * 2

    async def send_state(state: str, **payload):
        try:
            await websocket.send_json({"type": state, "deviceId": auth.device_id, **payload})
        except Exception as error:
            logger.debug("Failed to send gateway state {}: {}", state, str(error))

    reported_gateway_errors: set[tuple[str, str]] = set()

    async def send_gateway_error(source: str, message: str, *, fatal: bool = False):
        message = _user_safe_gateway_error(source, message)
        key = (source, message)
        if key in reported_gateway_errors:
            return
        try:
            await websocket.send_json(
                {
                    "type": "gateway_error",
                    "source": source,
                    "message": message,
                    "fatal": fatal,
                    "deviceId": auth.device_id,
                }
            )
            reported_gateway_errors.add(key)
        except Exception as error:
            logger.debug("Failed to send gateway error {}: {}", source, str(error))

    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=_int_env("ESP32_AUDIO_IN_SAMPLE_RATE", 16000),
            audio_out_sample_rate=out_rate,
            audio_out_channels=1,
            add_wav_header=False,
            serializer=Esp32PCMSerializer(),
            fixed_audio_packet_size=packet_bytes,
            session_timeout=_optional_timeout_env("MITR_GATEWAY_SESSION_TIMEOUT_SEC"),
        ),
    )

    api_key = os.getenv("OPENAI_API_KEY", "")
    stt_language = os.getenv("OPENAI_REALTIME_STT_LANGUAGE") or auth.language or "en"
    stt = WakeOnlyOpenAIRealtimeSTTService(
        api_key=api_key,
        turn_detection=None,
        should_interrupt=False,
        settings=OpenAIRealtimeSTTService.Settings(
            model=_openai_realtime_stt_model(gemini_live=False),
            language=_language(stt_language),
        ),
    )

    @stt.event_handler("on_error")
    async def on_stt_error(_stt, error):
        await send_gateway_error(
            "openai_realtime_stt",
            error.error,
            fatal=error.fatal,
        )

    agnost = AgnostTurnRecorder(auth=auth, config=AgnostConfig.from_env())
    pipeline_mode = _gateway_pipeline_mode()
    elevenlabs_tts = None
    agnost_assistant_capture = None
    turn_detection = False
    if pipeline_mode == _PIPELINE_OPENAI_REALTIME:
        llm, turn_detection = _build_openai_realtime_llm(api_key, auth, agnost)
    else:
        llm = _build_openai_streaming_llm(api_key, auth)
        elevenlabs_tts = _build_elevenlabs_tts(auth, sample_rate=out_rate)
        agnost_assistant_capture = AgnostAssistantCapture(agnost)
    tool_activity = ToolActivityState(
        tail_ms=_int_env("MITR_GATEWAY_TOOL_INPUT_SUPPRESSION_TAIL_MS", 500),
    )

    async def record_agnost_tool_end(
        name: str,
        args: dict,
        result: object,
        success: bool,
        latency_ms: int,
    ) -> None:
        await tool_activity.finish(name, args, result, success, latency_ms)
        agnost.record_tool_event(
            name=name,
            args=args,
            result=result,
            success=success,
            latency_ms=latency_ms,
        )

    register_mitr_tools(
        llm,
        auth,
        websocket,
        on_tool_start=tool_activity.start,
        on_tool_end=record_agnost_tool_end,
    )

    wake_phrase = UnicodeWakePhraseUserTurnStartStrategy(
        phrases=_wake_phrases(),
        timeout=_wake_idle_timeout(),
        enable_interruptions=False,
        enable_user_speaking_frames=False,
        include_interim_transcripts=_wake_use_interim_transcripts(),
    )
    gate = WakePhraseRealtimeGate(
        preroll_sec=_float_env("MITR_GATEWAY_WAKE_PHRASE_PREROLL_SEC", 4.0),
        forward_audio_when_awake=pipeline_mode == _PIPELINE_OPENAI_REALTIME,
    )
    transcript_debug = TranscriptDebug(websocket)
    agnost_transcripts = AgnostTranscriptCapture(agnost)
    llm_resampler = PCM16Resampler(target_sample_rate=OPENAI_REALTIME_SAMPLE_RATE)
    echo_suppression = EchoSuppressionState(
        enabled=_bool_env("MITR_GATEWAY_ECHO_SUPPRESSION", True),
        tail_ms=_echo_suppression_tail_ms(gemini_live=False),
    )
    echo_input_gate = EchoSuppressionInputGate(echo_suppression, tool_activity)
    echo_output_tracker = EchoSuppressionOutputTracker(echo_suppression)

    @wake_phrase.event_handler("on_wake_phrase_detected")
    async def on_wake_phrase_detected(_strategy, phrase: str):
        await stt.set_wake_listening(False)
        await send_state("awake", wakePhrase=phrase, idleTimeoutSec=_wake_idle_timeout())
        asyncio.create_task(
            _queue_runtime_context_update(
                task,
                llm,
                auth,
                websocket=websocket,
                trigger_type="user_requested",
            )
        )
        await gate.wake(phrase)

    @wake_phrase.event_handler("on_wake_phrase_timeout")
    async def on_wake_phrase_timeout(_strategy):
        await gate.sleep()
        await stt.set_wake_listening(True)
        await send_state("sleeping", reason="idle_timeout")

    if pipeline_mode == _PIPELINE_OPENAI_REALTIME:
        context = LLMContext([])
    else:
        context = LLMContext([], tools=build_tools_schema(), tool_choice="auto")
    context_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            user_turn_strategies=UserTurnStrategies(
                start=[
                    wake_phrase,
                    *_post_wake_turn_start_strategies(),
                ],
                stop=[ExternalUserTurnStopStrategy()],
            ),
        ),
        assistant_params=_context_summarization_assistant_params(api_key),
    )
    _register_context_summarization_logging(context_aggregator)

    logger.info(
        "Pipecat wake phrase mode enabled; pipeline={} phrases={}",
        pipeline_mode,
        _wake_phrases(),
    )
    if pipeline_mode == _PIPELINE_OPENAI_REALTIME:
        logger.info(
            "OpenAI Realtime turn detection enabled: {}",
            _describe_turn_detection(turn_detection),
        )
    else:
        logger.info(
            "OpenAI STT + streaming LLM + ElevenLabs TTS enabled: llm_model={} "
            "tts_model={} tts_language={} aggregation={}",
            _openai_llm_model(),
            elevenlabs_tts._settings.model,
            elevenlabs_tts._settings.language,
            _elevenlabs_text_aggregation_mode().value,
        )
    logger.info(
        "Gateway echo suppression: enabled={} tail_ms={}",
        echo_suppression.enabled,
        echo_suppression.tail_ms,
    )
    logger.info(
        "Gateway wake latency: interim_transcripts={} preroll_sec={}",
        _wake_use_interim_transcripts(),
        _float_env("MITR_GATEWAY_WAKE_PHRASE_PREROLL_SEC", 4.0),
    )
    logger.info("Gateway tool input suppression: tail_ms={}", tool_activity.tail_ms)

    processors = [
        transport.input(),
        echo_input_gate,
        stt,
        transcript_debug,
        agnost_transcripts,
        context_aggregator.user(),
    ]
    if pipeline_mode == _PIPELINE_OPENAI_REALTIME:
        processors.extend(
            [
                llm_resampler,
                gate,
                llm,
                context_aggregator.assistant(),
                echo_output_tracker,
                transport.output(),
            ]
        )
    else:
        processors.extend(
            [
                gate,
                llm,
                agnost_assistant_capture,
                context_aggregator.assistant(),
                elevenlabs_tts,
                echo_output_tracker,
                transport.output(),
            ]
        )

    pipeline = Pipeline(processors)

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=_int_env("ESP32_AUDIO_IN_SAMPLE_RATE", 16000),
            audio_out_sample_rate=out_rate,
            enable_metrics=True,
            enable_usage_metrics=True,
            cancel_on_idle_timeout=False,
            idle_timeout_secs=None,
        ),
    )

    @transport.event_handler("on_client_connected")
    async def on_client_connected(_transport, _client):
        logger.info("ESP32 connected to Pipecat wake phrase gateway", device_id=auth.device_id)
        await agnost.start_session()
        asyncio.create_task(
            _queue_runtime_context_update(
                task,
                llm,
                auth,
                websocket=websocket,
                trigger_type="session_start",
            )
        )
        await send_state("listening", wakePhrases=_wake_phrases())

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(_transport, _client):
        logger.info("ESP32 disconnected from Pipecat wake phrase gateway", device_id=auth.device_id)
        await agnost.close()
        await task.cancel()

    @transport.event_handler("on_session_timeout")
    async def on_session_timeout(_transport, _client):
        logger.info("ESP32 Pipecat wake phrase session timed out", device_id=auth.device_id)
        await agnost.close()
        await task.cancel()

    runner = PipelineRunner(handle_sigint=False)
    try:
        await runner.run(task)
    finally:
        await agnost.close()


async def _run_gemini_live_bot(websocket: WebSocket, auth: DeviceAuthContext) -> None:
    packet_ms = _int_env("ESP32_AUDIO_PACKET_MS", 20)
    out_rate = _int_env("ESP32_AUDIO_OUT_SAMPLE_RATE", 24000)
    packet_bytes = int(out_rate * packet_ms / 1000) * 2

    async def send_state(state: str, **payload):
        try:
            await websocket.send_json({"type": state, "deviceId": auth.device_id, **payload})
        except Exception as error:
            logger.debug("Failed to send gateway state {}: {}", state, str(error))

    reported_gateway_errors: set[tuple[str, str]] = set()

    async def send_gateway_error(source: str, message: str, *, fatal: bool = False):
        message = _user_safe_gateway_error(source, message)
        key = (source, message)
        if key in reported_gateway_errors:
            return
        try:
            await websocket.send_json(
                {
                    "type": "gateway_error",
                    "source": source,
                    "message": message,
                    "fatal": fatal,
                    "deviceId": auth.device_id,
                }
            )
            reported_gateway_errors.add(key)
        except Exception as error:
            logger.debug("Failed to send gateway error {}: {}", source, str(error))

    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=_int_env("ESP32_AUDIO_IN_SAMPLE_RATE", 16000),
            audio_out_sample_rate=out_rate,
            audio_out_channels=1,
            add_wav_header=False,
            serializer=Esp32PCMSerializer(),
            fixed_audio_packet_size=packet_bytes,
            session_timeout=_optional_timeout_env("MITR_GATEWAY_SESSION_TIMEOUT_SEC"),
        ),
    )

    openai_api_key = os.getenv("OPENAI_API_KEY", "")
    stt_language = os.getenv("OPENAI_REALTIME_STT_LANGUAGE") or auth.language or "en"
    stt = WakeOnlyOpenAIRealtimeSTTService(
        api_key=openai_api_key,
        turn_detection=None,
        should_interrupt=False,
        settings=OpenAIRealtimeSTTService.Settings(
            model=_openai_realtime_stt_model(gemini_live=True),
            language=_language(stt_language),
        ),
    )

    @stt.event_handler("on_error")
    async def on_gemini_stt_error(_stt, error):
        await send_gateway_error(
            "openai_realtime_stt",
            error.error,
            fatal=error.fatal,
        )

    async def notify_gemini_latency(payload: dict):
        await send_state("gemini_latency", **payload)

    agnost = AgnostTurnRecorder(auth=auth, config=AgnostConfig.from_env())
    gemini_direct = _gemini_live_service_mode() != "pipecat"
    tool_activity = ToolActivityState(
        tail_ms=_int_env("MITR_GATEWAY_TOOL_INPUT_SUPPRESSION_TAIL_MS", 500),
    )

    async def record_agnost_tool_end(
        name: str,
        args: dict,
        result: object,
        success: bool,
        latency_ms: int,
    ) -> None:
        await tool_activity.finish(name, args, result, success, latency_ms)
        agnost.record_tool_event(
            name=name,
            args=args,
            result=result,
            success=success,
            latency_ms=latency_ms,
        )

    async def refresh_gemini_wake_idle_timeout():
        await wake_phrase.reset()

    gemini_wake_idle_timeout = (
        _gemini_live_wake_idle_timeout() if gemini_direct else _wake_idle_timeout()
    )

    if gemini_direct:
        llm = DirectGeminiLiveAudioService(
            auth=auth,
            output_sample_rate=out_rate,
            on_latency_event=notify_gemini_latency,
            websocket=websocket,
            on_tool_start=tool_activity.start,
            on_tool_end=record_agnost_tool_end,
            on_activity=refresh_gemini_wake_idle_timeout,
        )
    else:
        llm = MitrWakePhraseGeminiLiveLLMService(
            api_key=os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY", ""),
            tools=build_tools_schema(),
            inference_on_context_initialization=False,
            settings=GeminiLiveLLMService.Settings(
                model=_gemini_live_model(),
                system_instruction=_gemini_live_system_instruction(auth),
                voice=_gemini_live_voice(),
                modalities=GeminiModalities.AUDIO,
                language=_gemini_live_language(auth),
                vad=GeminiVADParams(disabled=True),
            ),
        )
    early_gemini_preconnect_task = await _start_gemini_live_preconnect_early(
        llm,
        gemini_direct=gemini_direct,
    )

    if not gemini_direct:
        register_mitr_tools(
            llm,
            auth,
            websocket,
            on_tool_start=tool_activity.start,
            on_tool_end=record_agnost_tool_end,
        )

    wake_phrase = UnicodeWakePhraseUserTurnStartStrategy(
        phrases=_wake_phrases(),
        timeout=gemini_wake_idle_timeout,
        enable_interruptions=False,
        enable_user_speaking_frames=False,
        include_interim_transcripts=_wake_use_interim_transcripts(),
    )
    gate = WakePhraseRealtimeGate(
        preroll_sec=_gemini_live_transcript_wake_preroll_sec(),
        preroll_flush_batch_ms=_gemini_live_preroll_flush_batch_ms() if gemini_direct else 0,
    )
    transcript_debug = TranscriptDebug(websocket)
    agnost_transcripts = AgnostTranscriptCapture(agnost)
    agnost_assistant = AgnostAssistantCapture(agnost) if not gemini_direct else None
    llm_resampler = (
        None
        if gemini_direct
        else PCM16Resampler(target_sample_rate=OPENAI_REALTIME_SAMPLE_RATE)
    )
    echo_suppression = EchoSuppressionState(
        enabled=_bool_env("MITR_GATEWAY_ECHO_SUPPRESSION", True),
        tail_ms=_echo_suppression_tail_ms(gemini_live=True),
    )
    echo_input_gate = EchoSuppressionInputGate(echo_suppression, tool_activity)
    echo_output_tracker = EchoSuppressionOutputTracker(echo_suppression)

    async def notify_awake(phrase: str):
        await send_state("awake", wakePhrase=phrase, idleTimeoutSec=gemini_wake_idle_timeout)

    @wake_phrase.event_handler("on_wake_phrase_detected")
    async def on_wake_phrase_detected(_strategy, phrase: str):
        if gemini_direct:
            await llm.set_awake(True)
            await _open_transcript_wake_fast(
                stt=stt,
                gate=gate,
                notify_awake=notify_awake,
                phrase=phrase,
            )
            return
        await stt.set_wake_listening(False)
        await notify_awake(phrase)
        await gate.wake(phrase)

    @wake_phrase.event_handler("on_wake_phrase_timeout")
    async def on_wake_phrase_timeout(_strategy):
        if gemini_direct:
            await llm.set_awake(False)
        await gate.sleep()
        await stt.set_wake_listening(True)
        await send_state("sleeping", reason="idle_timeout")

    wake_detector = WakePhraseDetector(wake_phrase) if gemini_direct else None
    context_aggregator = None
    if not gemini_direct:
        context = LLMContext([])
        context_aggregator = LLMContextAggregatorPair(
            context,
            user_params=LLMUserAggregatorParams(
                user_turn_strategies=UserTurnStrategies(
                    start=[
                        wake_phrase,
                        *_post_wake_turn_start_strategies(),
                    ],
                    stop=[ExternalUserTurnStopStrategy()],
                ),
            ),
            assistant_params=_context_summarization_assistant_params(openai_api_key),
        )
        _register_context_summarization_logging(context_aggregator)

    logger.info(
        "Pipecat Gemini Live wake phrase mode enabled; service={} model={} voice={} language={} phrases={}",
        _gemini_live_service_mode(),
        _gemini_live_model(),
        _gemini_live_voice(),
        _gemini_live_language(auth),
        _wake_phrases(),
    )
    logger.info(
        "Gemini Live uses OpenAIRealtimeSTTService for wake phrase transcription; "
        "model={} language={}; runtime context update injection is not enabled for this experiment.",
        _openai_realtime_stt_model(gemini_live=True),
        stt_language,
    )
    logger.info(
        "Gateway echo suppression: enabled={} tail_ms={}",
        echo_suppression.enabled,
        echo_suppression.tail_ms,
    )
    logger.info(
        "Gateway wake latency: interim_transcripts={} preroll_sec={} preroll_flush_batch_ms={}",
        _wake_use_interim_transcripts(),
        _gemini_live_transcript_wake_preroll_sec(),
        _gemini_live_preroll_flush_batch_ms() if gemini_direct else 0,
    )
    logger.info("Gateway wake idle timeout: {}s", gemini_wake_idle_timeout)
    logger.info(
        "Gemini Live server VAD: enabled={} start_ms={} stop_ms={} preroll_ms={} "
        "speech_peak={} silence_peak={}",
        _gemini_live_server_vad_enabled() if gemini_direct else False,
        _gemini_live_server_vad_start_ms(),
        _gemini_live_server_vad_stop_ms(),
        _gemini_live_server_vad_preroll_ms(),
        _gemini_live_server_vad_speech_peak(),
        _gemini_live_server_vad_silence_peak(),
    )
    logger.info("Gateway tool input suppression: tail_ms={}", tool_activity.tail_ms)
    if wake_detector is not None:
        logger.info("Gateway transcript wake processor: lightweight_detector")

    pipeline_steps = [
        transport.input(),
        echo_input_gate,
        stt,
        transcript_debug,
        agnost_transcripts,
        wake_detector or context_aggregator.user(),
        llm_resampler,
        gate,
        llm,
        agnost_assistant,
        *([context_aggregator.assistant()] if context_aggregator is not None else []),
        echo_output_tracker,
        transport.output(),
    ]
    pipeline = Pipeline([step for step in pipeline_steps if step is not None])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=_int_env("ESP32_AUDIO_IN_SAMPLE_RATE", 16000),
            audio_out_sample_rate=out_rate,
            enable_metrics=True,
            enable_usage_metrics=True,
            cancel_on_idle_timeout=False,
            idle_timeout_secs=None,
        ),
    )

    @transport.event_handler("on_client_connected")
    async def on_client_connected(_transport, _client):
        logger.info("ESP32 connected to Pipecat Gemini Live gateway", device_id=auth.device_id)
        await agnost.start_session()
        if early_gemini_preconnect_task is not None:
            logger.info("Gemini Live session preconnect already started before client event")
        await send_state(
            "listening",
            wakePhrases=_wake_phrases(),
            realtimeProvider="gemini_live",
            model=_gemini_live_model(),
            wakeMode="transcript",
            serverVad={
                "enabled": _gemini_live_server_vad_enabled() if gemini_direct else False,
                "startMs": _gemini_live_server_vad_start_ms(),
                "stopMs": _gemini_live_server_vad_stop_ms(),
                "prerollMs": _gemini_live_server_vad_preroll_ms(),
            },
        )

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(_transport, _client):
        logger.info(
            "ESP32 disconnected from Pipecat Gemini Live gateway",
            device_id=auth.device_id,
        )
        await agnost.close()
        await task.cancel()

    @transport.event_handler("on_session_timeout")
    async def on_session_timeout(_transport, _client):
        logger.info("ESP32 Pipecat Gemini Live session timed out", device_id=auth.device_id)
        await agnost.close()
        await task.cancel()

    runner = PipelineRunner(handle_sigint=False)
    try:
        await runner.run(task)
    finally:
        await agnost.close()


async def run_bot(websocket: WebSocket, auth: DeviceAuthContext) -> None:
    if _realtime_provider() == "gemini_live":
        await _run_gemini_live_bot(websocket, auth)
        return

    await _run_openai_realtime_bot(websocket, auth)
