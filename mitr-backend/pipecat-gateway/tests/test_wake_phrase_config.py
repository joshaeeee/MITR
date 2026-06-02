import asyncio
import contextlib
import os
import time
import unittest
from collections import deque
from datetime import datetime, timezone
from types import MethodType
from unittest.mock import patch

from pipecat.frames.frames import (
    CancelFrame,
    InputAudioRawFrame,
    InterimTranscriptionFrame,
    OutputAudioRawFrame,
    StartFrame,
    TranscriptionFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection

from mitr_pipecat_gateway import bot_common, bot_wake_phrase
from mitr_pipecat_gateway.auth import DeviceAuthContext


class FakeTaskManager:
    def create_task(self, coro, name=None):
        return asyncio.create_task(coro, name=name)

    async def cancel_task(self, task, timeout=1.0):
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


class WakePhraseConfigTests(unittest.TestCase):
    def setUp(self):
        self._saved_env = {
            "MITR_GATEWAY_WAKE_PHRASES": os.environ.get("MITR_GATEWAY_WAKE_PHRASES"),
            "MITR_GATEWAY_WAKE_PHRASE_PREROLL_SEC": os.environ.get(
                "MITR_GATEWAY_WAKE_PHRASE_PREROLL_SEC"
            ),
            "MITR_GATEWAY_WAKE_USE_INTERIM_TRANSCRIPTS": os.environ.get(
                "MITR_GATEWAY_WAKE_USE_INTERIM_TRANSCRIPTS"
            ),
            "MITR_GATEWAY_DEFAULT_TIMEZONE": os.environ.get("MITR_GATEWAY_DEFAULT_TIMEZONE"),
            "OPENAI_REALTIME_TURN_DETECTION": os.environ.get("OPENAI_REALTIME_TURN_DETECTION"),
            "OPENAI_REALTIME_STT_MODEL": os.environ.get("OPENAI_REALTIME_STT_MODEL"),
            "OPENAI_REALTIME_WAKE_STT_MODEL": os.environ.get(
                "OPENAI_REALTIME_WAKE_STT_MODEL"
            ),
            "MITR_GATEWAY_PIPELINE_MODE": os.environ.get("MITR_GATEWAY_PIPELINE_MODE"),
            "MITR_GATEWAY_PIPELINE": os.environ.get("MITR_GATEWAY_PIPELINE"),
            "OPENAI_LLM_MODEL": os.environ.get("OPENAI_LLM_MODEL"),
            "OPENAI_LLM_MAX_TOKENS": os.environ.get("OPENAI_LLM_MAX_TOKENS"),
            "OPENAI_LLM_TEMPERATURE": os.environ.get("OPENAI_LLM_TEMPERATURE"),
            "OPENAI_LLM_TOP_P": os.environ.get("OPENAI_LLM_TOP_P"),
            "ELEVENLABS_API_KEY": os.environ.get("ELEVENLABS_API_KEY"),
            "ELEVENLABS_VOICE_ID": os.environ.get("ELEVENLABS_VOICE_ID"),
            "ELEVENLABS_VOICE": os.environ.get("ELEVENLABS_VOICE"),
            "ELEVENLABS_TTS_MODEL": os.environ.get("ELEVENLABS_TTS_MODEL"),
            "ELEVENLABS_TTS_LANGUAGE": os.environ.get("ELEVENLABS_TTS_LANGUAGE"),
            "ELEVENLABS_TEXT_AGGREGATION_MODE": os.environ.get(
                "ELEVENLABS_TEXT_AGGREGATION_MODE"
            ),
            "ELEVENLABS_AUTO_MODE": os.environ.get("ELEVENLABS_AUTO_MODE"),
            "ELEVENLABS_ENABLE_LOGGING": os.environ.get("ELEVENLABS_ENABLE_LOGGING"),
            "ELEVENLABS_STABILITY": os.environ.get("ELEVENLABS_STABILITY"),
            "ELEVENLABS_SIMILARITY_BOOST": os.environ.get("ELEVENLABS_SIMILARITY_BOOST"),
            "ELEVENLABS_STYLE": os.environ.get("ELEVENLABS_STYLE"),
            "ELEVENLABS_USE_SPEAKER_BOOST": os.environ.get("ELEVENLABS_USE_SPEAKER_BOOST"),
            "ELEVENLABS_SPEED": os.environ.get("ELEVENLABS_SPEED"),
            "ELEVENLABS_APPLY_TEXT_NORMALIZATION": os.environ.get(
                "ELEVENLABS_APPLY_TEXT_NORMALIZATION"
            ),
            "OPENAI_REALTIME_REASONING_EFFORT": os.environ.get(
                "OPENAI_REALTIME_REASONING_EFFORT"
            ),
            "OPENAI_REALTIME_TRUNCATION": os.environ.get("OPENAI_REALTIME_TRUNCATION"),
            "OPENAI_REALTIME_TRUNCATION_RETENTION_RATIO": os.environ.get(
                "OPENAI_REALTIME_TRUNCATION_RETENTION_RATIO"
            ),
            "OPENAI_REALTIME_TRUNCATION_POST_INSTRUCTIONS_TOKEN_LIMIT": os.environ.get(
                "OPENAI_REALTIME_TRUNCATION_POST_INSTRUCTIONS_TOKEN_LIMIT"
            ),
            "MITR_GATEWAY_CONTEXT_SUMMARIZATION": os.environ.get(
                "MITR_GATEWAY_CONTEXT_SUMMARIZATION"
            ),
            "MITR_GATEWAY_CONTEXT_SUMMARY_MODEL": os.environ.get(
                "MITR_GATEWAY_CONTEXT_SUMMARY_MODEL"
            ),
            "OPENAI_CONTEXT_SUMMARY_MODEL": os.environ.get("OPENAI_CONTEXT_SUMMARY_MODEL"),
            "MITR_GATEWAY_CONTEXT_SUMMARY_MAX_CONTEXT_TOKENS": os.environ.get(
                "MITR_GATEWAY_CONTEXT_SUMMARY_MAX_CONTEXT_TOKENS"
            ),
            "MITR_GATEWAY_CONTEXT_SUMMARY_MAX_UNSUMMARIZED_MESSAGES": os.environ.get(
                "MITR_GATEWAY_CONTEXT_SUMMARY_MAX_UNSUMMARIZED_MESSAGES"
            ),
            "MITR_GATEWAY_CONTEXT_SUMMARY_TARGET_TOKENS": os.environ.get(
                "MITR_GATEWAY_CONTEXT_SUMMARY_TARGET_TOKENS"
            ),
            "MITR_GATEWAY_CONTEXT_SUMMARY_KEEP_MESSAGES": os.environ.get(
                "MITR_GATEWAY_CONTEXT_SUMMARY_KEEP_MESSAGES"
            ),
            "MITR_GATEWAY_CONTEXT_SUMMARY_TIMEOUT_SEC": os.environ.get(
                "MITR_GATEWAY_CONTEXT_SUMMARY_TIMEOUT_SEC"
            ),
            "MITR_GATEWAY_CONTEXT_SUMMARY_TEMPERATURE": os.environ.get(
                "MITR_GATEWAY_CONTEXT_SUMMARY_TEMPERATURE"
            ),
            "MITR_GATEWAY_CONTEXT_SUMMARY_LOG_CONTENT": os.environ.get(
                "MITR_GATEWAY_CONTEXT_SUMMARY_LOG_CONTENT"
            ),
            "MITR_GATEWAY_CONTEXT_SUMMARY_LOG_MAX_CHARS": os.environ.get(
                "MITR_GATEWAY_CONTEXT_SUMMARY_LOG_MAX_CHARS"
            ),
            "MITR_GATEWAY_REALTIME_PROVIDER": os.environ.get(
                "MITR_GATEWAY_REALTIME_PROVIDER"
            ),
            "GEMINI_LIVE_MODEL": os.environ.get("GEMINI_LIVE_MODEL"),
            "GEMINI_LIVE_UNVERIFIED_MODEL_FALLBACK": os.environ.get(
                "GEMINI_LIVE_UNVERIFIED_MODEL_FALLBACK"
            ),
            "GEMINI_LIVE_LANGUAGE": os.environ.get("GEMINI_LIVE_LANGUAGE"),
            "GEMINI_LIVE_PROMPT_MODE": os.environ.get("GEMINI_LIVE_PROMPT_MODE"),
            "GEMINI_LIVE_COMPACT_SYSTEM_PROMPT": os.environ.get(
                "GEMINI_LIVE_COMPACT_SYSTEM_PROMPT"
            ),
            "GEMINI_LIVE_TRANSCRIPT_WAKE_PREROLL_SEC": os.environ.get(
                "GEMINI_LIVE_TRANSCRIPT_WAKE_PREROLL_SEC"
            ),
            "GEMINI_LIVE_WAKE_IDLE_TIMEOUT_SEC": os.environ.get(
                "GEMINI_LIVE_WAKE_IDLE_TIMEOUT_SEC"
            ),
            "GEMINI_LIVE_SERVICE": os.environ.get("GEMINI_LIVE_SERVICE"),
            "GEMINI_LIVE_ACTIVITY_MODE": os.environ.get("GEMINI_LIVE_ACTIVITY_MODE"),
            "GEMINI_LIVE_AUDIO_SEND_PACING": os.environ.get("GEMINI_LIVE_AUDIO_SEND_PACING"),
            "GEMINI_LIVE_INPUT_BATCH_MS": os.environ.get("GEMINI_LIVE_INPUT_BATCH_MS"),
            "GEMINI_LIVE_BACKLOG_INPUT_BATCH_MS": os.environ.get(
                "GEMINI_LIVE_BACKLOG_INPUT_BATCH_MS"
            ),
            "GEMINI_LIVE_EXPLICIT_VAD_SIGNAL": os.environ.get(
                "GEMINI_LIVE_EXPLICIT_VAD_SIGNAL"
            ),
            "GEMINI_LIVE_PREROLL_FLUSH_BATCH_MS": os.environ.get(
                "GEMINI_LIVE_PREROLL_FLUSH_BATCH_MS"
            ),
            "GEMINI_LIVE_STALE_OUTPUT_GUARD_MS": os.environ.get(
                "GEMINI_LIVE_STALE_OUTPUT_GUARD_MS"
            ),
            "GEMINI_LIVE_PRECONNECT_ON_CONNECT": os.environ.get(
                "GEMINI_LIVE_PRECONNECT_ON_CONNECT"
            ),
            "GEMINI_LIVE_PRECONNECT_BEFORE_LISTENING": os.environ.get(
                "GEMINI_LIVE_PRECONNECT_BEFORE_LISTENING"
            ),
            "GEMINI_LIVE_PRECONNECT_TIMEOUT_SEC": os.environ.get(
                "GEMINI_LIVE_PRECONNECT_TIMEOUT_SEC"
            ),
            "GEMINI_LIVE_MAX_OUTPUT_TOKENS": os.environ.get("GEMINI_LIVE_MAX_OUTPUT_TOKENS"),
            "GEMINI_LIVE_THINKING_BUDGET": os.environ.get("GEMINI_LIVE_THINKING_BUDGET"),
            "MITR_GATEWAY_WAKE_STT_PRE_READY_BUFFER_SEC": os.environ.get(
                "MITR_GATEWAY_WAKE_STT_PRE_READY_BUFFER_SEC"
            ),
            "MITR_GATEWAY_WAKE_STT_PRE_READY_FLUSH_BATCH_MS": os.environ.get(
                "MITR_GATEWAY_WAKE_STT_PRE_READY_FLUSH_BATCH_MS"
            ),
            "MITR_GATEWAY_WAKE_STT_ASYNC_CONNECT": os.environ.get(
                "MITR_GATEWAY_WAKE_STT_ASYNC_CONNECT"
            ),
            "MITR_GATEWAY_ECHO_SUPPRESSION_TAIL_MS": os.environ.get(
                "MITR_GATEWAY_ECHO_SUPPRESSION_TAIL_MS"
            ),
            "GEMINI_LIVE_ECHO_SUPPRESSION_TAIL_MS": os.environ.get(
                "GEMINI_LIVE_ECHO_SUPPRESSION_TAIL_MS"
            ),
        }
        for key in self._saved_env:
            os.environ.pop(key, None)

    def tearDown(self):
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_default_wake_phrases_include_product_and_legacy_aliases(self):
        os.environ.pop("MITR_GATEWAY_WAKE_PHRASES", None)

        phrases = bot_wake_phrase._wake_phrases()

        for expected in ["hi mitr", "hey mitr", "hi reca", "hey reca", "hi esp"]:
            self.assertIn(expected, phrases)

    def test_wake_phrase_env_override_is_trimmed(self):
        os.environ["MITR_GATEWAY_WAKE_PHRASES"] = " hi mitr, , hey mitr "

        self.assertEqual(bot_wake_phrase._wake_phrases(), ["hi mitr", "hey mitr"])

    def test_interim_wake_phrase_detection_defaults_on(self):
        self.assertTrue(bot_wake_phrase._wake_use_interim_transcripts())

        os.environ["MITR_GATEWAY_WAKE_USE_INTERIM_TRANSCRIPTS"] = "false"
        self.assertFalse(bot_wake_phrase._wake_use_interim_transcripts())

    def test_wake_stt_async_connect_defaults_on(self):
        self.assertTrue(bot_wake_phrase._wake_stt_async_connect())

        os.environ["MITR_GATEWAY_WAKE_STT_ASYNC_CONNECT"] = "false"
        self.assertFalse(bot_wake_phrase._wake_stt_async_connect())

    def test_realtime_turn_detection_must_be_manual(self):
        os.environ["OPENAI_REALTIME_TURN_DETECTION"] = "manual"
        self.assertFalse(bot_wake_phrase._openai_turn_detection())

        os.environ["OPENAI_REALTIME_TURN_DETECTION"] = "server_vad"
        with self.assertRaises(RuntimeError):
            bot_wake_phrase._openai_turn_detection()

    def test_default_pipeline_mode_keeps_openai_realtime(self):
        self.assertEqual(bot_wake_phrase._gateway_pipeline_mode(), "openai_realtime")

    def test_elevenlabs_pipeline_mode_aliases_are_supported(self):
        os.environ["MITR_GATEWAY_PIPELINE_MODE"] = "stt-llm-tts"

        self.assertEqual(bot_wake_phrase._gateway_pipeline_mode(), "openai_llm_elevenlabs")

    def test_openai_streaming_llm_uses_runtime_language_prompt_and_limits(self):
        os.environ["OPENAI_LLM_MODEL"] = "gpt-4.1"
        os.environ["OPENAI_LLM_MAX_TOKENS"] = "384"
        os.environ["OPENAI_LLM_TEMPERATURE"] = "0.4"
        auth = DeviceAuthContext(
            device_id="mitr-esp32-002",
            user_id="user-1",
            family_id="family-1",
            elder_id="elder-1",
            language="hi-IN",
        )

        llm = bot_wake_phrase._build_openai_streaming_llm("test-openai-key", auth)

        self.assertEqual(llm._settings.model, "gpt-4.1")
        self.assertEqual(llm._settings.max_tokens, 384)
        self.assertEqual(llm._settings.temperature, 0.4)
        self.assertIn("preferred language from hi-IN", llm._settings.system_instruction)

    def test_elevenlabs_tts_uses_auth_language_by_default(self):
        os.environ["ELEVENLABS_API_KEY"] = "test-elevenlabs-key"
        os.environ["ELEVENLABS_VOICE_ID"] = "voice-1"
        auth = DeviceAuthContext(
            device_id="mitr-esp32-002",
            user_id="user-1",
            family_id="family-1",
            elder_id="elder-1",
            language="hi-IN",
        )

        tts = bot_wake_phrase._build_elevenlabs_tts(auth, sample_rate=16000)

        self.assertEqual(tts._settings.voice, "voice-1")
        self.assertEqual(tts._settings.language, "hi")
        self.assertEqual(tts._text_aggregation_mode.value, "token")
        self.assertFalse(tts._auto_mode)

    def test_elevenlabs_language_env_override_wins(self):
        os.environ["ELEVENLABS_API_KEY"] = "test-elevenlabs-key"
        os.environ["ELEVENLABS_TTS_LANGUAGE"] = "en-US"
        os.environ["ELEVENLABS_TEXT_AGGREGATION_MODE"] = "sentence"
        auth = DeviceAuthContext(
            device_id="mitr-esp32-002",
            user_id="user-1",
            family_id="family-1",
            elder_id="elder-1",
            language="hi-IN",
        )

        tts = bot_wake_phrase._build_elevenlabs_tts(auth, sample_rate=16000)

        self.assertEqual(tts._settings.language, "en")
        self.assertEqual(tts._text_aggregation_mode.value, "sentence")
        self.assertTrue(tts._auto_mode)

    def test_realtime_provider_defaults_to_openai(self):
        self.assertEqual(bot_wake_phrase._realtime_provider(), "openai")

    def test_realtime_provider_accepts_gemini_live_aliases(self):
        os.environ["MITR_GATEWAY_REALTIME_PROVIDER"] = "gemini"

        self.assertEqual(bot_wake_phrase._realtime_provider(), "gemini_live")

    def test_realtime_provider_rejects_unknown_value(self):
        os.environ["MITR_GATEWAY_REALTIME_PROVIDER"] = "anthropic"

        with self.assertRaises(RuntimeError):
            bot_wake_phrase._realtime_provider()

    def test_gemini_live_model_defaults_to_31_flash_live_preview(self):
        self.assertEqual(
            bot_wake_phrase._gemini_live_model(),
            "models/gemini-3.1-flash-live-preview",
        )

    def test_gemini_live_model_allows_31_live_flash_without_fallback(self):
        os.environ["GEMINI_LIVE_MODEL"] = "models/gemini-3.1-live-flash"

        self.assertEqual(
            bot_wake_phrase._gemini_live_model(),
            "models/gemini-3.1-live-flash",
        )

    def test_gemini_live_model_allows_configurable_supported_model(self):
        os.environ["GEMINI_LIVE_MODEL"] = "models/gemini-2.5-flash-native-audio-preview-12-2025"

        self.assertEqual(
            bot_wake_phrase._gemini_live_model(),
            "models/gemini-2.5-flash-native-audio-preview-12-2025",
        )

    def test_gemini_live_language_preserves_auth_language(self):
        auth = DeviceAuthContext(
            device_id="mitr-esp32-002",
            user_id="user-1",
            family_id="family-1",
            elder_id="elder-1",
            language="hi-IN",
        )

        self.assertEqual(
            bot_wake_phrase._gemini_live_language(auth),
            bot_wake_phrase.Language.HI_IN,
        )

    def test_gemini_live_system_prompt_defaults_to_compact_low_latency_prompt(self):
        auth = DeviceAuthContext(device_id="mitr-esp32-002", language="hi-IN")

        prompt = bot_wake_phrase._gemini_live_system_instruction(auth)

        self.assertIn("preferred language from hi-IN", prompt)
        self.assertIn("After a tool result arrives, answer directly", prompt)
        self.assertIn("Current Runtime Time", prompt)
        self.assertLess(len(prompt), 3500)

    def test_gemini_live_system_prompt_can_use_shared_template(self):
        os.environ["GEMINI_LIVE_PROMPT_MODE"] = "shared"
        auth = DeviceAuthContext(device_id="mitr-esp32-002", language="hi-IN")

        prompt = bot_wake_phrase._gemini_live_system_instruction(auth)

        self.assertIn("Role and Objective", prompt)
        self.assertIn("preferred language from hi-IN", prompt)
        self.assertIn("Current Runtime Time", prompt)
        self.assertGreater(len(prompt), 8000)

    def test_gemini_live_compact_prompt_env_can_use_shared_template(self):
        os.environ["GEMINI_LIVE_COMPACT_SYSTEM_PROMPT"] = "false"
        auth = DeviceAuthContext(device_id="mitr-esp32-002", language="hi-IN")

        prompt = bot_wake_phrase._gemini_live_system_instruction(auth)

        self.assertIn("Role and Objective", prompt)
        self.assertIn("Current Runtime Time", prompt)

    def test_gemini_live_direct_sdk_defaults_to_low_latency_settings(self):
        self.assertEqual(bot_wake_phrase._gemini_live_service_mode(), "direct_sdk")
        self.assertEqual(bot_wake_phrase._gemini_live_activity_mode(), "manual")
        self.assertFalse(bot_wake_phrase._gemini_live_audio_send_pacing())
        self.assertEqual(bot_wake_phrase._gemini_live_input_batch_ms(), 20)
        self.assertEqual(bot_wake_phrase._gemini_live_backlog_input_batch_ms(), 80)
        self.assertEqual(bot_wake_phrase._gemini_live_preroll_flush_batch_ms(), 80)
        self.assertFalse(bot_wake_phrase._gemini_live_explicit_vad_signal())
        self.assertEqual(bot_wake_phrase._gemini_live_stale_output_guard_ms(), 0)
        self.assertTrue(bot_wake_phrase._gemini_live_server_vad_enabled())
        self.assertEqual(bot_wake_phrase._gemini_live_server_vad_stop_ms(), 120)
        self.assertTrue(bot_wake_phrase._gemini_live_preconnect_on_connect())
        self.assertFalse(bot_wake_phrase._gemini_live_preconnect_before_listening())
        self.assertIsNone(bot_wake_phrase._gemini_live_max_output_tokens())
        self.assertEqual(bot_wake_phrase._gemini_live_thinking_budget(), 0)
        self.assertEqual(bot_wake_phrase._gemini_live_wake_idle_timeout(), 15.0)

    def test_gemini_live_wake_idle_timeout_has_specific_override(self):
        os.environ["GEMINI_LIVE_WAKE_IDLE_TIMEOUT_SEC"] = "12"

        self.assertEqual(bot_wake_phrase._gemini_live_wake_idle_timeout(), 12.0)

    def test_gemini_live_wake_stt_defaults_to_mini_transcribe(self):
        self.assertEqual(
            bot_wake_phrase._openai_realtime_stt_model(gemini_live=True),
            "gpt-4o-mini-transcribe",
        )
        self.assertEqual(
            bot_wake_phrase._openai_realtime_stt_model(gemini_live=False),
            "gpt-4o-transcribe",
        )

    def test_wake_stt_model_env_override_wins(self):
        os.environ["OPENAI_REALTIME_STT_MODEL"] = "gpt-4o-transcribe"

        self.assertEqual(
            bot_wake_phrase._openai_realtime_stt_model(gemini_live=True),
            "gpt-4o-transcribe",
        )

        os.environ["OPENAI_REALTIME_WAKE_STT_MODEL"] = "gpt-4o-mini-transcribe"
        self.assertEqual(
            bot_wake_phrase._openai_realtime_stt_model(gemini_live=True),
            "gpt-4o-mini-transcribe",
        )

    def test_gemini_live_uses_hardware_safe_echo_suppression_tail_by_default(self):
        self.assertEqual(bot_wake_phrase._echo_suppression_tail_ms(gemini_live=True), 1200)
        self.assertEqual(bot_wake_phrase._echo_suppression_tail_ms(gemini_live=False), 2500)

        os.environ["GEMINI_LIVE_ECHO_SUPPRESSION_TAIL_MS"] = "300"
        self.assertEqual(bot_wake_phrase._echo_suppression_tail_ms(gemini_live=True), 300)

        os.environ["MITR_GATEWAY_ECHO_SUPPRESSION_TAIL_MS"] = "900"
        self.assertEqual(bot_wake_phrase._echo_suppression_tail_ms(gemini_live=True), 900)
        self.assertEqual(bot_wake_phrase._echo_suppression_tail_ms(gemini_live=False), 900)

    def test_post_wake_turn_start_strategies_do_not_interrupt_active_responses(self):
        strategies = bot_wake_phrase._post_wake_turn_start_strategies()

        self.assertGreater(len(strategies), 0)
        self.assertTrue(all(not strategy._enable_interruptions for strategy in strategies))

    def test_wake_phrase_strip_handles_hindi_stt_aliases(self):
        os.environ["MITR_GATEWAY_WAKE_PHRASES"] = "hi esp,hey esp,hi reca"

        aliases = bot_wake_phrase._wake_phrase_aliases()

        self.assertIn("हाय ईएसपी", aliases)
        self.assertIn("हे ई एस पी", aliases)
        self.assertIn("हाय रेका", aliases)

    def test_wake_phrase_aliases_do_not_enable_unconfigured_devices(self):
        os.environ["MITR_GATEWAY_WAKE_PHRASES"] = "hi reca"

        aliases = bot_wake_phrase._wake_phrase_aliases()

        self.assertNotIn("हाय ईएसपी", aliases)

    def test_unicode_wake_phrase_matches_compact_interim_chunks(self):
        strategy = bot_wake_phrase.UnicodeWakePhraseUserTurnStartStrategy(
            phrases=["हाय रेका"],
        )
        detected = []
        strategy._transition_to_awake = detected.append

        self.assertFalse(strategy._check_wake_phrase("हा"))
        self.assertFalse(strategy._check_wake_phrase("य"))
        self.assertFalse(strategy._check_wake_phrase(" रे"))
        self.assertTrue(strategy._check_wake_phrase("का"))
        self.assertEqual(detected, ["हाय रेका"])

    def test_gemini_live_transcript_wake_preroll_defaults_to_short_buffer(self):
        self.assertEqual(bot_wake_phrase._gemini_live_transcript_wake_preroll_sec(), 0.5)

        os.environ["MITR_GATEWAY_WAKE_PHRASE_PREROLL_SEC"] = "1.2"
        self.assertEqual(bot_wake_phrase._gemini_live_transcript_wake_preroll_sec(), 1.2)

        os.environ["GEMINI_LIVE_TRANSCRIPT_WAKE_PREROLL_SEC"] = "0.3"
        self.assertEqual(bot_wake_phrase._gemini_live_transcript_wake_preroll_sec(), 0.3)

    def test_unicode_wake_phrase_alias_patterns_stay_aligned_with_phrases(self):
        strategy = bot_wake_phrase.UnicodeWakePhraseUserTurnStartStrategy(phrases=["hi reca"])

        self.assertEqual(len(strategy._patterns), len(strategy._phrases))
        alias_index = strategy._phrases.index("हे रेका")
        self.assertRegex("हे रेका", strategy._patterns[alias_index])

    def test_realtime2_session_options_are_explicit(self):
        os.environ["OPENAI_REALTIME_REASONING_EFFORT"] = "low"
        os.environ["OPENAI_REALTIME_TRUNCATION"] = "auto"

        self.assertEqual(
            bot_common._openai_realtime2_session_extra_fields("gpt-realtime-2"),
            {"reasoning": {"effort": "low"}, "truncation": "auto"},
        )

    def test_realtime2_session_options_reject_non_realtime2_models(self):
        os.environ["OPENAI_REALTIME_REASONING_EFFORT"] = "low"

        with self.assertRaises(RuntimeError):
            bot_common._openai_realtime2_session_extra_fields("gpt-realtime")

    def test_realtime2_retention_ratio_truncation(self):
        os.environ["OPENAI_REALTIME_TRUNCATION"] = "retention_ratio"
        os.environ["OPENAI_REALTIME_TRUNCATION_RETENTION_RATIO"] = "0.8"
        os.environ["OPENAI_REALTIME_TRUNCATION_POST_INSTRUCTIONS_TOKEN_LIMIT"] = "8000"

        self.assertEqual(
            bot_common._openai_realtime2_session_extra_fields("gpt-realtime-2"),
            {
                "truncation": {
                    "type": "retention_ratio",
                    "retention_ratio": 0.8,
                    "token_limits": {"post_instructions": 8000},
                }
            },
        )

    def test_realtime2_invalid_reasoning_effort_fails_fast(self):
        os.environ["OPENAI_REALTIME_REASONING_EFFORT"] = "fast-ish"

        with self.assertRaises(RuntimeError):
            bot_common._openai_realtime2_session_extra_fields("gpt-realtime-2")

    def test_realtime2_token_limit_requires_retention_ratio(self):
        os.environ["OPENAI_REALTIME_TRUNCATION_POST_INSTRUCTIONS_TOKEN_LIMIT"] = "8000"

        with self.assertRaises(RuntimeError):
            bot_common._openai_realtime2_session_extra_fields("gpt-realtime-2")

    def test_context_summarization_uses_pipecat_auto_defaults_with_dedicated_llm(self):
        params = bot_common._context_summarization_assistant_params("test-openai-key")

        self.assertTrue(params.enable_auto_context_summarization)
        config = params.auto_context_summarization_config
        self.assertIsNotNone(config)
        self.assertEqual(config.max_context_tokens, 8000)
        self.assertEqual(config.max_unsummarized_messages, 20)
        self.assertEqual(config.summary_config.target_context_tokens, 6000)
        self.assertEqual(config.summary_config.min_messages_after_summary, 4)
        self.assertEqual(config.summary_config.summarization_timeout, 120.0)
        self.assertIsNotNone(config.summary_config.llm)
        self.assertEqual(config.summary_config.llm._settings.model, "gpt-4.1-mini")

    def test_context_summarization_can_be_disabled(self):
        os.environ["MITR_GATEWAY_CONTEXT_SUMMARIZATION"] = "false"

        params = bot_common._context_summarization_assistant_params("test-openai-key")

        self.assertFalse(params.enable_auto_context_summarization)
        self.assertIsNone(params.auto_context_summarization_config)

    def test_context_summarization_env_overrides_thresholds(self):
        os.environ["MITR_GATEWAY_CONTEXT_SUMMARY_MODEL"] = "gpt-4.1"
        os.environ["MITR_GATEWAY_CONTEXT_SUMMARY_MAX_CONTEXT_TOKENS"] = "12000"
        os.environ["MITR_GATEWAY_CONTEXT_SUMMARY_MAX_UNSUMMARIZED_MESSAGES"] = "12"
        os.environ["MITR_GATEWAY_CONTEXT_SUMMARY_TARGET_TOKENS"] = "3000"
        os.environ["MITR_GATEWAY_CONTEXT_SUMMARY_KEEP_MESSAGES"] = "6"
        os.environ["MITR_GATEWAY_CONTEXT_SUMMARY_TIMEOUT_SEC"] = "30"

        config = bot_common._context_summarization_assistant_params(
            "test-openai-key"
        ).auto_context_summarization_config

        self.assertEqual(config.max_context_tokens, 12000)
        self.assertEqual(config.max_unsummarized_messages, 12)
        self.assertEqual(config.summary_config.target_context_tokens, 3000)
        self.assertEqual(config.summary_config.min_messages_after_summary, 6)
        self.assertEqual(config.summary_config.summarization_timeout, 30.0)
        self.assertEqual(config.summary_config.llm._settings.model, "gpt-4.1")

    def test_latest_context_summary_text_finds_inserted_summary(self):
        self.assertEqual(
            bot_common._latest_context_summary_text(
                [
                    {"role": "user", "content": "Conversation summary: user wants yoga"},
                    {"role": "assistant", "content": "Sure."},
                ]
            ),
            "Conversation summary: user wants yoga",
        )

    def test_latest_context_summary_text_ignores_non_summary_messages(self):
        self.assertIsNone(
            bot_common._latest_context_summary_text(
                [
                    {"role": "user", "content": "hello"},
                    {"role": "assistant", "content": "hi"},
                ]
            )
        )

    def test_system_prompt_template_renders_runtime_variables(self):
        prompt = bot_common._system_instruction(
            DeviceAuthContext(
                device_id="mitr-esp32-002",
                user_id="user-1",
                family_id="family-1",
                elder_id="elder-1",
                language="hi-IN",
            )
        )

        self.assertIn("preferred language from hi-IN", prompt)
        self.assertNotIn("{auth.language}", prompt)
        self.assertIn("Current Runtime Time", prompt)
        self.assertIn("User-local timezone: Asia/Kolkata", prompt)

    def test_runtime_time_context_uses_configured_timezone(self):
        auth = DeviceAuthContext(
            device_id="mitr-esp32-002",
            language="hi-IN",
            timezone="Asia/Kolkata",
        )

        context = bot_common._runtime_time_context(
            auth,
            now=datetime(2026, 6, 1, 18, 30, tzinfo=timezone.utc),
        )

        self.assertEqual(context["timezone"], "Asia/Kolkata")
        self.assertEqual(context["localDate"], "2026-06-02")
        self.assertEqual(context["localTime"], "00:00:00")
        self.assertEqual(context["localWeekday"], "Tuesday")


class WakePhraseRealtimeGateTests(unittest.IsolatedAsyncioTestCase):
    async def test_wake_flushes_buffered_audio_and_keeps_forwarding_audio(self):
        gate = bot_wake_phrase.WakePhraseRealtimeGate(preroll_sec=1.0)
        pushed = []

        async def capture_push(_self, frame, direction):
            pushed.append((frame, direction))

        gate.push_frame = MethodType(capture_push, gate)
        buffered_audio = InputAudioRawFrame(
            audio=b"\x01\x02" * 100,
            sample_rate=16000,
            num_channels=1,
        )
        live_audio = InputAudioRawFrame(audio=b"\x03\x04" * 100, sample_rate=16000, num_channels=1)

        await gate.process_frame(buffered_audio, FrameDirection.DOWNSTREAM)
        self.assertEqual(pushed, [])

        await gate.wake("hi mitr")

        self.assertIsInstance(pushed[0][0], UserStartedSpeakingFrame)
        self.assertIs(pushed[1][0], buffered_audio)
        self.assertEqual(pushed[1][1], FrameDirection.DOWNSTREAM)

        await gate.process_frame(live_audio, FrameDirection.DOWNSTREAM)
        self.assertIs(pushed[-1][0], live_audio)
        self.assertEqual(pushed[-1][1], FrameDirection.DOWNSTREAM)

    async def test_wake_replays_pending_stop_after_buffered_audio(self):
        gate = bot_wake_phrase.WakePhraseRealtimeGate(preroll_sec=1.0)
        pushed = []

        async def capture_push(_self, frame, direction):
            pushed.append((frame, direction))

        gate.push_frame = MethodType(capture_push, gate)
        buffered_audio = InputAudioRawFrame(
            audio=b"\x01\x02" * 100,
            sample_rate=16000,
            num_channels=1,
        )

        await gate.process_frame(buffered_audio, FrameDirection.DOWNSTREAM)
        await gate.process_frame(UserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await gate.wake("hi mitr")

        self.assertIsInstance(pushed[0][0], UserStartedSpeakingFrame)
        self.assertIs(pushed[1][0], buffered_audio)
        self.assertIsInstance(pushed[2][0], UserStoppedSpeakingFrame)

    async def test_wake_batches_buffered_preroll_audio_when_configured(self):
        gate = bot_wake_phrase.WakePhraseRealtimeGate(
            preroll_sec=1.0,
            preroll_flush_batch_ms=60,
        )
        pushed = []

        async def capture_push(_self, frame, direction):
            pushed.append((frame, direction))

        gate.push_frame = MethodType(capture_push, gate)
        frames = [
            InputAudioRawFrame(
                audio=bytes([index]) * 640,
                sample_rate=16000,
                num_channels=1,
            )
            for index in range(1, 5)
        ]

        for frame in frames:
            await gate.process_frame(frame, FrameDirection.DOWNSTREAM)

        await gate.wake("hi mitr")

        self.assertIsInstance(pushed[0][0], UserStartedSpeakingFrame)
        self.assertEqual(len(pushed), 3)
        self.assertIsInstance(pushed[1][0], InputAudioRawFrame)
        self.assertEqual(pushed[1][0].audio, b"".join(frame.audio for frame in frames[:3]))
        self.assertEqual(pushed[1][0].sample_rate, 16000)
        self.assertEqual(pushed[2][0].audio, frames[3].audio)
        self.assertEqual(gate._buffer_bytes, 0)


class WakeOnlyOpenAIRealtimeSTTServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_can_bypass_and_reenable_wake_transcription(self):
        stt = bot_wake_phrase.WakeOnlyOpenAIRealtimeSTTService(
            api_key="test",
            turn_detection=None,
            should_interrupt=False,
        )

        self.assertTrue(stt._wake_listening)

        await stt.set_wake_listening(False)
        self.assertFalse(stt._wake_listening)

        await stt.set_wake_listening(True)
        self.assertTrue(stt._wake_listening)

    async def test_start_connects_wake_stt_in_background_by_default(self):
        os.environ.pop("MITR_GATEWAY_WAKE_STT_ASYNC_CONNECT", None)
        stt = bot_wake_phrase.WakeOnlyOpenAIRealtimeSTTService(
            api_key="test",
            turn_detection=None,
            should_interrupt=False,
        )
        stt._task_manager = FakeTaskManager()
        started = asyncio.Event()
        unblock = asyncio.Event()
        calls = []

        async def slow_connect():
            calls.append("connect_start")
            started.set()
            await unblock.wait()
            calls.append("connect_done")

        stt._connect = slow_connect

        await stt.start(StartFrame(audio_in_sample_rate=16000))

        self.assertEqual(stt.sample_rate, 16000)
        await asyncio.wait_for(started.wait(), timeout=1)
        self.assertEqual(calls, ["connect_start"])
        self.assertIsNotNone(stt._connect_task)
        self.assertFalse(stt._connect_task.done())

        unblock.set()
        await asyncio.wait_for(stt._connect_task, timeout=1)
        self.assertEqual(calls, ["connect_start", "connect_done"])

    async def test_start_can_connect_wake_stt_synchronously_when_requested(self):
        saved = os.environ.get("MITR_GATEWAY_WAKE_STT_ASYNC_CONNECT")
        os.environ["MITR_GATEWAY_WAKE_STT_ASYNC_CONNECT"] = "false"
        try:
            stt = bot_wake_phrase.WakeOnlyOpenAIRealtimeSTTService(
                api_key="test",
                turn_detection=None,
                should_interrupt=False,
            )
            calls = []

            async def connect():
                calls.append("connect")

            stt._connect = connect

            await stt.start(StartFrame(audio_in_sample_rate=16000))

            self.assertEqual(calls, ["connect"])
            self.assertIsNone(stt._connect_task)
        finally:
            if saved is None:
                os.environ.pop("MITR_GATEWAY_WAKE_STT_ASYNC_CONNECT", None)
            else:
                os.environ["MITR_GATEWAY_WAKE_STT_ASYNC_CONNECT"] = saved

    async def test_buffers_wake_audio_until_transcription_session_is_ready(self):
        stt = bot_wake_phrase.WakeOnlyOpenAIRealtimeSTTService(
            api_key="test",
            turn_detection=None,
            should_interrupt=False,
        )
        sent_audio = []

        async def capture_send_audio(audio):
            sent_audio.append(audio)

        stt._send_audio = capture_send_audio
        frame = InputAudioRawFrame(audio=b"\x01\x02" * 100, sample_rate=16000, num_channels=1)

        await stt.process_audio_frame(frame, FrameDirection.DOWNSTREAM)

        self.assertEqual(sent_audio, [])
        self.assertEqual(len(stt._pre_ready_audio_buffer), 1)

        await stt._handle_session_updated({"type": "session.updated"})

        self.assertEqual(sent_audio, [frame.audio])
        self.assertEqual(len(stt._pre_ready_audio_buffer), 0)

    async def test_flushes_pre_ready_wake_audio_in_batches(self):
        os.environ["MITR_GATEWAY_WAKE_STT_PRE_READY_FLUSH_BATCH_MS"] = "100"
        stt = bot_wake_phrase.WakeOnlyOpenAIRealtimeSTTService(
            api_key="test",
            turn_detection=None,
            should_interrupt=False,
        )
        sent_audio = []

        async def capture_send_audio(audio):
            sent_audio.append(audio)

        stt._send_audio = capture_send_audio
        frames = [
            InputAudioRawFrame(audio=bytes([index]) * 320, sample_rate=16000, num_channels=1)
            for index in range(1, 4)
        ]

        for frame in frames:
            await stt.process_audio_frame(frame, FrameDirection.DOWNSTREAM)

        await stt._handle_session_updated({"type": "session.updated"})

        self.assertEqual(sent_audio, [b"".join(frame.audio for frame in frames)])
        self.assertEqual(len(stt._pre_ready_audio_buffer), 0)
        self.assertEqual(stt._pre_ready_audio_bytes, 0)

    async def test_pre_ready_wake_audio_buffer_is_bounded(self):
        os.environ["MITR_GATEWAY_WAKE_STT_PRE_READY_BUFFER_SEC"] = "0.01"
        stt = bot_wake_phrase.WakeOnlyOpenAIRealtimeSTTService(
            api_key="test",
            turn_detection=None,
            should_interrupt=False,
        )
        frame = InputAudioRawFrame(audio=b"\x01\x02" * 100, sample_rate=16000, num_channels=1)

        await stt.process_audio_frame(frame, FrameDirection.DOWNSTREAM)
        await stt.process_audio_frame(frame, FrameDirection.DOWNSTREAM)

        self.assertLessEqual(stt._pre_ready_audio_bytes, stt._max_pre_ready_audio_bytes)

    async def test_permanent_auth_error_disables_reconnect_and_wake_listening(self):
        stt = bot_wake_phrase.WakeOnlyOpenAIRealtimeSTTService(
            api_key="test",
            turn_detection=None,
            should_interrupt=False,
        )
        stt._reconnect_audio_buffer.append(
            (
                InputAudioRawFrame(audio=b"\x01\x02", sample_rate=16000, num_channels=1),
                FrameDirection.DOWNSTREAM,
            )
        )
        stt._pre_ready_audio_buffer.append(
            (
                InputAudioRawFrame(audio=b"\x03\x04", sample_rate=16000, num_channels=1),
                FrameDirection.DOWNSTREAM,
            )
        )
        stt._pre_ready_audio_bytes = 2
        pushed_errors = []

        async def capture_error(error_msg, exception=None, fatal=False):
            pushed_errors.append((error_msg, exception, fatal))

        stt.push_error = capture_error

        with self.assertRaisesRegex(Exception, "invalid_api_key"):
            await stt._handle_error(
                {
                    "error": {
                        "code": "invalid_api_key",
                        "message": "bad key",
                    }
                }
            )

        self.assertFalse(stt._reconnect_on_error)
        self.assertFalse(stt._wake_listening)
        self.assertEqual(stt._reconnect_audio_buffer, [])
        self.assertEqual(stt._pre_ready_audio_buffer, deque())
        self.assertEqual(stt._pre_ready_audio_bytes, 0)
        self.assertEqual(pushed_errors[0][0], "OpenAI Realtime STT error [invalid_api_key]: bad key")


class TranscriptWakeFastOpenTests(unittest.IsolatedAsyncioTestCase):
    async def test_wake_gate_opens_without_waiting_for_ui_notify(self):
        calls = []
        unblock = asyncio.Event()

        class SlowSTT:
            async def set_wake_listening(self, enabled, *, wait_for_clear=True):
                calls.append(("stt", enabled, wait_for_clear))
                if wait_for_clear:
                    await unblock.wait()
                    calls.append("stt_done")

        class FastGate:
            async def wake(self, phrase):
                await asyncio.sleep(0)
                calls.append(("gate", phrase))

        async def notify_awake(phrase):
            calls.append(("notify", phrase))
            await unblock.wait()
            calls.append("notify_done")

        tasks = await bot_wake_phrase._open_transcript_wake_fast(
            stt=SlowSTT(),
            gate=FastGate(),
            notify_awake=notify_awake,
            phrase="हाय रेका",
        )

        self.assertLess(
            calls.index(("stt", False, False)),
            calls.index(("gate", "हाय रेका")),
        )
        self.assertIn(("gate", "हाय रेका"), calls)
        self.assertTrue(any(not task.done() for task in tasks))

        unblock.set()
        await asyncio.gather(*tasks)
        self.assertIn("notify_done", calls)


class GeminiLivePreconnectTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._saved_env = {
            "GEMINI_LIVE_PRECONNECT_ON_CONNECT": os.environ.get(
                "GEMINI_LIVE_PRECONNECT_ON_CONNECT"
            ),
            "GEMINI_LIVE_PRECONNECT_BEFORE_LISTENING": os.environ.get(
                "GEMINI_LIVE_PRECONNECT_BEFORE_LISTENING"
            ),
            "GEMINI_LIVE_PRECONNECT_TIMEOUT_SEC": os.environ.get(
                "GEMINI_LIVE_PRECONNECT_TIMEOUT_SEC"
            ),
        }
        for key in self._saved_env:
            os.environ.pop(key, None)

    def tearDown(self):
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    async def test_gemini_preconnect_defaults_to_background(self):
        started = asyncio.Event()
        ready = asyncio.Event()
        calls = []

        class SlowLLM:
            async def preconnect(self, *, wait_ready=False):
                calls.append(wait_ready)
                started.set()
                await ready.wait()

        task = await bot_wake_phrase._preconnect_gemini_live_for_client(SlowLLM())
        await asyncio.wait_for(started.wait(), timeout=1)

        self.assertIsNotNone(task)
        self.assertEqual(calls, [True])
        self.assertFalse(task.done())

        ready.set()
        await asyncio.wait_for(task, timeout=1)

    async def test_gemini_preconnect_can_block_before_listening_when_requested(self):
        os.environ["GEMINI_LIVE_PRECONNECT_BEFORE_LISTENING"] = "true"
        calls = []

        class ReadyLLM:
            async def preconnect(self, *, wait_ready=False):
                calls.append(wait_ready)

        task = await bot_wake_phrase._preconnect_gemini_live_for_client(ReadyLLM())

        self.assertIsNone(task)
        self.assertEqual(calls, [True])

    async def test_gemini_preconnect_can_be_disabled(self):
        os.environ["GEMINI_LIVE_PRECONNECT_ON_CONNECT"] = "false"
        calls = []

        class LLM:
            async def preconnect(self, *, wait_ready=False):
                calls.append(wait_ready)

        task = await bot_wake_phrase._preconnect_gemini_live_for_client(LLM())

        self.assertIsNone(task)
        self.assertEqual(calls, [])

    async def test_early_gemini_preconnect_skips_pipecat_wrapper(self):
        calls = []

        class LLM:
            async def preconnect(self, *, wait_ready=False):
                calls.append(wait_ready)

        task = await bot_wake_phrase._start_gemini_live_preconnect_early(
            LLM(),
            gemini_direct=False,
        )

        self.assertIsNone(task)
        self.assertEqual(calls, [])

    async def test_early_gemini_preconnect_starts_direct_session(self):
        started = asyncio.Event()
        ready = asyncio.Event()
        calls = []

        class SlowLLM:
            async def preconnect(self, *, wait_ready=False):
                calls.append(wait_ready)
                started.set()
                await ready.wait()

        task = await bot_wake_phrase._start_gemini_live_preconnect_early(
            SlowLLM(),
            gemini_direct=True,
        )
        await asyncio.wait_for(started.wait(), timeout=1)

        self.assertIsNotNone(task)
        self.assertEqual(calls, [True])

        ready.set()
        await asyncio.wait_for(task, timeout=1)


class WakePhraseDetectorTests(unittest.IsolatedAsyncioTestCase):
    async def test_detects_wake_from_interim_transcript_without_forwarding_text(self):
        strategy = bot_wake_phrase.UnicodeWakePhraseUserTurnStartStrategy(
            phrases=["हाय रेका"],
            timeout=10,
            enable_interruptions=False,
            enable_user_speaking_frames=False,
            include_interim_transcripts=True,
        )
        detected = []
        detected_event = asyncio.Event()

        @strategy.event_handler("on_wake_phrase_detected")
        async def on_wake_phrase_detected(_strategy, phrase):
            detected.append(phrase)
            detected_event.set()

        detector = bot_wake_phrase.WakePhraseDetector(strategy)
        detector._task_manager = FakeTaskManager()
        pushed = []

        async def capture_push(_self, frame, direction):
            pushed.append((frame, direction))

        detector.push_frame = MethodType(capture_push, detector)

        start = StartFrame()
        audio = InputAudioRawFrame(audio=b"\x01\x02" * 100, sample_rate=16000, num_channels=1)
        interim = InterimTranscriptionFrame("हाय रेका", "user", "2026-06-01T00:00:00Z")

        await detector.process_frame(start, FrameDirection.DOWNSTREAM)
        await detector.process_frame(audio, FrameDirection.DOWNSTREAM)
        await detector.process_frame(interim, FrameDirection.DOWNSTREAM)
        await asyncio.wait_for(detected_event.wait(), timeout=1)
        await detector.process_frame(CancelFrame(), FrameDirection.DOWNSTREAM)

        self.assertEqual(detected, ["हाय रेका"])
        self.assertEqual(
            [frame.__class__ for frame, _direction in pushed],
            [StartFrame, InputAudioRawFrame, CancelFrame],
        )

    async def test_drops_final_transcripts_before_they_reach_gemini(self):
        strategy = bot_wake_phrase.UnicodeWakePhraseUserTurnStartStrategy(
            phrases=["hi mitr"],
            timeout=10,
            enable_interruptions=False,
            enable_user_speaking_frames=False,
            include_interim_transcripts=True,
        )
        detector = bot_wake_phrase.WakePhraseDetector(strategy)
        detector._task_manager = FakeTaskManager()
        pushed = []

        async def capture_push(_self, frame, direction):
            pushed.append((frame, direction))

        detector.push_frame = MethodType(capture_push, detector)

        await detector.process_frame(StartFrame(), FrameDirection.DOWNSTREAM)
        await detector.process_frame(
            TranscriptionFrame("background speech", "user", "2026-06-01T00:00:00Z"),
            FrameDirection.DOWNSTREAM,
        )
        await detector.process_frame(CancelFrame(), FrameDirection.DOWNSTREAM)

        self.assertEqual(
            [frame.__class__ for frame, _direction in pushed],
            [StartFrame, CancelFrame],
        )


class DirectGeminiLiveAudioServiceTests(unittest.IsolatedAsyncioTestCase):
    def _pcm16_frame(self, sample: int, *, samples: int = 320) -> InputAudioRawFrame:
        return InputAudioRawFrame(
            audio=sample.to_bytes(2, "little", signed=True) * samples,
            sample_rate=16000,
            num_channels=1,
        )

    async def test_user_started_speaking_queues_manual_activity_start(self):
        service = bot_wake_phrase.DirectGeminiLiveAudioService(
            auth=DeviceAuthContext(device_id="device-1", language="hi-IN"),
            output_sample_rate=24000,
        )

        async def fake_ensure_session():
            return None

        service._ensure_session = fake_ensure_session
        pushed = []

        async def capture_push(_self, frame, direction):
            pushed.append((frame, direction))

        service.push_frame = MethodType(capture_push, service)

        await service.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)

        self.assertEqual(await service._audio_queue.get(), "activity_start")
        self.assertTrue(service._user_activity_open)
        self.assertIsInstance(pushed[0][0], UserStartedSpeakingFrame)

    async def test_direct_gemini_reports_activity_for_wake_idle_refresh(self):
        activity_count = 0

        async def capture_activity():
            nonlocal activity_count
            activity_count += 1

        service = bot_wake_phrase.DirectGeminiLiveAudioService(
            auth=DeviceAuthContext(device_id="device-1", language="hi-IN"),
            output_sample_rate=24000,
            on_activity=capture_activity,
        )

        async def fake_ensure_session():
            return None

        service._ensure_session = fake_ensure_session

        async def capture_push(_self, _frame, _direction):
            return None

        service.push_frame = MethodType(capture_push, service)

        await service.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await service.process_frame(self._pcm16_frame(1000), FrameDirection.DOWNSTREAM)
        await service.process_frame(UserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)

        self.assertEqual(activity_count, 2)

    async def test_direct_gemini_ignores_duplicate_activity_start(self):
        service = bot_wake_phrase.DirectGeminiLiveAudioService(
            auth=DeviceAuthContext(device_id="device-1", language="hi-IN"),
            output_sample_rate=24000,
        )

        async def fake_ensure_session():
            return None

        service._ensure_session = fake_ensure_session
        pushed = []

        async def capture_push(_self, frame, direction):
            pushed.append((frame, direction))

        service.push_frame = MethodType(capture_push, service)

        await service.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await service.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)

        self.assertEqual(await service._audio_queue.get(), "activity_start")
        self.assertTrue(service._audio_queue.empty())
        self.assertTrue(service._user_activity_open)
        self.assertEqual(len(pushed), 2)

    async def test_direct_gemini_new_turn_after_stop_queues_activity_start(self):
        service = bot_wake_phrase.DirectGeminiLiveAudioService(
            auth=DeviceAuthContext(device_id="device-1", language="hi-IN"),
            output_sample_rate=24000,
        )

        async def fake_ensure_session():
            return None

        service._ensure_session = fake_ensure_session

        await service.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await service.process_frame(UserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await service.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)

        self.assertEqual(await service._audio_queue.get(), "activity_start")
        self.assertEqual(await service._audio_queue.get(), "activity_end")
        self.assertEqual(await service._audio_queue.get(), "activity_start")
        self.assertTrue(service._user_activity_open)

    async def test_direct_gemini_drops_manual_audio_when_user_turn_is_closed(self):
        service = bot_wake_phrase.DirectGeminiLiveAudioService(
            auth=DeviceAuthContext(device_id="device-1", language="hi-IN"),
            output_sample_rate=24000,
        )

        async def fake_ensure_session():
            raise AssertionError("inactive mic audio should not open a Gemini session")

        service._ensure_session = fake_ensure_session
        frame = InputAudioRawFrame(audio=b"\x01\x02" * 160, sample_rate=16000, num_channels=1)

        await service.process_frame(frame, FrameDirection.DOWNSTREAM)

        self.assertTrue(service._audio_queue.empty())
        self.assertEqual(service._dropped_input_while_user_inactive, 1)

    async def test_direct_gemini_server_vad_auto_starts_from_speech(self):
        saved = {
            "GEMINI_LIVE_SERVER_VAD": os.environ.get("GEMINI_LIVE_SERVER_VAD"),
            "GEMINI_LIVE_SERVER_VAD_START_MS": os.environ.get(
                "GEMINI_LIVE_SERVER_VAD_START_MS"
            ),
            "GEMINI_LIVE_SERVER_VAD_PREROLL_MS": os.environ.get(
                "GEMINI_LIVE_SERVER_VAD_PREROLL_MS"
            ),
        }
        os.environ["GEMINI_LIVE_SERVER_VAD"] = "true"
        os.environ["GEMINI_LIVE_SERVER_VAD_START_MS"] = "20"
        os.environ["GEMINI_LIVE_SERVER_VAD_PREROLL_MS"] = "80"
        try:
            service = bot_wake_phrase.DirectGeminiLiveAudioService(
                auth=DeviceAuthContext(device_id="device-1", language="hi-IN"),
                output_sample_rate=24000,
            )
        finally:
            for name, value in saved.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

        async def fake_ensure_session():
            return None

        service._ensure_session = fake_ensure_session
        pushed = []

        async def capture_push(_self, frame, direction):
            pushed.append((frame, direction))

        service.push_frame = MethodType(capture_push, service)
        speech = self._pcm16_frame(12000)

        await service.process_frame(speech, FrameDirection.DOWNSTREAM)

        self.assertEqual(await service._audio_queue.get(), "activity_start")
        self.assertIs(await service._audio_queue.get(), speech)
        self.assertTrue(service._user_activity_open)
        self.assertIsInstance(pushed[0][0], UserStartedSpeakingFrame)

    async def test_direct_gemini_server_vad_auto_stops_after_silence(self):
        saved = {
            "GEMINI_LIVE_SERVER_VAD": os.environ.get("GEMINI_LIVE_SERVER_VAD"),
            "GEMINI_LIVE_SERVER_VAD_STOP_MS": os.environ.get(
                "GEMINI_LIVE_SERVER_VAD_STOP_MS"
            ),
        }
        os.environ["GEMINI_LIVE_SERVER_VAD"] = "true"
        os.environ["GEMINI_LIVE_SERVER_VAD_STOP_MS"] = "20"
        try:
            service = bot_wake_phrase.DirectGeminiLiveAudioService(
                auth=DeviceAuthContext(device_id="device-1", language="hi-IN"),
                output_sample_rate=24000,
            )
        finally:
            for name, value in saved.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

        async def fake_ensure_session():
            return None

        service._ensure_session = fake_ensure_session
        pushed = []

        async def capture_push(_self, frame, direction):
            pushed.append((frame, direction))

        service.push_frame = MethodType(capture_push, service)
        speech = self._pcm16_frame(12000)
        silence = self._pcm16_frame(0)

        await service.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await service.process_frame(speech, FrameDirection.DOWNSTREAM)
        await service.process_frame(silence, FrameDirection.DOWNSTREAM)

        self.assertEqual(await service._audio_queue.get(), "activity_start")
        self.assertIs(await service._audio_queue.get(), speech)
        self.assertIs(await service._audio_queue.get(), silence)
        self.assertEqual(await service._audio_queue.get(), "activity_end")
        self.assertFalse(service._user_activity_open)
        self.assertIsInstance(pushed[-1][0], UserStoppedSpeakingFrame)

    async def test_direct_gemini_duplicate_stop_does_not_queue_activity_end(self):
        service = bot_wake_phrase.DirectGeminiLiveAudioService(
            auth=DeviceAuthContext(device_id="device-1", language="hi-IN"),
            output_sample_rate=24000,
        )

        async def fake_ensure_session():
            raise AssertionError("duplicate stop should not touch Gemini session")

        service._ensure_session = fake_ensure_session
        pushed = []

        async def capture_push(_self, frame, direction):
            pushed.append((frame, direction))

        service.push_frame = MethodType(capture_push, service)

        await service.process_frame(UserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)

        self.assertTrue(service._audio_queue.empty())
        self.assertEqual(len(pushed), 1)
        self.assertIsInstance(pushed[0][0], UserStoppedSpeakingFrame)

    async def test_direct_gemini_forwards_manual_audio_when_user_turn_is_open(self):
        service = bot_wake_phrase.DirectGeminiLiveAudioService(
            auth=DeviceAuthContext(device_id="device-1", language="hi-IN"),
            output_sample_rate=24000,
        )

        async def fake_ensure_session():
            return None

        service._ensure_session = fake_ensure_session
        audio = InputAudioRawFrame(audio=b"\x01\x02" * 160, sample_rate=16000, num_channels=1)

        await service.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await service.process_frame(audio, FrameDirection.DOWNSTREAM)

        self.assertEqual(await service._audio_queue.get(), "activity_start")
        self.assertIs(await service._audio_queue.get(), audio)

    async def test_direct_gemini_sleep_resets_open_turn_before_next_wake(self):
        service = bot_wake_phrase.DirectGeminiLiveAudioService(
            auth=DeviceAuthContext(device_id="device-1", language="hi-IN"),
            output_sample_rate=24000,
        )

        async def fake_ensure_session():
            return None

        service._ensure_session = fake_ensure_session

        async def capture_push(_self, _frame, _direction):
            return None

        service.push_frame = MethodType(capture_push, service)

        await service.set_awake(True)
        await service.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        await service.process_frame(self._pcm16_frame(1000), FrameDirection.DOWNSTREAM)
        await service.set_awake(False)
        await service.set_awake(True)
        await service.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)

        self.assertEqual(await service._audio_queue.get(), "activity_end")
        self.assertEqual(await service._audio_queue.get(), "activity_start")
        self.assertTrue(service._user_activity_open)

    async def test_direct_gemini_batches_input_audio_before_send(self):
        service = bot_wake_phrase.DirectGeminiLiveAudioService(
            auth=DeviceAuthContext(device_id="device-1", language="hi-IN"),
            output_sample_rate=24000,
        )

        class Blob:
            def __init__(self, data, mime_type):
                self.data = data
                self.mime_type = mime_type

        class Session:
            def __init__(self):
                self.events = []

            async def send_realtime_input(self, **kwargs):
                self.events.append(kwargs)

        session = Session()
        types = type("Types", (), {"Blob": Blob})
        task = asyncio.create_task(service._send_audio(session, types))
        await service._audio_queue.put(
            InputAudioRawFrame(audio=b"\x01\x02" * 160, sample_rate=16000, num_channels=1)
        )
        await service._audio_queue.put(
            InputAudioRawFrame(audio=b"\x03\x04" * 160, sample_rate=16000, num_channels=1)
        )
        await service._audio_queue.put(None)
        await asyncio.wait_for(task, timeout=1)

        self.assertEqual(len(session.events), 1)
        self.assertEqual(len(session.events[0]["audio"].data), 640)
        self.assertEqual(session.events[0]["audio"].mime_type, "audio/pcm;rate=16000")

    async def test_direct_gemini_batches_backlogged_input_audio_more_coarsely(self):
        saved = os.environ.get("GEMINI_LIVE_BACKLOG_INPUT_BATCH_MS")
        os.environ["GEMINI_LIVE_BACKLOG_INPUT_BATCH_MS"] = "240"
        try:
            service = bot_wake_phrase.DirectGeminiLiveAudioService(
                auth=DeviceAuthContext(device_id="device-1", language="hi-IN"),
                output_sample_rate=24000,
            )
        finally:
            if saved is None:
                os.environ.pop("GEMINI_LIVE_BACKLOG_INPUT_BATCH_MS", None)
            else:
                os.environ["GEMINI_LIVE_BACKLOG_INPUT_BATCH_MS"] = saved

        class Blob:
            def __init__(self, data, mime_type):
                self.data = data
                self.mime_type = mime_type

        class Session:
            def __init__(self):
                self.events = []

            async def send_realtime_input(self, **kwargs):
                self.events.append(kwargs)

        session = Session()
        types = type("Types", (), {"Blob": Blob})
        frames = [
            InputAudioRawFrame(
                audio=bytes([index]) * 640,
                sample_rate=16000,
                num_channels=1,
            )
            for index in range(1, 9)
        ]
        for frame in frames:
            await service._audio_queue.put(frame)
        await service._audio_queue.put(None)

        task = asyncio.create_task(service._send_audio(session, types))
        await asyncio.wait_for(task, timeout=1)

        self.assertEqual(len(session.events), 1)
        self.assertEqual(len(session.events[0]["audio"].data), 5120)

    async def test_direct_receive_outputs_native_24khz_without_resampling(self):
        service = bot_wake_phrase.DirectGeminiLiveAudioService(
            auth=DeviceAuthContext(device_id="device-1", language="hi-IN"),
            output_sample_rate=24000,
        )
        await service.set_awake(True)
        pushed = []

        async def capture_push(_self, frame, direction):
            pushed.append((frame, direction))
            service._closed = True

        service.push_frame = MethodType(capture_push, service)

        class Message:
            data = b"\x01\x02"

        class Receive:
            async def __aiter__(self):
                yield Message()

        class Session:
            def receive(self):
                return Receive()

        await service._receive_audio(Session())

        self.assertEqual(len(pushed), 1)
        self.assertIsInstance(pushed[0][0], OutputAudioRawFrame)
        self.assertEqual(pushed[0][0].sample_rate, 24000)

    async def test_direct_receive_handles_gemini_tool_call_with_function_response(self):
        service = bot_wake_phrase.DirectGeminiLiveAudioService(
            auth=DeviceAuthContext(device_id="device-1", language="hi-IN"),
            output_sample_rate=24000,
        )
        response_sent = asyncio.Event()

        class FunctionCall:
            id = "call-1"
            name = "daily_briefing_get"
            args = {}

        class ToolCall:
            function_calls = [FunctionCall()]

        class Message:
            data = None
            tool_call = ToolCall()

        class Receive:
            async def __aiter__(self):
                yield Message()
                service._closed = True

        class Session:
            def __init__(self):
                self.responses = []

            def receive(self):
                return Receive()

            async def send_tool_response(self, *, function_responses):
                self.responses.extend(function_responses)
                response_sent.set()

        class FunctionResponse:
            def __init__(self, *, id, name, response):
                self.id = id
                self.name = name
                self.response = response

        Types = type("Types", (), {"FunctionResponse": FunctionResponse})

        session = Session()
        await service._receive_audio(session, Types)
        await asyncio.wait_for(response_sent.wait(), timeout=1)

        self.assertEqual(len(session.responses), 1)
        self.assertEqual(session.responses[0].id, "call-1")
        self.assertEqual(session.responses[0].name, "daily_briefing_get")
        self.assertIn("output", session.responses[0].response)

    async def test_direct_gemini_failed_memory_lookup_returns_spoken_output_payload(self):
        service = bot_wake_phrase.DirectGeminiLiveAudioService(
            auth=DeviceAuthContext(device_id="device-1", language="hi-IN"),
            output_sample_rate=24000,
        )

        class FunctionCall:
            id = "call-1"
            name = "mem0_memory_search"
            args = {"query": "workout plan"}

        class FunctionResponse:
            def __init__(self, *, id, name, response):
                self.id = id
                self.name = name
                self.response = response

        Types = type("Types", (), {"FunctionResponse": FunctionResponse})

        async def fake_execute_tool(*_args, **_kwargs):
            return {
                "ok": False,
                "tool": "mem0_memory_search",
                "status": "backend_required",
                "error": "verified backend required",
            }

        with patch.object(bot_wake_phrase, "execute_gemini_live_tool", new=fake_execute_tool):
            response = await service._run_single_tool_call(Types, FunctionCall())

        self.assertNotIn("error", response.response)
        payload = response.response["output"]
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["status"], "backend_required")
        self.assertIn("saved memory", payload["userSafeMessage"])
        self.assertIn("Do not guess", payload["spokenInstruction"])

    async def test_direct_receive_emits_first_audio_latency_event(self):
        latency_events = []
        latency_event_received = asyncio.Event()

        async def capture_latency(payload):
            latency_events.append(payload)
            latency_event_received.set()

        service = bot_wake_phrase.DirectGeminiLiveAudioService(
            auth=DeviceAuthContext(device_id="device-1", language="hi-IN"),
            output_sample_rate=24000,
            on_latency_event=capture_latency,
        )
        await service.set_awake(True)
        now = time.perf_counter()
        service._turn_started_at = now - 0.5
        service._first_input_at = now - 0.45
        service._last_input_at = now - 0.15
        service._first_audio_sent_at = now - 0.4
        service._last_audio_sent_at = now - 0.1
        service._last_user_stop_at = now - 0.12
        service._activity_end_sent_at = now - 0.08
        service._input_audio_frames = 7
        pushed = []

        async def capture_push(_self, frame, direction):
            pushed.append((frame, direction))
            service._closed = True

        service.push_frame = MethodType(capture_push, service)

        class Message:
            data = b"\x01\x02"

        class Receive:
            async def __aiter__(self):
                yield Message()

        class Session:
            def receive(self):
                return Receive()

        await service._receive_audio(Session())
        await asyncio.wait_for(latency_event_received.wait(), timeout=1)

        self.assertEqual(len(pushed), 1)
        self.assertEqual(len(latency_events), 1)
        self.assertEqual(latency_events[0]["input_frames"], 7)
        self.assertGreaterEqual(latency_events[0]["activity_end_to_first_audio_ms"], 0)
        self.assertGreaterEqual(latency_events[0]["stop_to_first_audio_ms"], 0)


if __name__ == "__main__":
    unittest.main()
