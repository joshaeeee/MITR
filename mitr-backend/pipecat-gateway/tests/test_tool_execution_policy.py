import asyncio
import os
import unittest
from unittest.mock import patch

from mitr_pipecat_gateway import tools
from mitr_pipecat_gateway.auth import DeviceAuthContext


class DummyLLM:
    def __init__(self):
        self.registrations = {}

    def register_function(self, name, handler, *, cancel_on_interruption, timeout_secs):
        self.registrations[name] = {
            "handler": handler,
            "cancel_on_interruption": cancel_on_interruption,
            "timeout_secs": timeout_secs,
        }


class ToolExecutionPolicyTests(unittest.TestCase):
    def setUp(self):
        self._saved_env = {
            "MITR_GATEWAY_ASYNC_TOOL_ACKS": os.environ.get("MITR_GATEWAY_ASYNC_TOOL_ACKS"),
            "MITR_GATEWAY_ASYNC_ACK_TOOLS": os.environ.get("MITR_GATEWAY_ASYNC_ACK_TOOLS"),
            "MITR_GATEWAY_ACK_BEFORE_TOOLS": os.environ.get("MITR_GATEWAY_ACK_BEFORE_TOOLS"),
            "MITR_GATEWAY_SYNC_TOOLS": os.environ.get("MITR_GATEWAY_SYNC_TOOLS"),
            "MITR_GATEWAY_TOOL_TIMEOUT_SEC": os.environ.get("MITR_GATEWAY_TOOL_TIMEOUT_SEC"),
        }
        for key in self._saved_env:
            os.environ.pop(key, None)

    def tearDown(self):
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_user_visible_write_tools_ack_as_async_by_default(self):
        self.assertTrue(tools._tool_execution_policy("memory_add").async_ack)
        self.assertTrue(tools._tool_execution_policy("reminder_create").async_ack)

    def test_internal_context_tools_stay_sync_by_default(self):
        self.assertFalse(tools._tool_execution_policy("context_packet_get").async_ack)
        self.assertFalse(tools._tool_execution_policy("context_memory_add").async_ack)
        self.assertFalse(tools._tool_execution_policy("conversation_planner_get").async_ack)
        self.assertFalse(tools._tool_execution_policy("prompt_outcome_record").async_ack)

    def test_registers_async_tools_as_non_interruptible_pipecat_functions(self):
        llm = DummyLLM()
        auth = DeviceAuthContext(
            device_id="device-1",
            user_id="user-1",
            family_id="family-1",
            elder_id="elder-1",
            language="hi-IN",
        )

        tools.register_mitr_tools(llm, auth, None)

        self.assertFalse(llm.registrations["memory_add"]["cancel_on_interruption"])
        self.assertFalse(llm.registrations["reminder_create"]["cancel_on_interruption"])
        self.assertTrue(llm.registrations["context_packet_get"]["cancel_on_interruption"])

    def test_async_tool_handler_sends_started_and_finished_callbacks(self):
        llm = DummyLLM()
        auth = DeviceAuthContext(
            device_id="device-1",
            user_id="user-1",
            family_id="family-1",
            elder_id="elder-1",
            language="hi-IN",
        )
        calls = []

        class Params:
            function_name = "memory_add"
            arguments = {"text": "I like morning walks"}

            async def result_callback(self, result, properties=None):
                calls.append((result, properties))

        async def fake_execute_tool(name, args, auth_context):
            self.assertEqual(name, "memory_add")
            self.assertEqual(args["text"], "I like morning walks")
            self.assertEqual(auth_context.device_id, "device-1")
            return {"ok": True, "memoryId": "memory-1"}

        os.environ["MITR_GATEWAY_TOOL_FOLLOWUP_MIN_DELAY_SEC"] = "0"
        tools.register_mitr_tools(llm, auth, None)

        with patch.object(tools, "_execute_tool", new=fake_execute_tool):
            asyncio.run(llm.registrations["memory_add"]["handler"](Params()))

        self.assertEqual([call[0]["status"] for call in calls], ["started", "finished"])
        self.assertTrue(calls[0][0]["acknowledgementOnly"])
        self.assertFalse(calls[1][0]["acknowledgementOnly"])
        self.assertFalse(calls[0][1].is_final)
        self.assertTrue(calls[0][1].run_llm)
        self.assertTrue(calls[1][1].run_llm)
        self.assertEqual(calls[1][0]["result"]["memoryId"], "memory-1")

    def test_async_tool_acknowledgements_can_be_disabled(self):
        os.environ["MITR_GATEWAY_ASYNC_TOOL_ACKS"] = "false"

        self.assertFalse(tools._tool_execution_policy("memory_add").async_ack)


if __name__ == "__main__":
    unittest.main()
