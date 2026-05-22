import asyncio
import unittest

from mitr_pipecat_gateway.bot_wake_phrase import ToolActivityState


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


if __name__ == "__main__":
    unittest.main()
