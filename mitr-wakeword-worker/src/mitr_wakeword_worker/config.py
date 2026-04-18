from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class WorkerConfig:
    livekit_url: str
    livekit_api_key: str
    livekit_api_secret: str
    internal_api_base_url: str
    internal_api_token: str
    model_manifest_path: str
    join_identity_prefix: str
    detection_debounce_ms: int
    room_idle_evict_ms: int
    redis_url: str

    @classmethod
    def from_env(cls) -> "WorkerConfig":
        return cls(
            livekit_url=_require("LIVEKIT_URL"),
            livekit_api_key=_require("LIVEKIT_API_KEY"),
            livekit_api_secret=_require("LIVEKIT_API_SECRET"),
            internal_api_base_url=_require("WAKEWORD_INTERNAL_API_BASE_URL").rstrip("/"),
            internal_api_token=_require("WAKEWORD_INTERNAL_API_TOKEN"),
            model_manifest_path=_require("WAKEWORD_MODEL_MANIFEST_PATH"),
            join_identity_prefix=os.getenv("WAKEWORD_JOIN_IDENTITY_PREFIX", "wakeword-worker"),
            detection_debounce_ms=int(os.getenv("WAKEWORD_DETECTION_DEBOUNCE_MS", "2000")),
            room_idle_evict_ms=int(os.getenv("WAKEWORD_ROOM_IDLE_EVICT_MS", "300000")),
            redis_url=_require("REDIS_URL"),
        )


def _require(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value
