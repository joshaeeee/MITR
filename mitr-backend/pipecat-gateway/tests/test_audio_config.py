import os
import unittest

from mitr_pipecat_gateway.bot import (
    _openai_input_noise_reduction,
    _openai_input_noise_reduction_mode,
)


class OpenAIInputNoiseReductionConfigTests(unittest.TestCase):
    def setUp(self):
        self._saved_value = os.environ.get("OPENAI_REALTIME_INPUT_NOISE_REDUCTION")

    def tearDown(self):
        if self._saved_value is None:
            os.environ.pop("OPENAI_REALTIME_INPUT_NOISE_REDUCTION", None)
        else:
            os.environ["OPENAI_REALTIME_INPUT_NOISE_REDUCTION"] = self._saved_value

    def test_noise_reduction_can_be_disabled(self):
        os.environ["OPENAI_REALTIME_INPUT_NOISE_REDUCTION"] = "off"

        self.assertIsNone(_openai_input_noise_reduction_mode())
        self.assertIsNone(_openai_input_noise_reduction())

    def test_noise_reduction_accepts_far_field(self):
        os.environ["OPENAI_REALTIME_INPUT_NOISE_REDUCTION"] = "far_field"

        self.assertEqual(_openai_input_noise_reduction_mode(), "far_field")
        self.assertEqual(_openai_input_noise_reduction().type, "far_field")

    def test_noise_reduction_rejects_unknown_values(self):
        os.environ["OPENAI_REALTIME_INPUT_NOISE_REDUCTION"] = "aggressive"

        with self.assertRaisesRegex(RuntimeError, "near_field, far_field, or off"):
            _openai_input_noise_reduction_mode()


if __name__ == "__main__":
    unittest.main()
