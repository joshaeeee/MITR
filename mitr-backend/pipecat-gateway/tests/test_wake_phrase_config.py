import os
import unittest
from types import MethodType

from pipecat.frames.frames import (
    InputAudioRawFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection

from mitr_pipecat_gateway import bot, bot_wake_phrase
from mitr_pipecat_gateway.auth import DeviceAuthContext


class WakePhraseConfigTests(unittest.TestCase):
    def setUp(self):
        self._saved_env = {
            "MITR_GATEWAY_WAKE_PHRASES": os.environ.get("MITR_GATEWAY_WAKE_PHRASES"),
            "OPENAI_REALTIME_TURN_DETECTION": os.environ.get("OPENAI_REALTIME_TURN_DETECTION"),
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

    def test_realtime_turn_detection_must_be_manual(self):
        os.environ["OPENAI_REALTIME_TURN_DETECTION"] = "manual"
        self.assertFalse(bot_wake_phrase._openai_turn_detection())

        os.environ["OPENAI_REALTIME_TURN_DETECTION"] = "server_vad"
        with self.assertRaises(RuntimeError):
            bot_wake_phrase._openai_turn_detection()

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

    def test_unicode_wake_phrase_alias_patterns_stay_aligned_with_phrases(self):
        strategy = bot_wake_phrase.UnicodeWakePhraseUserTurnStartStrategy(phrases=["hi reca"])

        self.assertEqual(len(strategy._patterns), len(strategy._phrases))
        alias_index = strategy._phrases.index("हे रेका")
        self.assertRegex("हे रेका", strategy._patterns[alias_index])

    def test_realtime2_session_options_are_explicit(self):
        os.environ["OPENAI_REALTIME_REASONING_EFFORT"] = "low"
        os.environ["OPENAI_REALTIME_TRUNCATION"] = "auto"

        self.assertEqual(
            bot._openai_realtime2_session_extra_fields("gpt-realtime-2"),
            {"reasoning": {"effort": "low"}, "truncation": "auto"},
        )

    def test_realtime2_session_options_reject_non_realtime2_models(self):
        os.environ["OPENAI_REALTIME_REASONING_EFFORT"] = "low"

        with self.assertRaises(RuntimeError):
            bot._openai_realtime2_session_extra_fields("gpt-realtime")

    def test_realtime2_retention_ratio_truncation(self):
        os.environ["OPENAI_REALTIME_TRUNCATION"] = "retention_ratio"
        os.environ["OPENAI_REALTIME_TRUNCATION_RETENTION_RATIO"] = "0.8"
        os.environ["OPENAI_REALTIME_TRUNCATION_POST_INSTRUCTIONS_TOKEN_LIMIT"] = "8000"

        self.assertEqual(
            bot._openai_realtime2_session_extra_fields("gpt-realtime-2"),
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
            bot._openai_realtime2_session_extra_fields("gpt-realtime-2")

    def test_realtime2_token_limit_requires_retention_ratio(self):
        os.environ["OPENAI_REALTIME_TRUNCATION_POST_INSTRUCTIONS_TOKEN_LIMIT"] = "8000"

        with self.assertRaises(RuntimeError):
            bot._openai_realtime2_session_extra_fields("gpt-realtime-2")

    def test_context_summarization_uses_pipecat_auto_defaults_with_dedicated_llm(self):
        params = bot._context_summarization_assistant_params("test-openai-key")

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

        params = bot._context_summarization_assistant_params("test-openai-key")

        self.assertFalse(params.enable_auto_context_summarization)
        self.assertIsNone(params.auto_context_summarization_config)

    def test_context_summarization_env_overrides_thresholds(self):
        os.environ["MITR_GATEWAY_CONTEXT_SUMMARY_MODEL"] = "gpt-4.1"
        os.environ["MITR_GATEWAY_CONTEXT_SUMMARY_MAX_CONTEXT_TOKENS"] = "12000"
        os.environ["MITR_GATEWAY_CONTEXT_SUMMARY_MAX_UNSUMMARIZED_MESSAGES"] = "12"
        os.environ["MITR_GATEWAY_CONTEXT_SUMMARY_TARGET_TOKENS"] = "3000"
        os.environ["MITR_GATEWAY_CONTEXT_SUMMARY_KEEP_MESSAGES"] = "6"
        os.environ["MITR_GATEWAY_CONTEXT_SUMMARY_TIMEOUT_SEC"] = "30"

        config = bot._context_summarization_assistant_params(
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
            bot._latest_context_summary_text(
                [
                    {"role": "user", "content": "Conversation summary: user wants yoga"},
                    {"role": "assistant", "content": "Sure."},
                ]
            ),
            "Conversation summary: user wants yoga",
        )

    def test_latest_context_summary_text_ignores_non_summary_messages(self):
        self.assertIsNone(
            bot._latest_context_summary_text(
                [
                    {"role": "user", "content": "hello"},
                    {"role": "assistant", "content": "hi"},
                ]
            )
        )

    def test_system_prompt_template_renders_runtime_variables(self):
        prompt = bot._system_instruction(
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


if __name__ == "__main__":
    unittest.main()
