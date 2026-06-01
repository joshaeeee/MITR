import os
import unittest

from pipecat.frames.frames import OutputAudioRawFrame, UserStartedSpeakingFrame

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

    async def test_output_gain_can_boost_pcm16(self):
        os.environ["ESP32_AUDIO_OUTPUT_GAIN"] = "2.0"
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
            int(20000).to_bytes(2, "little", signed=True)
            + int(-20000).to_bytes(2, "little", signed=True),
        )

    async def test_output_gain_clips_pcm16_after_boost(self):
        os.environ["ESP32_AUDIO_OUTPUT_GAIN"] = "3.0"
        serializer = Esp32PCMSerializer()
        audio = (
            int(20000).to_bytes(2, "little", signed=True)
            + int(-20000).to_bytes(2, "little", signed=True)
        )

        serialized = await serializer.serialize(
            OutputAudioRawFrame(audio=audio, sample_rate=16000, num_channels=1)
        )

        self.assertEqual(
            serialized,
            int(32767).to_bytes(2, "little", signed=True)
            + int(-32768).to_bytes(2, "little", signed=True),
        )

    async def test_start_control_opens_user_turn(self):
        serializer = Esp32PCMSerializer()

        frame = await serializer.deserialize('{"type":"start"}')

        self.assertIsInstance(frame, UserStartedSpeakingFrame)


if __name__ == "__main__":
    unittest.main()
