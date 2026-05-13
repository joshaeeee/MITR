import os
import unittest

from mitr_pipecat_gateway import bot_wake_phrase


class WakePhraseConfigTests(unittest.TestCase):
    def setUp(self):
        self._saved_env = {
            "MITR_GATEWAY_WAKE_PHRASES": os.environ.get("MITR_GATEWAY_WAKE_PHRASES"),
            "OPENAI_REALTIME_TURN_DETECTION": os.environ.get("OPENAI_REALTIME_TURN_DETECTION"),
        }

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


if __name__ == "__main__":
    unittest.main()
