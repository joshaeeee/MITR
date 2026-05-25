import unittest

from mitr_pipecat_gateway.agnost import AgnostConfig, AgnostTurnRecorder
from mitr_pipecat_gateway.auth import DeviceAuthContext


class FakeAgnostClient:
    enabled = True

    def __init__(self):
        self.sessions = []
        self.events = []

    async def post_session(self, payload):
        self.sessions.append(payload)
        return True

    async def post_event(self, payload):
        self.events.append(payload)
        return True


class AgnostTurnRecorderTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.auth = DeviceAuthContext(
            device_id="device-1",
            user_id="user-1",
            family_id="family-1",
            elder_id="elder-1",
            language="hi-IN",
        )
        self.config = AgnostConfig(
            enabled=True,
            org_id="org-1",
            base_url="https://api.agnost.ai/api/v1",
            timeout_ms=1000,
            client_config="reca-voice@test",
            agent_name="reca-agent",
            max_payload_chars=12000,
        )

    async def test_records_session_and_merged_turn_with_tool_child(self):
        client = FakeAgnostClient()
        recorder = AgnostTurnRecorder(
            auth=self.auth,
            config=self.config,
            client=client,
            session_id="session-1",
        )

        await recorder.begin_user_turn("Reca, satsang shuru karo", timestamp_ms=1000)
        recorder.append_assistant_text("Theek hai. ")
        recorder.record_tool_event(
            name="flow_start",
            args={"mode": "satsang", "language": "hi-IN"},
            result={"ok": True, "flow_id": "flow-1"},
            success=True,
            latency_ms=250,
            timestamp_ms=1200,
        )
        recorder.append_assistant_text("Aaj hum dheere shuru karte hain.")
        recorder.mark_turn_output_complete(timestamp_ms=2000)
        await recorder.flush_pending_turn()

        self.assertEqual(len(client.sessions), 1)
        self.assertEqual(client.sessions[0]["session_id"], "session-1")
        self.assertEqual(client.sessions[0]["user_data"]["user_id"], "user-1")

        self.assertEqual(len(client.events), 2)
        agent_event = client.events[0]
        tool_event = client.events[1]
        self.assertEqual(agent_event["primitive_name"], "reca-agent")
        self.assertEqual(agent_event["args"], "Reca, satsang shuru karo")
        self.assertEqual(
            agent_event["result"],
            "Theek hai. Aaj hum dheere shuru karte hain.",
        )
        self.assertEqual(agent_event["latency"], 1000)
        self.assertEqual(tool_event["primitive_name"], "flow_start")
        self.assertEqual(tool_event["parent_id"], agent_event["event_id"])
        self.assertIn('"mode": "satsang"', tool_event["args"])
        self.assertIn('"flow_id": "flow-1"', tool_event["result"])
        self.assertEqual(tool_event["latency"], 250)

    async def test_next_user_turn_flushes_previous_turn(self):
        client = FakeAgnostClient()
        recorder = AgnostTurnRecorder(
            auth=self.auth,
            config=self.config,
            client=client,
            session_id="session-1",
        )

        await recorder.begin_user_turn("Pehla sawaal", timestamp_ms=1000)
        recorder.append_assistant_text("Pehla jawab")
        recorder.mark_turn_output_complete(timestamp_ms=1300)
        await recorder.begin_user_turn("Doosra sawaal", timestamp_ms=2000)

        self.assertEqual(len(client.events), 1)
        self.assertEqual(client.events[0]["args"], "Pehla sawaal")
        self.assertEqual(client.events[0]["result"], "Pehla jawab")

    async def test_disabled_config_does_not_emit(self):
        client = FakeAgnostClient()
        client.enabled = False
        config = AgnostConfig(
            enabled=False,
            org_id="",
            base_url="https://api.agnost.ai/api/v1",
            timeout_ms=1000,
            client_config="reca-voice@test",
            agent_name="reca-agent",
            max_payload_chars=12000,
        )
        recorder = AgnostTurnRecorder(
            auth=self.auth,
            config=config,
            client=client,
            session_id="session-1",
        )

        await recorder.begin_user_turn("Hello")
        recorder.append_assistant_text("Hi")
        await recorder.close()

        self.assertEqual(client.sessions, [])
        self.assertEqual(client.events, [])


if __name__ == "__main__":
    unittest.main()
