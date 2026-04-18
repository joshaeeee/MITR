from __future__ import annotations

import numpy as np


class RollingAudioBuffer:
    def __init__(self, sample_rate: int, seconds: float = 2.0) -> None:
        self._capacity = int(sample_rate * seconds)
        self._samples = np.zeros(self._capacity, dtype=np.int16)
        self._filled = 0

    def append(self, samples: np.ndarray) -> None:
        chunk = np.asarray(samples, dtype=np.int16).reshape(-1)
        if chunk.size >= self._capacity:
            self._samples[:] = chunk[-self._capacity :]
            self._filled = self._capacity
            return

        remaining = self._capacity - chunk.size
        self._samples[:remaining] = self._samples[-remaining:]
        self._samples[-chunk.size :] = chunk
        self._filled = min(self._capacity, self._filled + chunk.size)

    def ready(self) -> bool:
        return self._filled >= self._capacity

    def snapshot(self) -> np.ndarray:
        return np.copy(self._samples)


def frame_to_mono_int16(frame) -> np.ndarray:
    data = np.asarray(frame.data, dtype=np.int16)
    if frame.num_channels <= 1:
        return data.reshape(-1)
    interleaved = data.reshape(-1, frame.num_channels)
    return interleaved.mean(axis=1).astype(np.int16)


def resample_int16(samples: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    if src_rate == dst_rate:
        return np.asarray(samples, dtype=np.int16)

    src = np.asarray(samples, dtype=np.float32)
    if src.size == 0:
        return np.zeros(0, dtype=np.int16)

    ratio = dst_rate / src_rate
    target_length = max(1, int(round(src.size * ratio)))
    src_index = np.linspace(0, src.size - 1, num=src.size, endpoint=True)
    dst_index = np.linspace(0, src.size - 1, num=target_length, endpoint=True)
    return np.interp(dst_index, src_index, src).astype(np.int16)
