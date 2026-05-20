import os
import unittest

from pipecat.frames.frames import OutputAudioRawFrame

from mitr_pipecat_gateway.serializer import Esp32PCMSerializer


class Esp32PCMSerializerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self._saved_gain = os.environ.get("ESP32_AUDIO_OUTPUT_GAIN")

    def tearDown(self):
        if self._saved_gain is None:
            os.environ.pop("ESP32_AUDIO_OUTPUT_GAIN", None)
        else:
            os.environ["ESP32_AUDIO_OUTPUT_GAIN"] = self._saved_gain

    async def test_output_gain_applies_pcm16_headroom_without_latency_buffering(self):
        os.environ["ESP32_AUDIO_OUTPUT_GAIN"] = "0.5"
        serializer = Esp32PCMSerializer()
        audio = (
            int(10000).to_bytes(2, "little", signed=True)
            + int(-10000).to_bytes(2, "little", signed=True)
        )

        serialized = await serializer.serialize(
            OutputAudioRawFrame(audio=audio, sample_rate=16000, num_channels=1)
        )

        self.assertEqual(
            serialized,
            int(5000).to_bytes(2, "little", signed=True)
            + int(-5000).to_bytes(2, "little", signed=True),
        )


if __name__ == "__main__":
    unittest.main()
