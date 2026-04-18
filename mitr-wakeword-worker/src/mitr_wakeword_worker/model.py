from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import numpy as np
from livekit.wakeword import WakeWordModel

from .types import ModelManifest


class WakewordRuntime:
    def __init__(self, manifest_path: str) -> None:
        manifest_file = Path(manifest_path)
        if not manifest_file.exists():
            raise RuntimeError(f"Wakeword manifest not found: {manifest_file}")

        payload = json.loads(manifest_file.read_text())
        self.manifest = ModelManifest(**payload)
        self.model_path = _resolve_model_path(manifest_file)
        if not self.model_path.exists():
            raise RuntimeError(f"Wakeword ONNX model not found: {self.model_path}")

        self.model = WakeWordModel(models=[str(self.model_path)])

    def predict(self, pcm: np.ndarray) -> float:
        audio = np.asarray(pcm, dtype=np.int16)
        scores = self.model.predict(audio)
        return float(scores[self.manifest.model_name])

    def describe(self) -> dict[str, object]:
        return asdict(self.manifest)


def _resolve_model_path(manifest_file: Path) -> Path:
    candidates = [manifest_file.with_suffix(".onnx")]
    if manifest_file.name.endswith(".meta.json"):
        candidates.insert(0, manifest_file.with_name(manifest_file.name[: -len(".meta.json")] + ".onnx"))

    for candidate in candidates:
        if candidate.exists():
            return candidate

    return candidates[0]
