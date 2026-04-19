#!/usr/bin/env python3
import argparse
import json
import re
from pathlib import Path

import matplotlib.pyplot as plt

BOOT_RE = re.compile(r"\[BOOT\]\s+t=(\d+)ms state=([a-zA-Z0-9_]+)")
TIMING_RE = re.compile(
    r"\[TIMING\]\s+boot_t=(\d+)ms(?:\s+wake_id=(\d+)\s+wake_t=(\d+)ms)?\s+stage=([a-zA-Z0-9_]+)"
)
LOG_TS_RE = re.compile(r"^[IWE] \((\d+)\)")

STAGE_LABELS = {
    "wifi_connected": "Wi-Fi Connected",
    "bootstrap_complete": "Bootstrap Complete",
    "preconnect_capture_started": "Preconnect Capture",
    "wake_service_started": "Wake Service Started",
    "ready_listening": "Ready Listening",
    "token_fetch_start": "Token Fetch Start",
    "token_fetch_end": "Token Fetch End",
    "room_connect_start": "Room Connect Start",
    "room_connected": "Room Connected",
    "ready_connected": "Ready Connected",
    "agent_joined": "Agent Joined",
    "wake_detected": "Wake Detected",
    "wake_local_ready": "Wake Local Ready",
    "wake_notify_start": "Wake Notify Start",
    "wake_notify_ok": "Wake Notify OK",
    "wake_notify_rejected": "Wake Notify Rejected",
    "wake_notify_failed": "Wake Notify Failed",
}

BOOT_STAGE_ORDER = [
    "wifi_connected",
    "bootstrap_complete",
    "preconnect_capture_started",
    "wake_service_started",
    "ready_listening",
    "token_fetch_start",
    "token_fetch_end",
    "room_connect_start",
    "room_connected",
    "ready_connected",
    "agent_joined",
    "wake_detected",
    "wake_notify_ok",
]

WAKE_STAGE_ORDER = [
    "wake_detected",
    "wake_local_ready",
    "wake_notify_start",
    "wake_notify_ok",
    "room_connected",
    "agent_joined",
]


def parse_log(path: Path):
    boot_stages = {}
    wake_events = {}
    current_wake_id = None
    current_wake_boot_ms = None
    for line in path.read_text().splitlines():
        boot_match = BOOT_RE.search(line)
        if boot_match:
            boot_ms = int(boot_match.group(1))
            stage = boot_match.group(2)
            boot_stages.setdefault(stage, boot_ms)
            continue

        timing_match = TIMING_RE.search(line)
        if not timing_match:
            ts_match = LOG_TS_RE.search(line)
            if not ts_match:
                continue
            boot_ms = int(ts_match.group(1))

            inferred_stage = None
            if "[PRECONNECT] Capture started" in line:
                inferred_stage = "preconnect_capture_started"
            elif "Wake word task started" in line:
                inferred_stage = "wake_service_started"
            elif "*** WAKE WORD DETECTED ***" in line:
                inferred_stage = "wake_detected"
                current_wake_id = 1 if current_wake_id is None else current_wake_id + 1
                current_wake_boot_ms = boot_ms
                wake_events.setdefault(current_wake_id, {})
                wake_events[current_wake_id].setdefault("wake_detected", 0)
            elif "Wake word detected locally; activating conversation" in line:
                inferred_stage = "wake_local_ready"
            elif "Playing wake chime" in line:
                inferred_stage = "wake_local_ready"
            elif "Wake detection rejected" in line:
                inferred_stage = "wake_notify_rejected"
            elif "Failed to publish device event agent_joined" in line:
                inferred_stage = "agent_joined"

            if inferred_stage:
                boot_stages.setdefault(inferred_stage, boot_ms)
                if current_wake_id is not None and current_wake_boot_ms is not None and inferred_stage.startswith("wake_"):
                    wake_events.setdefault(current_wake_id, {})
                    wake_events[current_wake_id].setdefault(inferred_stage, boot_ms - current_wake_boot_ms)
            continue

        boot_ms = int(timing_match.group(1))
        wake_id = timing_match.group(2)
        wake_ms = timing_match.group(3)
        stage = timing_match.group(4)
        boot_stages.setdefault(stage, boot_ms)
        if wake_id is not None and wake_ms is not None:
            wake_key = int(wake_id)
            wake_events.setdefault(wake_key, {})
            wake_events[wake_key].setdefault(stage, int(wake_ms))

    return boot_stages, wake_events


def ordered_points(stage_map, order):
    points = []
    for stage in order:
        if stage in stage_map:
            points.append((stage, stage_map[stage]))
    return points


def plot_boot(ax, points):
    if not points:
        ax.text(0.5, 0.5, "No boot markers found", ha="center", va="center")
        ax.set_axis_off()
        return

    xs = [value for _, value in points]
    ys = list(range(len(points)))
    labels = [STAGE_LABELS.get(stage, stage) for stage, _ in points]
    ax.plot(xs, ys, marker="o", linewidth=2, color="#0b7285")
    ax.set_yticks(ys, labels)
    ax.set_xlabel("Milliseconds Since Boot")
    ax.set_title("Boot And Connect Timeline")
    ax.grid(axis="x", linestyle="--", alpha=0.4)
    for x, y in zip(xs, ys):
        ax.text(x, y + 0.08, f"{x} ms", fontsize=8, ha="left")


def plot_deltas(ax, points):
    if len(points) < 2:
        ax.text(0.5, 0.5, "Not enough markers for deltas", ha="center", va="center")
        ax.set_axis_off()
        return

    deltas = []
    labels = []
    for (prev_stage, prev_ms), (stage, stage_ms) in zip(points, points[1:]):
        deltas.append(stage_ms - prev_ms)
        labels.append(f"{STAGE_LABELS.get(prev_stage, prev_stage)} ->\n{STAGE_LABELS.get(stage, stage)}")

    ax.barh(labels, deltas, color="#f08c00")
    ax.set_xlabel("Milliseconds")
    ax.set_title("Step Deltas")
    ax.grid(axis="x", linestyle="--", alpha=0.4)


def plot_wake(ax, wake_events):
    if not wake_events:
        ax.text(0.5, 0.5, "No wake markers found", ha="center", va="center")
        ax.set_axis_off()
        return

    first_wake_id = sorted(wake_events)[0]
    points = ordered_points(wake_events[first_wake_id], WAKE_STAGE_ORDER)
    if not points:
        ax.text(0.5, 0.5, "No wake markers found", ha="center", va="center")
        ax.set_axis_off()
        return

    xs = [value for _, value in points]
    ys = list(range(len(points)))
    labels = [STAGE_LABELS.get(stage, stage) for stage, _ in points]
    ax.plot(xs, ys, marker="o", linewidth=2, color="#2b8a3e")
    ax.set_yticks(ys, labels)
    ax.set_xlabel("Milliseconds Since Wake Detection")
    ax.set_title(f"Wake Timeline (wake_id={first_wake_id})")
    ax.grid(axis="x", linestyle="--", alpha=0.4)
    for x, y in zip(xs, ys):
        ax.text(x, y + 0.08, f"{x} ms", fontsize=8, ha="left")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--log", required=True, type=Path)
    parser.add_argument("--output-prefix", required=True, type=Path)
    args = parser.parse_args()

    boot_stages, wake_events = parse_log(args.log)
    boot_points = ordered_points(boot_stages, BOOT_STAGE_ORDER)

    args.output_prefix.parent.mkdir(parents=True, exist_ok=True)
    fig, axes = plt.subplots(3, 1, figsize=(12, 13), constrained_layout=True)
    plot_boot(axes[0], boot_points)
    plot_deltas(axes[1], boot_points)
    plot_wake(axes[2], wake_events)
    fig.savefig(args.output_prefix.with_suffix(".png"), dpi=180)

    summary = {
        "log": str(args.log),
        "boot_stages_ms": boot_stages,
        "wake_events_ms": wake_events,
    }
    args.output_prefix.with_suffix(".json").write_text(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
