import os
import sys
from contextlib import suppress

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket
from starlette.websockets import WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger

from .auth import authenticate_websocket, select_websocket_subprotocol

load_dotenv(override=False)

def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def _is_placeholder(value: str) -> bool:
    normalized = value.strip().lower()
    return (
        not normalized
        or "example.com" in normalized
        or ".example" in normalized
        or "localhost" in normalized
        or "127.0.0.1" in normalized
        or "placeholder" in normalized
        or normalized in {"changeme", "change_me"}
    )


def _validate_production_env() -> None:
    is_production = os.getenv("NODE_ENV", "").lower() == "production" or os.getenv(
        "MITR_GATEWAY_ENV", ""
    ).lower() == "production"
    if not is_production:
        return

    failures: list[str] = []
    public_ws_url = os.getenv("MITR_GATEWAY_PUBLIC_WS_URL", "")
    cors_origins = [
        origin.strip()
        for origin in os.getenv("MITR_GATEWAY_CORS_ORIGINS", "").split(",")
        if origin.strip()
    ]
    internal_token = os.getenv("MITR_BACKEND_INTERNAL_TOKEN") or os.getenv(
        "INTERNAL_SERVICE_TOKEN", ""
    )
    openai_key = os.getenv("OPENAI_API_KEY", "")

    if os.getenv("MITR_GATEWAY_AUTH_MODE", "").lower() == "local":
        failures.append("MITR_GATEWAY_AUTH_MODE=local is forbidden in production")
    if _env_bool("MITR_GATEWAY_LOG_TRANSCRIPTS", False):
        failures.append("MITR_GATEWAY_LOG_TRANSCRIPTS must be false in production")
    if not public_ws_url.startswith("wss://") or _is_placeholder(public_ws_url):
        failures.append("MITR_GATEWAY_PUBLIC_WS_URL must be a real wss:// URL")
    if not cors_origins:
        failures.append("MITR_GATEWAY_CORS_ORIGINS is required in production")
    for origin in cors_origins:
        if origin == "*" or not origin.startswith("https://") or _is_placeholder(origin):
            failures.append("MITR_GATEWAY_CORS_ORIGINS must contain only real https:// origins")
            break
    if len(internal_token.strip()) < 32:
        failures.append("MITR_BACKEND_INTERNAL_TOKEN must be at least 32 characters")
    if _is_placeholder(openai_key):
        failures.append("OPENAI_API_KEY is required in production")

    if failures:
        raise RuntimeError("Invalid Pipecat gateway production env: " + "; ".join(failures))


_validate_production_env()

logger.remove()
logger.add(sys.stderr, level=os.getenv("LOG_LEVEL", "INFO"))

_active_websockets: dict[str, WebSocket] = {}

app = FastAPI(title="Mitr Pipecat Gateway")
_cors_origins = [
    origin.strip()
    for origin in os.getenv("MITR_GATEWAY_CORS_ORIGINS", "").split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins or ["http://localhost:8787", "http://127.0.0.1:8787"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.post("/connect")
async def connect():
    return {
        "wsUrl": os.getenv("MITR_GATEWAY_PUBLIC_WS_URL", "ws://localhost:7860/ws"),
        "protocol": "mitr-esp32-pcm16-v1",
    }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    try:
        auth = await authenticate_websocket(websocket)
    except Exception as error:
        logger.warning("Rejecting ESP32 gateway websocket: {}", str(error))
        await websocket.close(code=1008)
        return

    await websocket.accept(subprotocol=select_websocket_subprotocol(websocket))
    connection_key = auth.device_id or auth.user_id or "anonymous"
    previous = _active_websockets.get(connection_key)
    if previous is not None:
        with suppress(Exception):
            await previous.send_json({"type": "session_superseded", "deviceId": auth.device_id})
        with suppress(Exception):
            await previous.close(code=4000)
    _active_websockets[connection_key] = websocket
    await websocket.send_json(
        {
            "type": "ready",
            "protocol": "mitr-esp32-pcm16-v1",
            "audioIn": {"sampleRate": int(os.getenv("ESP32_AUDIO_IN_SAMPLE_RATE", "16000"))},
            "audioOut": {"sampleRate": int(os.getenv("ESP32_AUDIO_OUT_SAMPLE_RATE", "16000"))},
            "deviceId": auth.device_id,
        }
    )

    wake_mode = os.getenv("MITR_GATEWAY_WAKE_MODE", "pipecat_phrase").lower()
    if wake_mode in {"local_wakenet", "esp_wake", "legacy"}:
        from .bot import run_bot
    else:
        from .bot_wake_phrase import run_bot

    try:
        while True:
            try:
                await run_bot(websocket, auth)
                break
            except WebSocketDisconnect:
                break
            except Exception as error:
                logger.exception(
                    "Pipecat model pipeline failed; reconnecting",
                    device_id=auth.device_id,
                    error=str(error),
                )
                with suppress(Exception):
                    await websocket.send_json(
                        {
                            "type": "model_error",
                            "deviceId": auth.device_id,
                            "message": str(error),
                        }
                    )
                with suppress(Exception):
                    await websocket.send_json(
                        {"type": "model_reconnecting", "deviceId": auth.device_id}
                    )
                if websocket.client_state.name != "CONNECTED":
                    break
                continue
    finally:
        if _active_websockets.get(connection_key) is websocket:
            del _active_websockets[connection_key]


def main() -> None:
    uvicorn.run(
        "mitr_pipecat_gateway.server:app",
        host=os.getenv("MITR_GATEWAY_HOST", "0.0.0.0"),
        port=int(os.getenv("MITR_GATEWAY_PORT", "7860")),
        reload=os.getenv("MITR_GATEWAY_RELOAD", "false").lower() == "true",
        ws_ping_interval=None,
        ws_ping_timeout=None,
    )


if __name__ == "__main__":
    main()
