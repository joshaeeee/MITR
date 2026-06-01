import os
from dataclasses import dataclass

import httpx
from fastapi import WebSocket

AUTH_TOKEN_SUBPROTOCOL_PREFIX = "mitr-token-"
PCM16_SUBPROTOCOL = "mitr-pcm16"


@dataclass(frozen=True)
class DeviceAuthContext:
    device_id: str
    user_id: str | None = None
    user_name: str | None = None
    family_id: str | None = None
    elder_id: str | None = None
    elder_name: str | None = None
    language: str = "hi-IN"


def _bearer(headers: dict[str, str]) -> str | None:
    authorization = headers.get("authorization")
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()


def _subprotocol_token(headers: dict[str, str]) -> str | None:
    protocols = headers.get("sec-websocket-protocol", "")
    for protocol in protocols.split(","):
        value = protocol.strip()
        if value.startswith(AUTH_TOKEN_SUBPROTOCOL_PREFIX):
            token = value.removeprefix(AUTH_TOKEN_SUBPROTOCOL_PREFIX).strip()
            if token:
                return token
    return None


def select_websocket_subprotocol(websocket: WebSocket) -> str | None:
    protocols = websocket.headers.get("sec-websocket-protocol", "")
    requested = {protocol.strip() for protocol in protocols.split(",") if protocol.strip()}
    return PCM16_SUBPROTOCOL if PCM16_SUBPROTOCOL in requested else None


async def authenticate_websocket(websocket: WebSocket) -> DeviceAuthContext:
    headers = {key.lower(): value for key, value in websocket.headers.items()}
    device_id = websocket.query_params.get("deviceId") or headers.get("x-mitr-device-id") or ""
    language = websocket.query_params.get("language") or headers.get("x-mitr-language") or "hi-IN"
    client = websocket.query_params.get("client") or headers.get("x-mitr-client") or "esp32"
    if os.getenv("MITR_GATEWAY_AUTH_MODE", "").lower() == "local":
        expected_device_id = os.getenv("MITR_GATEWAY_LOCAL_DEVICE_ID", "").strip()
        if expected_device_id and device_id != expected_device_id:
            raise PermissionError("local auth rejected device id")
        if not device_id:
            raise PermissionError("local auth requires device id")
        return DeviceAuthContext(
            device_id=device_id,
            user_id=None,
            user_name=None,
            family_id=None,
            elder_id=None,
            elder_name=None,
            language=language,
        )

    token = _bearer(headers) or _subprotocol_token(headers)
    if not token:
        raise PermissionError("missing bearer token")

    backend_base = os.getenv("MITR_BACKEND_BASE_URL", "").rstrip("/")
    if not backend_base:
        raise PermissionError("MITR_BACKEND_BASE_URL is required")

    if client == "web" or not device_id:
        async with httpx.AsyncClient(timeout=5.0) as client_http:
            response = await client_http.post(
                f"{backend_base}/pipecat/gateway/auth",
                headers={"Authorization": f"Bearer {token}"},
                json={
                    "language": language,
                    "transport": "pipecat-gateway",
                },
            )

        if response.status_code >= 400:
            raise PermissionError(f"backend web auth rejected client: {response.status_code}")

        data = response.json()
        user_id = str(data.get("userId") or "unknown-user")
        return DeviceAuthContext(
            device_id=str(data.get("deviceId") or f"web-{user_id}"),
            user_id=user_id,
            user_name=data.get("userName"),
            family_id=data.get("familyId"),
            elder_id=data.get("elderId"),
            elder_name=data.get("elderName"),
            language=str(data.get("language") or language or "hi-IN"),
        )

    async with httpx.AsyncClient(timeout=5.0) as client:
        response = await client.post(
            f"{backend_base}/devices/gateway/auth",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "deviceId": device_id,
                "language": language,
                "transport": "pipecat-gateway",
            },
        )

    if response.status_code >= 400:
        raise PermissionError(f"backend auth rejected device: {response.status_code}")

    data = response.json()
    return DeviceAuthContext(
        device_id=str(data.get("deviceId") or device_id or "unknown-device"),
        user_id=data.get("userId"),
        user_name=data.get("userName"),
        family_id=data.get("familyId"),
        elder_id=data.get("elderId"),
        elder_name=data.get("elderName"),
        language=str(data.get("language") or language or "hi-IN"),
    )
