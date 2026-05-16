import argparse
import asyncio
import json
import os
from pathlib import Path

import websockets
from dotenv import load_dotenv


def _load_env(path: Path | None) -> None:
    if path is not None:
        load_dotenv(path, override=True)
        return

    gateway_dir = Path(__file__).resolve().parents[1]
    backend_env = gateway_dir.parent / ".env"
    if backend_env.exists():
        load_dotenv(backend_env, override=True)
    else:
        load_dotenv(override=False)


async def _run(args: argparse.Namespace) -> int:
    _load_env(args.env_file)
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("OPENAI_API_KEY is missing")
        return 2

    url = f"wss://api.openai.com/v1/realtime?model={args.model}"
    async with websockets.connect(
        url,
        additional_headers={"Authorization": f"Bearer {api_key}"},
        open_timeout=12,
    ) as websocket:
        first = json.loads(await asyncio.wait_for(websocket.recv(), timeout=12))
        print(f"first_event={first.get('type')} session_model={(first.get('session') or {}).get('model')}")
        if first.get("type") == "error":
            print(json.dumps(first.get("error"), ensure_ascii=False))
            return 1

        session = {
            "type": "realtime",
            "output_modalities": ["text"],
            "instructions": "You are a smoke test. Reply with one short sentence.",
            "max_output_tokens": 64,
        }
        if args.reasoning_effort:
            session["reasoning"] = {"effort": args.reasoning_effort}
        if args.truncation == "retention_ratio":
            truncation: dict[str, object] = {
                "type": "retention_ratio",
                "retention_ratio": args.retention_ratio,
            }
            if args.post_instructions_token_limit:
                truncation["token_limits"] = {
                    "post_instructions": args.post_instructions_token_limit,
                }
            session["truncation"] = truncation
        elif args.truncation:
            session["truncation"] = args.truncation

        await websocket.send(json.dumps({"type": "session.update", "session": session}))
        while True:
            event = json.loads(await asyncio.wait_for(websocket.recv(), timeout=12))
            if event.get("type") == "session.updated":
                updated = event.get("session") or {}
                print(
                    "session_updated=ok "
                    f"reasoning={updated.get('reasoning')} "
                    f"truncation={updated.get('truncation')}"
                )
                break
            if event.get("type") == "error":
                print(json.dumps(event.get("error"), ensure_ascii=False))
                return 1

        await websocket.send(
            json.dumps(
                {
                    "type": "conversation.item.create",
                    "item": {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "Say pong."}],
                    },
                }
            )
        )
        await websocket.send(json.dumps({"type": "response.create"}))

        text = []
        while True:
            event = json.loads(await asyncio.wait_for(websocket.recv(), timeout=20))
            event_type = event.get("type")
            if event_type == "response.output_text.delta":
                text.append(event.get("delta", ""))
            elif event_type == "response.done":
                print("response_text=" + "".join(text).strip())
                return 0
            elif event_type == "error":
                print(json.dumps(event.get("error"), ensure_ascii=False))
                return 1


def main() -> None:
    parser = argparse.ArgumentParser(description="Smoke test OpenAI Realtime 2 websocket support.")
    parser.add_argument("--model", default=os.getenv("OPENAI_REALTIME_MODEL", "gpt-realtime-2"))
    parser.add_argument("--reasoning-effort", default="low")
    parser.add_argument("--truncation", default="auto")
    parser.add_argument("--retention-ratio", type=float, default=0.8)
    parser.add_argument("--post-instructions-token-limit", type=int)
    parser.add_argument("--env-file", type=Path)
    args = parser.parse_args()
    raise SystemExit(asyncio.run(_run(args)))


if __name__ == "__main__":
    main()
