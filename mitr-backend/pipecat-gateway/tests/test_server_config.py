import os
import unittest

from mitr_pipecat_gateway import server


class ServerConfigTests(unittest.TestCase):
    def setUp(self):
        self._saved_env = {
            "ESP32_AUDIO_OUT_SAMPLE_RATE": os.environ.get("ESP32_AUDIO_OUT_SAMPLE_RATE"),
            "MITR_GATEWAY_REALTIME_PROVIDER": os.environ.get("MITR_GATEWAY_REALTIME_PROVIDER"),
        }
        for key in self._saved_env:
            os.environ.pop(key, None)

    def tearDown(self):
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_ready_audio_out_defaults_to_24khz_for_gemini(self):
        os.environ["MITR_GATEWAY_REALTIME_PROVIDER"] = "gemini_live"

        self.assertEqual(server._default_audio_out_sample_rate(), 24000)

    def test_ready_audio_out_keeps_16khz_for_openai(self):
        self.assertEqual(server._default_audio_out_sample_rate(), 16000)

    def test_ready_audio_out_env_override_wins(self):
        os.environ["MITR_GATEWAY_REALTIME_PROVIDER"] = "gemini_live"
        os.environ["ESP32_AUDIO_OUT_SAMPLE_RATE"] = "16000"

        self.assertEqual(server._default_audio_out_sample_rate(), 16000)


if __name__ == "__main__":
    unittest.main()
