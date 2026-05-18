import asyncio
import os
import re
import time
import unicodedata
from collections import deque

from fastapi import WebSocket
from loguru import logger

from pipecat.frames.frames import (
    Frame,
    InputAudioRawFrame,
    InterimTranscriptionFrame,
    LLMContextFrame,
    LLMRunFrame,
    OutputAudioRawFrame,
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
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from .auth import DeviceAuthContext
from .bot import (
    OPENAI_REALTIME_SAMPLE_RATE,
    MitrRealtime2SessionOptionsMixin,
    PCM16Resampler,
    _int_env,
    _openai_realtime_max_output_tokens,
    _openai_realtime_model,
    _optional_timeout_env,
    _queue_runtime_context_update,
    _system_instruction,
)
from .serializer import Esp32PCMSerializer
from .tools import build_tools_schema, register_mitr_tools


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


def _post_wake_turn_start_strategies():
    return [
        VADUserTurnStartStrategy(enable_interruptions=False),
        TranscriptionUserTurnStartStrategy(enable_interruptions=False),
    ]


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
        {"हाय मित्र", "हे मित्र", "हाय मित्रा", "हे मित्रा"},
    )

    return sorted((phrase for phrase in aliases if phrase.strip()), key=len, reverse=True)


def _leading_wake_phrase_pattern(phrase: str) -> re.Pattern:
    normalized = _strip_wake_phrase_punctuation(phrase).strip()
    body = r"\s*".join(re.escape(word) for word in normalized.split())
    return re.compile(r"^\s*" + body + r"(?:[\s,.:;!?।-]+|$)", re.IGNORECASE)


def _strip_leading_wake_phrase(text: str) -> tuple[str, bool]:
    for phrase in _wake_phrase_aliases():
        match = _leading_wake_phrase_pattern(phrase).match(text)
        if match:
            return text[match.end() :].strip(" \t\r\n,.:;!?।-"), True
    return text, False


class UnicodeWakePhraseUserTurnStartStrategy(WakePhraseUserTurnStartStrategy):
    def __init__(self, *, phrases: list[str], **kwargs):
        super().__init__(phrases=phrases, **kwargs)
        self._patterns = [_wake_phrase_pattern(phrase) for phrase in _wake_phrase_aliases(phrases)]

    @staticmethod
    def _strip_punctuation(text: str) -> str:
        return _strip_wake_phrase_punctuation(text)


class WakePhraseRealtimeGate(FrameProcessor):
    def __init__(self, *, preroll_sec: float):
        super().__init__()
        self._awake = False
        self._pending_stop = False
        self._buffer: deque[InputAudioRawFrame] = deque()
        self._buffer_bytes = 0
        self._max_buffer_bytes = int(OPENAI_REALTIME_SAMPLE_RATE * max(preroll_sec, 0.5) * 2)
        self._dropped_llm_frames = 0
        self._dropped_audio_frames = 0

    async def wake(self, phrase: str):
        if self._awake:
            return

        self._awake = True
        logger.info(
            "Pipecat wake phrase detected: {!r}; discarding {} buffered audio frames",
            phrase,
            len(self._buffer),
        )

        await self.push_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
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
        self._dropped_audio_frames = 0

    def _buffer_audio(self, frame: InputAudioRawFrame):
        self._buffer.append(frame)
        self._buffer_bytes += len(frame.audio)
        while self._buffer and self._buffer_bytes > self._max_buffer_bytes:
            dropped = self._buffer.popleft()
            self._buffer_bytes -= len(dropped.audio)

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if direction != FrameDirection.DOWNSTREAM:
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, InputAudioRawFrame) and not self._awake:
            self._buffer_audio(frame)
            return

        if isinstance(frame, InputAudioRawFrame):
            self._dropped_audio_frames += 1
            if self._dropped_audio_frames == 1 or self._dropped_audio_frames % 100 == 0:
                logger.info(
                    "Wake gate dropped raw audio while awake; STT transcript owns LLM input; dropped_audio_frames={}",
                    self._dropped_audio_frames,
                )
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


class TranscriptDebug(FrameProcessor):
    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if direction == FrameDirection.DOWNSTREAM and _bool_env("MITR_GATEWAY_LOG_TRANSCRIPTS", False):
            if isinstance(frame, TranscriptionFrame):
                logger.info("OpenAI STT final: {!r}", frame.text)
            elif isinstance(frame, InterimTranscriptionFrame):
                logger.info("OpenAI STT interim: {!r}", frame.text)

        await self.push_frame(frame, direction)


class WakePhrasePromptFilter(FrameProcessor):
    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if direction != FrameDirection.DOWNSTREAM or not isinstance(frame, LLMContextFrame):
            await self.push_frame(frame, direction)
            return

        messages = list(frame.context.get_messages())
        for index in range(len(messages) - 1, -1, -1):
            message = messages[index]
            if not isinstance(message, dict) or message.get("role") != "user":
                continue

            content = message.get("content")
            if not isinstance(content, str):
                break

            stripped, changed = _strip_leading_wake_phrase(content)
            if not changed:
                break

            if stripped:
                messages[index] = {**message, "content": stripped}
                frame.context.set_messages(messages)
                logger.info(
                    "Wake phrase stripped from LLM user message; chars_before={} chars_after={}",
                    len(content),
                    len(stripped),
                )
                await self.push_frame(frame, direction)
                return

            del messages[index]
            frame.context.set_messages(messages)
            logger.info("Wake-only transcript suppressed; waiting for user request")
            return

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
                "Echo suppression dropped mic frame #{} while assistant audio is active; remaining={}ms",
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

    async def start(self, name: str):
        self._active_count += 1
        logger.info("Tool input suppression active: {} active_count={}", name, self._active_count)

    async def finish(self, name: str):
        self._active_count = max(0, self._active_count - 1)
        self._mute_until = time.monotonic() + self._tail_sec
        logger.info("Tool input suppression released: {} active_count={}", name, self._active_count)

    def should_drop_input(self) -> bool:
        return self._active_count > 0 or time.monotonic() < self._mute_until

    def note_dropped_input(self):
        self._dropped_input_frames += 1
        if self._dropped_input_frames == 1 or self._dropped_input_frames % 100 == 0:
            logger.info(
                "Tool input suppression dropped mic frame #{} while tool result is pending",
                self._dropped_input_frames,
            )


class EchoSuppressionInputGate(FrameProcessor):
    def __init__(self, state: EchoSuppressionState, tool_state: ToolActivityState):
        super().__init__()
        self._state = state
        self._tool_state = tool_state

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if (
            direction == FrameDirection.DOWNSTREAM
            and isinstance(frame, InputAudioRawFrame)
            and self._tool_state.should_drop_input()
        ):
            self._tool_state.note_dropped_input()
            return

        if (
            direction == FrameDirection.DOWNSTREAM
            and isinstance(frame, InputAudioRawFrame)
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
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._mitr_input_audio_frames = 0
        self._mitr_output_audio_started = False

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

    async def _handle_user_stopped_speaking(self, frame):
        logger.debug(
            "Ignoring UserStoppedSpeakingFrame in wake mode; STT transcript context owns response creation"
        )

    async def _handle_evt_speech_started(self, evt):
        logger.info("OpenAI wake-phrase turn detection: speech_started; interruption suppressed")
        await self.broadcast_frame(UserStartedSpeakingFrame)

    async def _handle_evt_speech_stopped(self, evt):
        logger.info("OpenAI wake-phrase turn detection: speech_stopped")
        await super()._handle_evt_speech_stopped(evt)


async def run_bot(websocket: WebSocket, auth: DeviceAuthContext) -> None:
    packet_ms = _int_env("ESP32_AUDIO_PACKET_MS", 20)
    out_rate = _int_env("ESP32_AUDIO_OUT_SAMPLE_RATE", 16000)
    packet_bytes = int(out_rate * packet_ms / 1000) * 2

    async def send_state(state: str, **payload):
        try:
            await websocket.send_json({"type": state, "deviceId": auth.device_id, **payload})
        except Exception as error:
            logger.debug("Failed to send gateway state {}: {}", state, str(error))

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
    stt_language = os.getenv("OPENAI_REALTIME_STT_LANGUAGE", "en")
    stt = OpenAIRealtimeSTTService(
        api_key=api_key,
        turn_detection=None,
        should_interrupt=False,
        settings=OpenAIRealtimeSTTService.Settings(
            model=os.getenv("OPENAI_REALTIME_STT_MODEL", "gpt-4o-transcribe"),
            language=_language(stt_language),
        ),
    )

    turn_detection = _openai_turn_detection()
    llm = MitrWakePhraseOpenAIRealtimeLLMService(
        api_key=api_key,
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
                        voice=os.getenv("OPENAI_REALTIME_VOICE", "alloy"),
                    ),
                ),
                max_output_tokens=_openai_realtime_max_output_tokens(),
                tools=build_tools_schema(),
                tool_choice="auto",
            ),
        ),
    )
    tool_activity = ToolActivityState(
        tail_ms=_int_env("MITR_GATEWAY_TOOL_INPUT_SUPPRESSION_TAIL_MS", 500),
    )
    register_mitr_tools(
        llm,
        auth,
        websocket,
        on_tool_start=tool_activity.start,
        on_tool_end=tool_activity.finish,
    )

    wake_phrase = UnicodeWakePhraseUserTurnStartStrategy(
        phrases=_wake_phrases(),
        timeout=_wake_idle_timeout(),
        enable_interruptions=False,
        enable_user_speaking_frames=False,
    )
    gate = WakePhraseRealtimeGate(
        preroll_sec=_float_env("MITR_GATEWAY_WAKE_PHRASE_PREROLL_SEC", 4.0),
    )
    transcript_debug = TranscriptDebug()
    wake_prompt_filter = WakePhrasePromptFilter()
    llm_resampler = PCM16Resampler(target_sample_rate=OPENAI_REALTIME_SAMPLE_RATE)
    echo_suppression = EchoSuppressionState(
        enabled=_bool_env("MITR_GATEWAY_ECHO_SUPPRESSION", True),
        tail_ms=_int_env("MITR_GATEWAY_ECHO_SUPPRESSION_TAIL_MS", 900),
    )
    echo_input_gate = EchoSuppressionInputGate(echo_suppression, tool_activity)
    echo_output_tracker = EchoSuppressionOutputTracker(echo_suppression)

    @wake_phrase.event_handler("on_wake_phrase_detected")
    async def on_wake_phrase_detected(_strategy, phrase: str):
        await send_state("awake", wakePhrase=phrase, idleTimeoutSec=_wake_idle_timeout())
        await gate.wake(phrase)

    @wake_phrase.event_handler("on_wake_phrase_timeout")
    async def on_wake_phrase_timeout(_strategy):
        await gate.sleep()
        await send_state("sleeping", reason="idle_timeout")

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
    )

    logger.info("Pipecat wake phrase mode enabled; phrases={}", _wake_phrases())
    logger.info("OpenAI Realtime turn detection enabled: {}", _describe_turn_detection(turn_detection))
    logger.info(
        "Gateway echo suppression: enabled={} tail_ms={}",
        echo_suppression.enabled,
        echo_suppression.tail_ms,
    )
    logger.info("Gateway tool input suppression: tail_ms={}", tool_activity.tail_ms)

    pipeline = Pipeline(
        [
            transport.input(),
            echo_input_gate,
            stt,
            transcript_debug,
            context_aggregator.user(),
            wake_prompt_filter,
            llm_resampler,
            gate,
            llm,
            context_aggregator.assistant(),
            echo_output_tracker,
            transport.output(),
        ]
    )

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
        asyncio.create_task(_queue_runtime_context_update(task, llm, auth))
        await send_state("listening", wakePhrases=_wake_phrases())

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(_transport, _client):
        logger.info("ESP32 disconnected from Pipecat wake phrase gateway", device_id=auth.device_id)
        await task.cancel()

    @transport.event_handler("on_session_timeout")
    async def on_session_timeout(_transport, _client):
        logger.info("ESP32 Pipecat wake phrase session timed out", device_id=auth.device_id)
        await task.cancel()

    runner = PipelineRunner(handle_sigint=False)
    await runner.run(task)
