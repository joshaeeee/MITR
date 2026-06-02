import os
import unittest

from mitr_pipecat_gateway.auth import authenticate_websocket


class FakeWebSocket:
    def __init__(self, *, headers=None, query_params=None):
        self.headers = headers or {}
        self.query_params = query_params or {}


class AuthenticateWebsocketTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._old_auth_mode = os.environ.get("MITR_GATEWAY_AUTH_MODE")
        self._old_local_device_id = os.environ.get("MITR_GATEWAY_LOCAL_DEVICE_ID")

    async def asyncTearDown(self):
        if self._old_auth_mode is None:
            os.environ.pop("MITR_GATEWAY_AUTH_MODE", None)
        else:
            os.environ["MITR_GATEWAY_AUTH_MODE"] = self._old_auth_mode
        if self._old_local_device_id is None:
            os.environ.pop("MITR_GATEWAY_LOCAL_DEVICE_ID", None)
        else:
            os.environ["MITR_GATEWAY_LOCAL_DEVICE_ID"] = self._old_local_device_id

    async def test_local_auth_allows_matching_device_without_bearer_token(self):
        os.environ["MITR_GATEWAY_AUTH_MODE"] = "local"
        os.environ["MITR_GATEWAY_LOCAL_DEVICE_ID"] = "web-sim-device"
        websocket = FakeWebSocket(
            query_params={
                "deviceId": "web-sim-device",
                "language": "hi-IN",
                "timezone": "Asia/Kolkata",
                "client": "web",
            },
        )

        auth = await authenticate_websocket(websocket)

        self.assertEqual(auth.device_id, "web-sim-device")
        self.assertEqual(auth.language, "hi-IN")
        self.assertEqual(auth.timezone, "Asia/Kolkata")

    async def test_non_local_auth_still_requires_bearer_token(self):
        os.environ["MITR_GATEWAY_AUTH_MODE"] = "backend"
        websocket = FakeWebSocket(query_params={"deviceId": "web-sim-device"})

        with self.assertRaisesRegex(PermissionError, "missing bearer token"):
            await authenticate_websocket(websocket)
