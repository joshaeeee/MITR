import os
import unittest

from mitr_pipecat_gateway.auth import DeviceAuthContext
from mitr_pipecat_gateway import bot, bot_wake_phrase


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

        self.assertEqual(bot_wake_phrase._strip_leading_wake_phrase("हाय ईएसपी"), ("", True))
        self.assertEqual(
            bot_wake_phrase._strip_leading_wake_phrase("हाय ईएसपी weekly plan banao"),
            ("weekly plan banao", True),
        )
        self.assertEqual(bot_wake_phrase._strip_leading_wake_phrase("हाय रेका।"), ("", True))

    def test_wake_phrase_aliases_do_not_enable_unconfigured_devices(self):
        os.environ["MITR_GATEWAY_WAKE_PHRASES"] = "hi reca"

        self.assertEqual(
            bot_wake_phrase._strip_leading_wake_phrase("हाय ईएसपी weekly plan banao"),
            ("हाय ईएसपी weekly plan banao", False),
        )

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


if __name__ == "__main__":
    unittest.main()
