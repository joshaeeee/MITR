# ESP32 Audio Bridge Demo

This project turns the ESP32-S3 into a simple speaker endpoint for MITR.

Path:

1. MITR web simulator subscribes to the agent's audio
2. Browser forwards PCM over WebSocket
3. ESP32 receives PCM over Wi-Fi
4. ESP32 plays audio over I2S to the MAX98357A

This is a demo path. It does not use LiveKit on the ESP32. It does not use the mic yet.

## Hardware

Current output wiring:

- `BCLK -> GPIO14`
- `WS/LRC -> GPIO12`
- `DIN -> GPIO13`

MAX98357A:

- `VIN -> 3.3V`
- `GND -> GND`
- `SD -> 3.3V`

## Important constraint

ESP32-S3 only supports `2.4 GHz` Wi-Fi.

If you point it at a `..._5G` SSID, it will keep retrying and never join.

Use one of these:

- your router's `2.4 GHz` SSID
- a phone hotspot running on `2.4 GHz`

## Configuration

Open:

```sh
idf.py menuconfig
```

Set these values:

### LiveKit Example Utilities

- Wi-Fi SSID
- Wi-Fi password

### ESP32 Audio Bridge

- `Bridge URI`
- `Room name`
- `Sample rate`
- `I2S BCLK`
- `I2S WS`
- `I2S DOUT`

Expected defaults:

```ini
CONFIG_AUDIO_BRIDGE_ROOM="mitr-esp32-test"
CONFIG_AUDIO_BRIDGE_SAMPLE_RATE=48000
CONFIG_AUDIO_BRIDGE_I2S_BCLK=14
CONFIG_AUDIO_BRIDGE_I2S_WS=12
CONFIG_AUDIO_BRIDGE_I2S_DOUT=13
```

## Bridge URI

The ESP32 must connect to your Mac's LAN IP, not `localhost`.

Example:

```ini
CONFIG_AUDIO_BRIDGE_URI="ws://192.168.x.x:8787/esp32-audio"
```

Use the helper script to rewrite `sdkconfig` with your current Mac IP:

```sh
./set-bridge-uri.sh
```

Or override it manually:

```sh
./set-bridge-uri.sh 192.168.x.x 8787 mitr-esp32-test
```

## Build and flash

```sh
source ~/esp/esp-idf/export.sh
idf.py build
idf.py -p /dev/cu.usbmodem1101 flash
idf.py -p /dev/cu.usbmodem1101 monitor
```

## Expected boot logs

Good signs:

- `I2S ready: sample_rate=48000, bclk=14, ws=12, dout=13`
- Wi-Fi connects successfully
- `Bridge connected`
- `Sent sink init for room=mitr-esp32-test`

If you see repeated `network_connect: Retry`, the SSID is wrong, the password is wrong, or the network is `5 GHz`.

## Demo run

1. Start the MITR API and agent worker
2. Start the web simulator server on port `8787`
3. Open the simulator in a browser
4. Join room `mitr-esp32-test`
5. Speak to the agent
6. Agent audio should come out of the MAX98357A speaker
