import json
import os

from loguru import logger

from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    InterruptionFrame,
    OutputAudioRawFrame,
    OutputTransportMessageFrame,
    OutputTransportMessageUrgentFrame,
    StartFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.serializers.base_serializer import FrameSerializer

_MAX_OUTPUT_GAIN = 3.0


def _float_env(name: str, fallback: float) -> float:
    try:
        return float(os.getenv(name, str(fallback)))
    except ValueError:
        return fallback


def _apply_pcm16_gain(audio: bytes, gain: float) -> bytes:
    if gain == 1.0:
        return audio

    output = bytearray(audio)
    for index in range(0, len(output) - 1, 2):
        sample = int.from_bytes(output[index:index + 2], "little", signed=True)
        scaled = round(sample * gain)
        clipped = max(-32768, min(32767, scaled))
        output[index:index + 2] = int(clipped).to_bytes(2, "little", signed=True)
    return bytes(output)


class Esp32PCMSerializer(FrameSerializer):
    """Small ESP32 protocol: text JSON for control, binary PCM16 mono for audio."""

    def __init__(self) -> None:
        super().__init__()
        self._audio_in_sample_rate = int(os.getenv("ESP32_AUDIO_IN_SAMPLE_RATE", "16000"))
        self._audio_out_sample_rate = int(os.getenv("ESP32_AUDIO_OUT_SAMPLE_RATE", "16000"))
        self._channels = 1
        self._audio_frame_count = 0
        self._output_audio_frame_count = 0
        self._output_gain = max(
            0.0,
            min(_MAX_OUTPUT_GAIN, _float_env("ESP32_AUDIO_OUTPUT_GAIN", 1.0)),
        )

    async def setup(self, frame: StartFrame):
        await super().setup(frame)
        self._audio_in_sample_rate = frame.audio_in_sample_rate
        self._audio_out_sample_rate = frame.audio_out_sample_rate

    async def deserialize(self, data: str | bytes) -> Frame | None:
        if isinstance(data, bytes):
            if not data:
                return None
            self._audio_frame_count += 1
            if self._audio_frame_count == 1 or self._audio_frame_count % 100 == 0:
                logger.info("ESP32 audio frame #{}: {} bytes", self._audio_frame_count, len(data))
            return InputAudioRawFrame(
                audio=data,
                sample_rate=self._audio_in_sample_rate,
                num_channels=self._channels,
            )

        try:
            message = json.loads(data)
        except json.JSONDecodeError:
            logger.debug("Ignoring non-JSON ESP32 websocket text frame")
            return None

        if not isinstance(message, dict):
            return None

        message_type = message.get("type")
        if message_type in {"wake", "start"}:
            logger.info("ESP32 control: {}", message_type)
            return UserStartedSpeakingFrame()
        if message_type == "stop":
            logger.info("ESP32 control: stop")
            return UserStoppedSpeakingFrame()
        if message_type == "hello":
            logger.info("ESP32 control: {}", message_type)
            return None
        logger.debug("Ignoring unsupported ESP32 control message: {}", message)
        return None

    async def serialize(self, frame: Frame) -> str | bytes | None:
        if isinstance(frame, OutputAudioRawFrame):
            self._output_audio_frame_count += 1
            if self._output_audio_frame_count == 1 or self._output_audio_frame_count % 100 == 0:
                logger.info(
                    "Gateway output audio frame #{}: {} bytes gain={}",
                    self._output_audio_frame_count,
                    len(frame.audio),
                    self._output_gain,
                )
            return _apply_pcm16_gain(frame.audio, self._output_gain)

        if isinstance(frame, (OutputTransportMessageFrame, OutputTransportMessageUrgentFrame)):
            if self.should_ignore_frame(frame):
                return None
            return json.dumps(frame.message, separators=(",", ":"))

        if isinstance(frame, InterruptionFrame):
            return json.dumps({"type": "interrupt"}, separators=(",", ":"))
        if isinstance(frame, EndFrame):
            return json.dumps({"type": "end"}, separators=(",", ":"))
        if isinstance(frame, CancelFrame):
            return json.dumps({"type": "cancel"}, separators=(",", ":"))

        return None
