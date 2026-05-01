#!/usr/bin/env python3
"""Flash an ESP32 mic loopback probe build.

This toggles debug-only sdkconfig keys, then runs `idf.py build flash monitor`.
Use it to hear which I2S RX channel carries usable microphone audio.
"""

from __future__ import annotations

import argparse
import glob
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SDKCONFIG = ROOT / "sdkconfig"
ESP_IDF_EXPORT = Path.home() / "esp-idf" / "export.sh"

CHANNELS = {
    "left": 0,
    "right": 1,
    "stereo": 2,
}


def detect_port() -> str | None:
    ports = sorted(glob.glob("/dev/cu.usbmodem*") + glob.glob("/dev/cu.SLAB_USBtoUART*"))
    return ports[0] if ports else None


def set_sdkconfig_value(lines: list[str], key: str, value: str) -> list[str]:
    prefix = f"{key}="
    replaced = False
    next_lines: list[str] = []
    for line in lines:
        if line.startswith(prefix) or line.startswith(f"# {key} is not set"):
            next_lines.append(f"{prefix}{value}\n")
            replaced = True
        else:
            next_lines.append(line)
    if not replaced:
        next_lines.append(f"{prefix}{value}\n")
    return next_lines


def update_sdkconfig(enabled: bool, channel: int, volume: int, bits: int, shift: int) -> None:
    lines = SDKCONFIG.read_text().splitlines(keepends=True) if SDKCONFIG.exists() else []
    lines = set_sdkconfig_value(lines, "CONFIG_MITR_MIC_LOOPBACK_PROBE", "y" if enabled else "n")
    lines = set_sdkconfig_value(lines, "CONFIG_MITR_MIC_LOOPBACK_CHANNEL", str(channel))
    lines = set_sdkconfig_value(lines, "CONFIG_MITR_MIC_LOOPBACK_VOLUME", str(volume))
    lines = set_sdkconfig_value(lines, "CONFIG_MITR_MIC_LOOPBACK_BITS", str(bits))
    lines = set_sdkconfig_value(lines, "CONFIG_MITR_MIC_LOOPBACK_SHIFT", str(shift))
    SDKCONFIG.write_text("".join(lines))


def run_idf(port: str, monitor: bool) -> int:
    actions = "build flash monitor" if monitor else "build flash"
    cmd = (
        f". {ESP_IDF_EXPORT} >/tmp/esp-idf-export.log "
        f"&& idf.py -p {port} {actions}"
    )
    return subprocess.call(cmd, cwd=ROOT, shell=True, executable="/bin/zsh")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run ESP32 mic loopback channel probe")
    parser.add_argument(
        "--channel",
        choices=sorted(CHANNELS),
        default="left",
        help="mic channel to route to the speaker",
    )
    parser.add_argument("--volume", type=int, default=55, help="speaker volume, 0-100")
    parser.add_argument("--bits", type=int, choices=(16, 32), default=16, help="I2S input bits per sample")
    parser.add_argument("--shift", type=int, default=16, help="right shift for 32-bit input")
    parser.add_argument("--port", help="serial port, defaults to first /dev/cu.usbmodem*")
    parser.add_argument("--no-monitor", action="store_true", help="flash only; do not open monitor")
    parser.add_argument(
        "--restore-normal",
        action="store_true",
        help="disable loopback mode, then build/flash normal firmware",
    )
    args = parser.parse_args()

    if args.volume < 0 or args.volume > 100:
        parser.error("--volume must be between 0 and 100")

    port = args.port or detect_port()
    if not port:
        print("No ESP32 serial port found. Pass --port /dev/cu.usbmodemXXXX.", file=sys.stderr)
        return 2

    enabled = not args.restore_normal
    channel_id = CHANNELS[args.channel]
    update_sdkconfig(
        enabled=enabled,
        channel=channel_id,
        volume=args.volume,
        bits=args.bits,
        shift=args.shift,
    )

    if enabled:
        print(
            f"Flashing mic loopback probe: channel={args.channel} "
            f"bits={args.bits} shift={args.shift} volume={args.volume} port={port}"
        )
        print("Keep the speaker away from the mic. Ctrl+] exits the monitor.")
    else:
        print(f"Restoring normal firmware on {port}")

    return run_idf(port=port, monitor=not args.no_monitor)


if __name__ == "__main__":
    raise SystemExit(main())
