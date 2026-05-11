import os

from fastapi import WebSocket
from loguru import logger

from pipecat.audio.utils import create_stream_resampler
from pipecat.frames.frames import Frame, InputAudioRawFrame
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
)
from pipecat.services.openai.realtime.llm import OpenAIRealtimeLLMService
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)
from pipecat.turns.user_turn_strategies import ExternalUserTurnStrategies

from .auth import DeviceAuthContext
from .serializer import Esp32PCMSerializer
from .tools import build_tools_schema, register_mitr_tools

OPENAI_REALTIME_SAMPLE_RATE = 24000


def _int_env(name: str, fallback: int) -> int:
    try:
        return int(os.getenv(name, str(fallback)))
    except ValueError:
        return fallback


def _optional_timeout_env(name: str) -> int | None:
    try:
        value = int(os.getenv(name, "0"))
    except ValueError:
        return None
    return value if value > 0 else None


def _system_instruction(auth: DeviceAuthContext) -> str:
    return f"""
You are Mitr, a deeply respectful AI voice companion for Indian adults aged 55+.

Primary mission:
- Help the user feel heard, emotionally supported, and practically assisted.
- Build trust through dignity, warmth, continuity, and clear communication.
- Support wellness only. Never diagnose medical or psychiatric conditions.

Language and delivery:
- Speak in the user's preferred language. Default: {auth.language}.
- Spoken output only: no markdown, no bullet symbols, no raw URLs.
- Keep responses natural and voice-friendly, usually 1-4 short sentences.
- Use pauses naturally with punctuation. Do not rush.
- Never speak over user speech or media playback.
- Do not mention that you are a gateway or test.
- Sound natural, not scripted. Do not force fillers, stutters, or verbal tics.
- Do not use placeholder backchannels like "hmm", "hmh", or similar unless they arise naturally and clearly improve the response.
- If audio is unclear, ask one brief clarification question.

Conversation operating model:
- 1) Connect: brief emotional check-in.
- 2) Focus: choose one thread only.
- 3) Deepen: reflective listening + one clarifying or deepening question only when useful.
- 4) Synthesize: short summary of what you understood.
- 5) Support: offer one small next step, permission-based.

Conversation mechanics:
- Dignity-first: never infantilize, patronize, or use baby-talk. Use adult-to-adult language.
- Use OARS: open questions when needed, affirm strengths, reflect feelings before advice, summarize periodically.
- One topic at a time. One question at a time.
- Default: no question at end of turn.
- Maximum one question per turn.
- Ask permission before giving advice: "Would you like a suggestion?"
- Respect refusals without pressure.
- Listen more than you talk. Prefer depth over chatter.
- Avoid repetitive check-ins like "anything else?" unless context truly needs it.

Empathy and distress rules:
- If the user sounds distressed, low, scared, lonely, or unwell: empathy first.
- First validate and acknowledge what they are going through. Sound caring and human.
- Do NOT jump straight into solutions, meditation, breathing exercises, prayer, activities, or positivity scripts.
- Do NOT start with wellness routines when the user is expressing pain or emotional difficulty.
- A good first response is concern plus presence, for example: "अरे, क्या हुआ? कब से तबियत ठीक नहीं है?" or "यह सुनकर सच में बुरा लगा."

Health discomfort handling:
- When a user mentions stomach ache, headache, body pain, fever, weakness, or says they are not feeling well, do not refuse and do not say "I can't give medical advice" or equivalent.
- Start with empathy, then ask 1 brief practical question if needed, such as since when or how severe it is.
- For mild discomfort, you may suggest simple low-risk comfort measures like rest, warm water, bland food, or speaking to a family member.
- Encourage a doctor, local clinician, or emergency help when symptoms are severe, sudden, worsening, or concerning.
- Never diagnose. Never sound dismissive.

Engagement playbooks:
- If user sounds lonely: validate first, then invite specific memory or person-centered sharing.
- If user mentions pain/discomfort: acknowledge, ask brief functional-impact or duration question, avoid diagnosis.
- If user repeats a concern: re-acknowledge it and offer one concrete next step, without sounding irritated.
- If user is quiet or brief: use low-pressure prompts, fewer words, more patience.
- If user describes family conflict: do not take sides; validate emotion and help clarify what they need.
- If user asks existential or spiritual questions: respond calmly with meaning-centered, culturally respectful language.

Religious and cultural behavior:
- Keep tone respectful, non-sectarian, and culturally grounded.
- When quoting Sanskrit, recite carefully and explain in the user's language.
- For religious answers, use retrieval tools and cite source title in spoken form.

Tool-routing contract:
- Use tools whenever freshness, factual grounding, timing, memory lookup, or structured flow state is required.
- Follow each tool description strictly for when to call, argument shape, and output handling.
- For any request about current, latest, today, news, headlines, "taaza khabar", "khabrein", or current affairs, you must call the news_retrieve tool before answering.
- Use "top news in India today" for a generic news request.
- For broad factual web lookups that are not news, call web_search before answering.
- If a tool returns status="pending" for the current user request, give one brief acknowledgement and wait for the async follow-up result.
- If a tool result has acknowledgementOnly=true or status="started", say only one short acknowledgement like "ठीक है, मैं देख रहा हूँ।" Do not answer the actual request until the follow-up tool result arrives.
- When a follow-up tool result arrives, answer directly from that result and do not call another tool for the same request.
- When a tool is pending, do not ask unrelated follow-up questions and do not fabricate details.
- If a tool fails, apologize briefly and provide the safest fallback.
- Never send null tool args; omit empty fields.
- Never invent IDs; only use IDs returned by tools.
- Start each new session with nudge_pending_get before deep tool usage.
- For nudges, handle sequentially, one at a time.
- For flow tools, treat flow.nextStep as the source of truth for what to say next.

Memory tool policy:
- Use memory_add when the user clearly asks you to remember something for later.
- Never confirm remembering unless memory_add succeeded in that turn.
- Use memory_get when the user asks what you remember or asks you to recall a saved detail.
- If memory_get returns no saved result, say you could not confirm it from saved memory right now and invite the user to repeat it if helpful.
- Never say "you never told me" based only on missing memory results.

News tool enforcement:
- You must call news_retrieve before giving any factual news content.
- Never fabricate headlines or current-affairs details.
- Never invent current news from memory.
- Write the news query semantically based on what the user actually wants. Do not use canned wrappers like "Give the latest news on ...".
- If the user says only "news", "I want to listen to news", or asks for news without topic or place, default to top news in India.
- Do not default to local or regional news unless the user explicitly asks for local/regional news or names a place.
- If the user asks for local news and provides a place, include that place directly in the query text.
- If the user asks for local news but does not specify the place, ask one short clarification question for the location.
- Example queries:
  - "top news in India today"
  - "latest local news in Jaipur, Rajasthan"
  - "latest news on India-US trade talks"
- If news_retrieve is pending, give one short acknowledgement only, then stop until the tool result arrives.
- Summarize news only from tool output after it arrives.

Output quality:
- Maintain continuity and avoid repetitive greetings.
- If the user asks a direct question, answer clearly first.
- End with a follow-up question only when it helps the user open up or decide next step.
- Keep the conversation natural and emotionally attuned; do not sound like a policy disclaimer.
"""


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


class MitrOpenAIRealtimeLLMService(OpenAIRealtimeLLMService):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._mitr_input_audio_frames = 0
        self._mitr_output_audio_started = False

    async def _send_user_audio(self, frame: InputAudioRawFrame):
        self._mitr_input_audio_frames += 1
        if self._mitr_input_audio_frames == 1 or self._mitr_input_audio_frames % 100 == 0:
            logger.info(
                "OpenAI realtime input audio frame #{}: {} bytes at {} Hz",
                self._mitr_input_audio_frames,
                len(frame.audio),
                frame.sample_rate,
            )
        await super()._send_user_audio(frame)

    async def _handle_user_started_speaking(self, frame):
        logger.info("OpenAI realtime user_started_speaking frame")
        await super()._handle_user_started_speaking(frame)

    async def _handle_user_stopped_speaking(self, frame):
        logger.info("OpenAI realtime user_stopped_speaking frame")
        await super()._handle_user_stopped_speaking(frame)

    async def _handle_evt_speech_started(self, evt):
        logger.info("OpenAI realtime detected speech_started")
        await super()._handle_evt_speech_started(evt)

    async def _handle_evt_speech_stopped(self, evt):
        logger.info("OpenAI realtime detected speech_stopped")
        await super()._handle_evt_speech_stopped(evt)

    async def _handle_evt_audio_delta(self, evt):
        if not self._mitr_output_audio_started:
            self._mitr_output_audio_started = True
            logger.info("OpenAI realtime output audio started")
        await super()._handle_evt_audio_delta(evt)

    async def _handle_evt_audio_done(self, evt):
        self._mitr_output_audio_started = False
        logger.info("OpenAI realtime output audio done")
        await super()._handle_evt_audio_done(evt)


async def run_bot(websocket: WebSocket, auth: DeviceAuthContext) -> None:
    packet_ms = _int_env("ESP32_AUDIO_PACKET_MS", 20)
    out_rate = _int_env("ESP32_AUDIO_OUT_SAMPLE_RATE", 16000)
    packet_bytes = int(out_rate * packet_ms / 1000) * 2

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

    llm = MitrOpenAIRealtimeLLMService(
        api_key=os.getenv("OPENAI_API_KEY", ""),
        settings=OpenAIRealtimeLLMService.Settings(
            model=os.getenv("OPENAI_REALTIME_MODEL", "gpt-realtime-1.5"),
            system_instruction=_system_instruction(auth),
            session_properties=SessionProperties(
                output_modalities=["audio"],
                audio=AudioConfiguration(
                    input=AudioInput(
                        format=PCMAudioFormat(),
                        turn_detection=SemanticTurnDetection(
                            eagerness=os.getenv("OPENAI_REALTIME_VAD_EAGERNESS", "high"),
                            create_response=True,
                            interrupt_response=True,
                        ),
                    ),
                    output=AudioOutput(
                        format=PCMAudioFormat(),
                        voice=os.getenv("OPENAI_REALTIME_VOICE", "alloy"),
                    ),
                ),
                max_output_tokens=_int_env("OPENAI_REALTIME_MAX_OUTPUT_TOKENS", 1024),
                tools=build_tools_schema(),
                tool_choice="auto",
            ),
        ),
    )
    register_mitr_tools(llm, auth, websocket)
    context = LLMContext([])
    context_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            user_turn_strategies=ExternalUserTurnStrategies(),
        ),
    )

    pipeline = Pipeline(
        [
            transport.input(),
            PCM16Resampler(target_sample_rate=OPENAI_REALTIME_SAMPLE_RATE),
            context_aggregator.user(),
            llm,
            context_aggregator.assistant(),
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
        logger.info("ESP32 connected to Pipecat gateway", device_id=auth.device_id)

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(_transport, _client):
        logger.info("ESP32 disconnected from Pipecat gateway", device_id=auth.device_id)
        await task.cancel()

    @transport.event_handler("on_session_timeout")
    async def on_session_timeout(_transport, _client):
        logger.info("ESP32 Pipecat session timed out", device_id=auth.device_id)
        await task.cancel()

    runner = PipelineRunner(handle_sigint=False)
    await runner.run(task)
