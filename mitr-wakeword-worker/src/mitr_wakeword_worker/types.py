from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(slots=True)
class DeviceSession:
    id: str
    device_id: str
    room_name: str
    participant_identity: str
    status: str
    conversation_state: str
    metadata: dict[str, Any]

    @classmethod
    def from_api(cls, payload: dict[str, Any]) -> "DeviceSession":
        return cls(
            id=str(payload["id"]),
            device_id=str(payload["deviceId"]),
            room_name=str(payload["roomName"]),
            participant_identity=str(payload["participantIdentity"]),
            status=str(payload["status"]),
            conversation_state=str(payload["conversationState"]),
            metadata=dict(payload.get("metadata", {})),
        )


@dataclass(slots=True)
class ModelManifest:
    model_name: str
    phrase: str
    threshold: float
    sample_rate: int
    recall: float
    fpph: float
    aut: float
    trained_at: str
    exported_at: str
