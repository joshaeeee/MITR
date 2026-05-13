import json
import os
import asyncio

from fastapi import WebSocket
from loguru import logger

from pipecat.audio.utils import create_stream_resampler
from pipecat.frames.frames import Frame, InputAudioRawFrame, LLMUpdateSettingsFrame
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
from pipecat.services.settings import LLMSettings
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)
from pipecat.turns.user_turn_strategies import ExternalUserTurnStrategies

from .auth import DeviceAuthContext
from .serializer import Esp32PCMSerializer
from .tools import build_tools_schema, execute_backend_tool_once, register_mitr_tools

OPENAI_REALTIME_SAMPLE_RATE = 24000


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

Elder journey model:
- The user may be 60+, not necessarily frail or low-tech. Do not assume incapability; many users use phones, WhatsApp, Facebook, YouTube, and news apps.
- Adapt to relationship stage from conversation_planner_get. A day-1 device should not behave like a month-6 companion.
- In first_use and ritual_trust stages, anchor nearly every proactive turn to a known routine, reminder, family message, news, music, prayer, or a very small practice action.
- In preference_learning, learn by offering small choices, not by asking a profile interview.
- In relationship_building and mature stages, use memory, life-story, family, devotional, news, music, games, and routine prompts with cooldowns.
- Freshness rule: never repeat a proactive question or topic just because it is in your prompt. Use conversation_planner_get and respect avoidPromptKeys.
- Treat "no", silence, irritation, or short replies as valid preference signals. Use prompt_outcome_record when a planned prompt is accepted, refused, ignored, unclear, or completed.
- After an elder answers a medication reminder, call medication_response_record before continuing.
- After medicine is taken, ask at most one optional routine-linked follow-up. If the planner says close, close.

Conversation mechanics:
- Dignity-first: never infantilize, patronize, or use baby-talk. Use adult-to-adult language.
- Avoid elderspeak: no exaggerated praise for basic actions, no "good boy/girl", no childish pet names, no patronizing "we" for the user's action.
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
- Use the injected runtime context packet when it is present. If it is not present yet, do not block the first response just to fetch context.
- Call context_packet_get before sliding in any pending follow-up or assistant-initiated topic.
- Treat context_packet_get as the source of truth for "what matters now": handle mustHandle first unless the user is distressed or asking for something urgent; use at most one mayMention item; respect avoid and style.questionBudget.
- If a context packet is missing, failed, or marked freshness.stale=true, do not invent or assume context. Use only explicit items in the packet, and prefer answering the user's current request.
- When you mention a context card, call context_card_outcome_record with eventType="mentioned". After the user answers, call it again with completed, dismissed, ignored, snoozed, or answered as appropriate.
- Use context_memory_add for durable preferences, routines, relationships, boundaries, and event follow-ups that should shape future context packets. Use context_card_upsert for specific future/open-loop follow-ups such as "ask tomorrow how the doctor visit went".
- Call conversation_planner_get before any proactive greeting, routine check-in, reminder follow-up, family bridge, or assistant-initiated question that is not fully determined by context_packet_get.
- For reminder_fired, reminder_acknowledged, medication_taken, medication_delayed, routine_time, morning, evening, caregiver_nudge, user_quiet, and first_use triggers, conversation_planner_get is the source of truth for the next proactive move.
- When conversation_planner_get returns plan.promptSeed, use it as the behavioral source, not necessarily verbatim. Keep the plan's intent, allowedQuestionCount, tone, followupPolicy, constraints, and toolHints.
- If the user responds to a planned prompt, call prompt_outcome_record with the returned promptHistoryId and responseState.
- If the user says they took medicine, wants a delay, refuses, does not respond, or gives an unclear answer to a medication prompt, call medication_response_record with status taken, delayed, refused, no_response, or unclear.
- For any request about current, latest, today, news, headlines, "taaza khabar", "khabrein", or current affairs, you must call the news_retrieve tool before answering.
- Use "top news in India today" for a generic news request.
- For broad factual web lookups that are not news, call web_search before answering.
- If a tool returns status="pending" for the current user request, give one brief acknowledgement and wait for the async follow-up result.
- If a tool result has acknowledgementOnly=true or status="started", say only one short acknowledgement like "ठीक है, मैं देख रहा हूँ।" Do not answer the actual request until the follow-up tool result arrives.
- When a follow-up tool result arrives, answer directly from that result and do not call another tool for the same request.
- When a tool is pending, do not ask unrelated follow-up questions and do not fabricate details.
- If a tool fails, apologize briefly and say what you can safely do next.
- If a memory/context tool fails, do not use local guesses or generic fallback context.
- Never send null tool args; omit empty fields.
- Never invent IDs; only use IDs returned by tools.
- Call nudge_pending_get only when you are about to handle family nudges or begin deeper proactive usage.
- For nudges, handle sequentially, one at a time.
- For flow tools, treat flow.nextStep as the source of truth for what to say next.

Runtime behavior contract:
- Never spend the user's first seconds on hidden work. If context is missing or late, answer naturally and use tools only when needed.
- If context_packet_get has a mustHandle medication or care item, slide it in briefly before optional requests; otherwise answer the user's request first.
- Mention at most one context card in a spoken turn. Do not combine medicine, family, routine, and life-story follow-ups.
- If a context card is refused, ignored, or snoozed, record the outcome and do not ask again in the same session unless the user brings it up.
- Saved memory should make Reca more considerate, not more talkative.

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


async def _fetch_runtime_context_packet(auth: DeviceAuthContext) -> dict[str, object] | None:
    if os.getenv("MITR_GATEWAY_INJECT_BOOT_CONTEXT", "true").strip().lower() not in {"1", "true", "yes", "on"}:
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
        asyncio.create_task(_queue_runtime_context_update(task, llm, auth))

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
