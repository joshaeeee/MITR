#!/bin/zsh
set -euo pipefail

SDKCONFIG="${0:A:h}/sdkconfig"
HOST="${1:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)}"
PORT="${2:-8081}"
DEVICE_ACCESS_TOKEN="${3:-}"
LANGUAGE="${4:-hi-IN}"
HARDWARE_REV="${5:-esp32-s3-wroom}"
FIRMWARE_VERSION="${6:-v0.1.0-dev}"

if [[ -z "${HOST}" ]]; then
  echo "Could not determine a LAN IP. Pass one explicitly:"
  echo "  ./set-device-config.sh 192.168.x.x 8081 <device-access-token>"
  exit 1
fi

if [[ -z "${DEVICE_ACCESS_TOKEN}" ]]; then
  echo "Missing device access token."
  echo "Usage:"
  echo "  ./set-device-config.sh <host> <port> <device-access-token> [language] [hardware-rev] [firmware-version]"
  exit 1
fi

if [[ ! -f "${SDKCONFIG}" ]]; then
  echo "Missing ${SDKCONFIG}. Run 'idf.py menuconfig' once or generate sdkconfig first."
  exit 1
fi

sed -i '' "s#^CONFIG_MITR_DEVICE_BACKEND_BASE_URL=.*#CONFIG_MITR_DEVICE_BACKEND_BASE_URL=\"http://${HOST}:${PORT}\"#" "${SDKCONFIG}"
sed -i '' "s#^CONFIG_MITR_DEVICE_ACCESS_TOKEN=.*#CONFIG_MITR_DEVICE_ACCESS_TOKEN=\"${DEVICE_ACCESS_TOKEN}\"#" "${SDKCONFIG}"
sed -i '' "s#^CONFIG_MITR_DEVICE_LANGUAGE=.*#CONFIG_MITR_DEVICE_LANGUAGE=\"${LANGUAGE}\"#" "${SDKCONFIG}"
sed -i '' "s#^CONFIG_MITR_DEVICE_HARDWARE_REV=.*#CONFIG_MITR_DEVICE_HARDWARE_REV=\"${HARDWARE_REV}\"#" "${SDKCONFIG}"
sed -i '' "s#^CONFIG_MITR_DEVICE_FIRMWARE_VERSION=.*#CONFIG_MITR_DEVICE_FIRMWARE_VERSION=\"${FIRMWARE_VERSION}\"#" "${SDKCONFIG}"
sed -i '' "s#^CONFIG_LK_EXAMPLE_CODEC_BOARD_TYPE=.*#CONFIG_LK_EXAMPLE_CODEC_BOARD_TYPE=\"MITR_ESP32_S3_RAW_I2S\"#" "${SDKCONFIG}"
sed -i '' "s#^CONFIG_WS_BUFFER_SIZE=.*#CONFIG_WS_BUFFER_SIZE=4096#" "${SDKCONFIG}"

echo "Updated device firmware config:"
grep -E '^(CONFIG_MITR_DEVICE_(BACKEND_BASE_URL|ACCESS_TOKEN|LANGUAGE|HARDWARE_REV|FIRMWARE_VERSION)|CONFIG_LK_EXAMPLE_CODEC_BOARD_TYPE|CONFIG_WS_BUFFER_SIZE)=' "${SDKCONFIG}"
