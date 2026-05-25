import asyncio
import os
import unittest
from unittest.mock import patch

from mitr_pipecat_gateway import tools
from mitr_pipecat_gateway.auth import DeviceAuthContext


class DummyLLM:
    def __init__(self):
        self.registrations = {}
        self.pushed_frames = []

    def register_function(self, name, handler, *, cancel_on_interruption, timeout_secs):
        self.registrations[name] = {
            "handler": handler,
            "cancel_on_interruption": cancel_on_interruption,
            "timeout_secs": timeout_secs,
        }

    async def push_frame(self, frame, direction=None):
        self.pushed_frames.append((frame, direction))


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

    def test_result_bearing_tools_are_sync_by_default(self):
        self.assertFalse(tools._tool_execution_policy("memory_add").async_ack)
        self.assertFalse(tools._tool_execution_policy("reminder_create").async_ack)
        self.assertFalse(tools._tool_execution_policy("news_retrieve").async_ack)
        self.assertFalse(tools._tool_execution_policy("web_search").async_ack)

    def test_swiggy_tools_return_native_tool_results_by_default(self):
        self.assertFalse(tools._tool_execution_policy("swiggy_auth_status").async_ack)
        self.assertFalse(tools._tool_execution_policy("swiggy_get_addresses").async_ack)
        self.assertFalse(tools._tool_execution_policy("swiggy_select_delivery_address").async_ack)
        self.assertFalse(tools._tool_execution_policy("swiggy_mcp_call").async_ack)

    def test_internal_context_tools_stay_sync_by_default(self):
        self.assertFalse(tools._tool_execution_policy("context_packet_get").async_ack)
        self.assertFalse(tools._tool_execution_policy("context_memory_add").async_ack)
        self.assertFalse(tools._tool_execution_policy("conversation_planner_get").async_ack)
        self.assertFalse(tools._tool_execution_policy("prompt_outcome_record").async_ack)

    def test_registers_default_tools_as_interruptible_sync_pipecat_functions(self):
        llm = DummyLLM()
        auth = DeviceAuthContext(
            device_id="device-1",
            user_id="user-1",
            family_id="family-1",
            elder_id="elder-1",
            language="hi-IN",
        )

        tools.register_mitr_tools(llm, auth, None)

        self.assertTrue(llm.registrations["memory_add"]["cancel_on_interruption"])
        self.assertTrue(llm.registrations["reminder_create"]["cancel_on_interruption"])
        self.assertTrue(llm.registrations["news_retrieve"]["cancel_on_interruption"])
        self.assertTrue(llm.registrations["web_search"]["cancel_on_interruption"])
        self.assertTrue(llm.registrations["swiggy_auth_status"]["cancel_on_interruption"])
        self.assertTrue(llm.registrations["context_packet_get"]["cancel_on_interruption"])

    def test_sync_tool_handler_sends_finished_callback_and_forces_followup(self):
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

        Params.llm = llm

        async def fake_execute_tool(name, args, auth_context):
            self.assertEqual(name, "memory_add")
            self.assertEqual(args["text"], "I like morning walks")
            self.assertEqual(auth_context.device_id, "device-1")
            return {"ok": True, "memoryId": "memory-1"}

        os.environ["MITR_GATEWAY_TOOL_FOLLOWUP_MIN_DELAY_SEC"] = "0"
        tools.register_mitr_tools(llm, auth, None)

        with patch.object(tools, "_execute_tool", new=fake_execute_tool):
            asyncio.run(llm.registrations["memory_add"]["handler"](Params()))

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0]["memoryId"], "memory-1")
        self.assertFalse(calls[0][1].run_llm)
        self.assertIsNotNone(calls[0][1].on_context_updated)
        asyncio.run(calls[0][1].on_context_updated())
        self.assertEqual(llm.pushed_frames[0][0].__class__.__name__, "LLMRunFrame")

    def test_swiggy_handler_returns_normalized_native_tool_result(self):
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
            function_name = "swiggy_get_addresses"
            arguments = {}

            async def result_callback(self, result, properties=None):
                calls.append((result, properties))

        Params.llm = llm

        async def fake_execute_tool(name, args, auth_context):
            self.assertEqual(name, "swiggy_get_addresses")
            return {
                "ok": True,
                "tool": name,
                "result": {
                    "jsonrpc": "2.0",
                    "result": {
                        "status": "ready",
                        "addresses": [{"addressId": "stub-home", "label": "Home"}],
                    },
                },
            }

        os.environ["MITR_GATEWAY_TOOL_FOLLOWUP_MIN_DELAY_SEC"] = "0"
        tools.register_mitr_tools(llm, auth, None)

        with patch.object(tools, "_execute_tool", new=fake_execute_tool):
            asyncio.run(llm.registrations["swiggy_get_addresses"]["handler"](Params()))

        self.assertEqual([call[0]["status"] for call in calls], ["finished"])
        self.assertFalse(calls[0][1].run_llm)
        self.assertIsNotNone(calls[0][1].on_context_updated)
        asyncio.run(calls[0][1].on_context_updated())
        self.assertEqual(llm.pushed_frames[0][0].__class__.__name__, "LLMRunFrame")
        self.assertEqual(calls[0][0]["swiggy"]["addressCount"], 1)
        self.assertEqual(calls[0][0]["swiggy"]["nextAction"], "ask_user_to_choose_address")
        self.assertIn("ask the user to choose one", calls[0][0]["message"])

    def test_reca_skill_get_sync_result_forces_followup_llm_run(self):
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
            function_name = "reca_skill_get"
            arguments = {"skillName": "memory_protocol"}

            async def result_callback(self, result, properties=None):
                calls.append((result, properties))

        Params.llm = llm

        async def fake_execute_tool(name, args, auth_context):
            self.assertEqual(name, "reca_skill_get")
            return {
                "ok": True,
                "skillName": "memory_protocol",
                "format": "markdown",
                "content": "Generate the artifact, then save it.",
            }

        tools.register_mitr_tools(llm, auth, None)

        with patch.object(tools, "_execute_tool", new=fake_execute_tool):
            asyncio.run(llm.registrations["reca_skill_get"]["handler"](Params()))

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0]["status"], "finished")
        self.assertFalse(calls[0][0]["acknowledgementOnly"])
        self.assertIn("generate the user's requested artifact", calls[0][0]["message"])
        self.assertEqual(calls[0][0]["result"]["skillName"], "memory_protocol")
        self.assertFalse(calls[0][1].run_llm)
        self.assertIsNotNone(calls[0][1].on_context_updated)
        asyncio.run(calls[0][1].on_context_updated())
        self.assertEqual(llm.pushed_frames[0][0].__class__.__name__, "LLMRunFrame")

    def test_swiggy_finished_callback_prompts_next_workflow_step(self):
        result = tools._finished_tool_result(
            "swiggy_auth_status",
            {},
            DeviceAuthContext(
                device_id="device-1",
                user_id="user-1",
                family_id="family-1",
                elder_id="elder-1",
                language="hi-IN",
            ),
            {"ok": True, "result": {"connected": True, "selectedAddress": None}},
        )

        self.assertIn("Immediately call swiggy_get_addresses", result["message"])
        self.assertIn("Do not ask for order confirmation", result["message"])
        self.assertIn("Do not say confirmation is missing", result["message"])
        self.assertTrue(result["swiggy"]["mustRespond"])
        self.assertEqual(result["swiggy"]["nextAction"], "call_swiggy_get_addresses")
        self.assertEqual(result["swiggy"]["nextTool"], "swiggy_get_addresses")
        self.assertFalse(result["swiggy"]["speakToUser"])

    def test_swiggy_auth_with_selected_address_continues_or_clarifies(self):
        result = tools._finished_tool_result(
            "swiggy_auth_status",
            {},
            DeviceAuthContext(
                device_id="device-1",
                user_id="user-1",
                family_id="family-1",
                elder_id="elder-1",
                language="hi-IN",
            ),
            {
                "ok": True,
                "result": {
                    "connected": True,
                    "selectedAddress": {"addressId": "stub-home", "label": "Home"},
                },
            },
        )

        self.assertIn("ask one short clarification question", result["message"])
        self.assertEqual(
            result["swiggy"]["nextAction"],
            "continue_original_ordering_request_or_ask_missing_details",
        )
        self.assertIsNone(result["swiggy"]["nextTool"])
        self.assertTrue(result["swiggy"]["speakToUser"])

    def test_swiggy_address_result_is_normalized_for_model(self):
        result = tools._finished_tool_result(
            "swiggy_get_addresses",
            {},
            DeviceAuthContext(
                device_id="device-1",
                user_id="user-1",
                family_id="family-1",
                elder_id="elder-1",
                language="hi-IN",
            ),
            {
                "ok": True,
                "tool": "swiggy_get_addresses",
                "result": {
                    "jsonrpc": "2.0",
                    "result": {
                        "status": "ready",
                        "addresses": [
                            {
                                "addressId": "stub-home",
                                "label": "Home",
                                "displayText": "Home, Koramangala 5th Block, Bengaluru",
                            }
                        ],
                    },
                },
            },
        )

        self.assertEqual(result["swiggy"]["addressCount"], 1)
        self.assertEqual(result["swiggy"]["addresses"][0]["label"], "Home")
        self.assertEqual(result["swiggy"]["nextAction"], "ask_user_to_choose_address")
        self.assertIsNone(result["swiggy"]["nextTool"])
        self.assertTrue(result["swiggy"]["speakToUser"])
        self.assertIn("ask the user to choose one", result["message"])
        self.assertIn("Do not ask for order confirmation yet", result["message"])

    def test_async_tool_acknowledgements_can_be_disabled(self):
        os.environ["MITR_GATEWAY_ASYNC_TOOL_ACKS"] = "false"

        self.assertFalse(tools._tool_execution_policy("memory_add").async_ack)

    def test_async_tool_acknowledgements_can_be_enabled_explicitly(self):
        os.environ["MITR_GATEWAY_ASYNC_ACK_TOOLS"] = "memory_add"

        self.assertTrue(tools._tool_execution_policy("memory_add").async_ack)

    def test_tool_end_hook_receives_args_result_success_and_latency(self):
        llm = DummyLLM()
        auth = DeviceAuthContext(
            device_id="device-1",
            user_id="user-1",
            family_id="family-1",
            elder_id="elder-1",
            language="hi-IN",
        )
        end_calls = []

        class Params:
            function_name = "context_packet_get"
            arguments = {"triggerType": "manual"}

            async def result_callback(self, result, properties=None):
                return None

        async def fake_execute_tool(name, args, auth_context):
            return {"ok": True, "packet": "ready"}

        async def on_tool_end(name, args, result, success, latency_ms):
            end_calls.append((name, args, result, success, latency_ms))

        tools.register_mitr_tools(llm, auth, None, on_tool_end=on_tool_end)

        with patch.object(tools, "_execute_tool", new=fake_execute_tool):
            asyncio.run(llm.registrations["context_packet_get"]["handler"](Params()))

        self.assertEqual(len(end_calls), 1)
        name, args, result, success, latency_ms = end_calls[0]
        self.assertEqual(name, "context_packet_get")
        self.assertEqual(args, {"triggerType": "manual"})
        self.assertEqual(result, {"ok": True, "packet": "ready"})
        self.assertTrue(success)
        self.assertGreaterEqual(latency_ms, 0)


if __name__ == "__main__":
    unittest.main()
