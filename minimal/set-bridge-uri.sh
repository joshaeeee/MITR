#!/bin/zsh
set -euo pipefail

SDKCONFIG="${0:A:h}/sdkconfig"
HOST="${1:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)}"
PORT="${2:-8787}"
ROOM="${3:-mitr-esp32-test}"

if [[ -z "${HOST}" ]]; then
  echo "Could not determine a LAN IP. Pass one explicitly:"
  echo "  ./set-bridge-uri.sh 192.168.x.x 8787 ${ROOM}"
  exit 1
fi

if [[ ! -f "${SDKCONFIG}" ]]; then
  echo "Missing ${SDKCONFIG}"
  exit 1
fi

sed -i '' "s#^CONFIG_AUDIO_BRIDGE_URI=.*#CONFIG_AUDIO_BRIDGE_URI=\"ws://${HOST}:${PORT}/esp32-audio\"#" "${SDKCONFIG}"
sed -i '' "s#^CONFIG_AUDIO_BRIDGE_ROOM=.*#CONFIG_AUDIO_BRIDGE_ROOM=\"${ROOM}\"#" "${SDKCONFIG}"

echo "Updated bridge settings:"
grep -E '^CONFIG_AUDIO_BRIDGE_(URI|ROOM)=' "${SDKCONFIG}"
