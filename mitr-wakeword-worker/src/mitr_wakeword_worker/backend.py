from __future__ import annotations

from typing import Any

import aiohttp

from .types import DeviceSession


class BackendClient:
    def __init__(self, base_url: str, token: str) -> None:
        self._base_url = base_url.rstrip("/")
        self._session = aiohttp.ClientSession(
            headers={
                "content-type": "application/json",
                "x-internal-service-token": token,
            }
        )

    async def close(self) -> None:
        await self._session.close()

    async def list_live_sessions(self) -> list[DeviceSession]:
        async with self._session.get(f"{self._base_url}/internal/device-sessions/active") as response:
            response.raise_for_status()
            payload = await response.json()
        return [DeviceSession.from_api(item) for item in payload.get("items", [])]

    async def wake_detected(
        self,
        session_id: str,
        *,
        model_name: str,
        phrase: str,
        score: float,
        detected_at_ms: int,
    ) -> dict[str, Any]:
        body = {
            "modelName": model_name,
            "phrase": phrase,
            "score": score,
            "detectedAtMs": detected_at_ms,
        }
        async with self._session.post(
            f"{self._base_url}/internal/device-sessions/{session_id}/wake-detected",
            json=body,
        ) as response:
            response.raise_for_status()
            return await response.json()
