import asyncio
import unittest

from pipecat.frames.frames import OutputAudioRawFrame, UserStartedSpeakingFrame
from pipecat.processors.frame_processor import FrameDirection

from mitr_pipecat_gateway.bot_wake_phrase import (
    EchoSuppressionInputGate,
    EchoSuppressionState,
    ToolActivityState,
)


class ToolActivityStateTests(unittest.TestCase):
    def test_tools_suppress_input_while_pending(self):
        state = ToolActivityState(tail_ms=0)

        asyncio.run(state.start("swiggy_auth_status"))
        self.assertTrue(state.should_drop_input())

        asyncio.run(state.finish("swiggy_auth_status"))
        self.assertFalse(state.should_drop_input())

    def test_tool_input_tail_releases_after_zero_tail(self):
        state = ToolActivityState(tail_ms=0)

        asyncio.run(state.start("memory_add"))
        asyncio.run(state.finish("memory_add"))

        self.assertFalse(state.should_drop_input())


class EchoSuppressionInputGateTests(unittest.IsolatedAsyncioTestCase):
    async def test_echo_suppression_drops_turn_controls_while_output_is_playing(self):
        echo_state = EchoSuppressionState(enabled=True, tail_ms=1000)
        tool_state = ToolActivityState(tail_ms=0)
        gate = EchoSuppressionInputGate(echo_state, tool_state)
        pushed = []

        async def capture_push(_self, frame, direction):
            pushed.append((frame, direction))

        gate.push_frame = capture_push.__get__(gate, EchoSuppressionInputGate)
        echo_state.note_output_audio(
            OutputAudioRawFrame(
                audio=b"\x00\x00" * 2400,
                sample_rate=24000,
                num_channels=1,
            )
        )

        await gate.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)

        self.assertEqual(pushed, [])


if __name__ == "__main__":
    unittest.main()
