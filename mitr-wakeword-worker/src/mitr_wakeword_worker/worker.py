from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from typing import Any

import redis.asyncio as redis
from livekit import api, rtc

from .audio import RollingAudioBuffer, frame_to_mono_int16, resample_int16
from .backend import BackendClient
from .config import WorkerConfig
from .model import WakewordRuntime
from .types import DeviceSession

LOG = logging.getLogger("mitr_wakeword_worker")
DEVICE_CONTROL_TOPIC = "mitr.device_control"
SESSION_EVENTS_CHANNEL = "mitr:device-session-events"


class DeviceRoomSession:
    def __init__(
        self,
        config: WorkerConfig,
        backend: BackendClient,
        wakeword: WakewordRuntime,
        session: DeviceSession,
    ) -> None:
        self._config = config
        self._backend = backend
        self._wakeword = wakeword
        self._session = session
        self._room = rtc.Room()
        self._audio_task: asyncio.Task[None] | None = None
        self._last_detection_ms = 0
        self._closing = False
        self._wire_events()

    @property
    def session_id(self) -> str:
        return self._session.id

    def update(self, session: DeviceSession) -> None:
        self._session = session

    async def start(self) -> None:
        token = (
            api.AccessToken(self._config.livekit_api_key, self._config.livekit_api_secret)
            .with_identity(f"{self._config.join_identity_prefix}-{self._session.id}")
            .with_name("Mitr Wakeword Worker")
            .with_grants(
                api.VideoGrants(
                    room_join=True,
                    room=self._session.room_name,
                    can_publish=False,
                    can_subscribe=True,
                    can_publish_data=True,
                    hidden=True,
                )
            )
            .to_jwt()
        )
        LOG.info("joining room %s for session %s", self._session.room_name, self._session.id)
        await self._room.connect(self._config.livekit_url, token)

    async def close(self) -> None:
        self._closing = True
        if self._audio_task is not None:
            self._audio_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._audio_task
        await self._room.disconnect()

    def _wire_events(self) -> None:
        @self._room.on("track_subscribed")
        def _on_track_subscribed(track: rtc.Track, publication: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant) -> None:
            if participant.identity != self._session.participant_identity:
                return
            if track.kind != rtc.TrackKind.KIND_AUDIO:
                return
            if self._audio_task is not None and not self._audio_task.done():
                return
            self._audio_task = asyncio.create_task(self._consume_audio(track))

        @self._room.on("track_unsubscribed")
        def _on_track_unsubscribed(track: rtc.Track, publication: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant) -> None:
            if participant.identity != self._session.participant_identity:
                return
            if self._audio_task is not None:
                self._audio_task.cancel()
                self._audio_task = None

        @self._room.on("disconnected")
        def _on_disconnected() -> None:
            if self._closing:
                return
            LOG.warning("room disconnected unexpectedly for session %s", self._session.id)

    async def _consume_audio(self, track: rtc.Track) -> None:
        stream = rtc.AudioStream.from_track(track=track, sample_rate=16000, num_channels=1)
        buffer = RollingAudioBuffer(sample_rate=self._wakeword.manifest.sample_rate, seconds=2.0)
        try:
            async for frame_event in stream:
                if self._session.conversation_state != "idle":
                    continue

                pcm = frame_to_mono_int16(frame_event.frame)
                pcm = resample_int16(pcm, frame_event.frame.sample_rate, self._wakeword.manifest.sample_rate)
                buffer.append(pcm)
                if not buffer.ready():
                    continue

                now_ms = int(time.time() * 1000)
                if now_ms - self._last_detection_ms < self._config.detection_debounce_ms:
                    continue

                score = self._wakeword.predict(buffer.snapshot())
                if score < self._wakeword.manifest.threshold:
                    continue

                result = await self._backend.wake_detected(
                    self._session.id,
                    model_name=self._wakeword.manifest.model_name,
                    phrase=self._wakeword.manifest.phrase,
                    score=score,
                    detected_at_ms=now_ms,
                )
                if not result.get("accepted"):
                    continue

                self._last_detection_ms = now_ms
                self._session.conversation_state = "starting"
                await self._room.local_participant.publish_data(
                    json.dumps(
                        {
                            "type": "conversation_started",
                            "action": "conversation_started",
                            "sessionId": self._session.id,
                            "wakeword": self._wakeword.manifest.phrase,
                            "confidence": score,
                            "detectedAtMs": now_ms,
                            "playChime": True,
                        }
                    ),
                    reliable=True,
                    topic=DEVICE_CONTROL_TOPIC,
                )
                LOG.info(
                    "wake detected for session %s in room %s with score %.3f",
                    self._session.id,
                    self._session.room_name,
                    score,
                )
        finally:
            await stream.aclose()


class WakewordWorker:
    def __init__(self, config: WorkerConfig) -> None:
        self._config = config
        self._wakeword = WakewordRuntime(config.model_manifest_path)
        self._backend = BackendClient(config.internal_api_base_url, config.internal_api_token)
        self._rooms: dict[str, DeviceRoomSession] = {}
        self._redis = redis.from_url(config.redis_url)

    async def run(self) -> None:
        await self._reconcile()
        await asyncio.gather(self._subscribe_loop(), self._periodic_reconcile())

    async def close(self) -> None:
        await self._backend.close()
        await self._redis.aclose()
        for room in list(self._rooms.values()):
            await room.close()

    async def _periodic_reconcile(self) -> None:
        while True:
            await asyncio.sleep(30)
            await self._reconcile()

    async def _subscribe_loop(self) -> None:
        pubsub = self._redis.pubsub()
        await pubsub.subscribe(SESSION_EVENTS_CHANNEL)
        async for message in pubsub.listen():
            if message.get("type") != "message":
                continue
            payload = json.loads(message["data"])
            await self._apply_event(payload)

    async def _reconcile(self) -> None:
        sessions = await self._backend.list_live_sessions()
        desired = {session.id: session for session in sessions if session.status in {"issued", "active"}}

        for session_id in list(self._rooms.keys()):
            if session_id not in desired:
                await self._remove_room(session_id)

        for session in desired.values():
            await self._upsert_room(session)

    async def _apply_event(self, payload: dict[str, Any]) -> None:
        session_id = str(payload["sessionId"])
        status = str(payload["status"])
        if status == "ended":
            await self._remove_room(session_id)
            return

        session = next((item for item in await self._backend.list_live_sessions() if item.id == session_id), None)
        if session is None:
            await self._remove_room(session_id)
            return
        await self._upsert_room(session)

    async def _upsert_room(self, session: DeviceSession) -> None:
        existing = self._rooms.get(session.id)
        if existing is not None:
            existing.update(session)
            return

        room = DeviceRoomSession(self._config, self._backend, self._wakeword, session)
        self._rooms[session.id] = room
        try:
            await room.start()
        except Exception:
            self._rooms.pop(session.id, None)
            raise

    async def _remove_room(self, session_id: str) -> None:
        room = self._rooms.pop(session_id, None)
        if room is None:
            return
        await room.close()
