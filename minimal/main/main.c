#include <stdio.h>
#include <stdbool.h>
#include <string.h>
#include <math.h>

#include "freertos/FreeRTOS.h"
#include "freertos/ringbuf.h"
#include "freertos/task.h"
#include "driver/i2s_std.h"
#include "esp_check.h"
#include "esp_log.h"
#include "esp_websocket_client.h"
#include "livekit_example_utils.h"
#include "sdkconfig.h"

static const char *TAG = "esp32_audio_bridge";

static RingbufHandle_t audio_ring = NULL;
static i2s_chan_handle_t tx_chan = NULL;
static esp_websocket_client_handle_t ws_client = NULL;
static uint64_t ws_audio_bytes_received = 0;
static uint32_t ws_audio_packets_received = 0;
static uint64_t i2s_audio_bytes_written = 0;
static int16_t stereo_expand_buffer[8192];
static volatile bool tone_enabled = false;
static float tone_phase = 0.0f;

#define TONE_FREQUENCY_HZ 440.0f
#define TONE_AMPLITUDE 28000.0f
#define TONE_FRAMES 256
#define TWO_PI_F 6.28318530717958647692f

static void init_i2s_output(void)
{
    i2s_chan_config_t tx_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_AUTO, I2S_ROLE_MASTER);
    ESP_ERROR_CHECK(i2s_new_channel(&tx_cfg, &tx_chan, NULL));

    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(CONFIG_AUDIO_BRIDGE_SAMPLE_RATE),
        .slot_cfg = I2S_STD_MSB_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = CONFIG_AUDIO_BRIDGE_I2S_BCLK,
            .ws = CONFIG_AUDIO_BRIDGE_I2S_WS,
            .dout = CONFIG_AUDIO_BRIDGE_I2S_DOUT,
            .din = I2S_GPIO_UNUSED,
            .invert_flags = {
                .mclk_inv = false,
                .bclk_inv = false,
                .ws_inv = false,
            },
        },
    };

    ESP_ERROR_CHECK(i2s_channel_init_std_mode(tx_chan, &std_cfg));
    ESP_ERROR_CHECK(i2s_channel_enable(tx_chan));

    ESP_LOGI(TAG, "I2S ready: sample_rate=%d, bclk=%d, ws=%d, dout=%d",
        CONFIG_AUDIO_BRIDGE_SAMPLE_RATE,
        CONFIG_AUDIO_BRIDGE_I2S_BCLK,
        CONFIG_AUDIO_BRIDGE_I2S_WS,
        CONFIG_AUDIO_BRIDGE_I2S_DOUT);
}

static void write_stereo_tone(float frequency_hz, float amplitude, uint32_t duration_ms)
{
    const size_t total_frames = ((size_t)CONFIG_AUDIO_BRIDGE_SAMPLE_RATE * duration_ms) / 1000;
    const float phase_step = TWO_PI_F * frequency_hz / (float)CONFIG_AUDIO_BRIDGE_SAMPLE_RATE;
    size_t frames_remaining = total_frames;

    while (frames_remaining > 0) {
        const size_t frames_this_chunk = frames_remaining > TONE_FRAMES ? TONE_FRAMES : frames_remaining;
        for (size_t i = 0; i < frames_this_chunk; i++) {
            const int16_t sample = (int16_t)(sinf(tone_phase) * amplitude);
            stereo_expand_buffer[i * 2] = sample;
            stereo_expand_buffer[(i * 2) + 1] = sample;
            tone_phase += phase_step;
            if (tone_phase >= TWO_PI_F) {
                tone_phase -= TWO_PI_F;
            }
        }

        size_t tone_bytes_written = 0;
        const size_t tone_bytes = frames_this_chunk * sizeof(int16_t) * 2;
        esp_err_t tone_err = i2s_channel_write(tx_chan, stereo_expand_buffer, tone_bytes, &tone_bytes_written, portMAX_DELAY);
        if (tone_err != ESP_OK) {
            ESP_LOGE(TAG, "tone i2s_channel_write failed: %s", esp_err_to_name(tone_err));
            return;
        }

        frames_remaining -= frames_this_chunk;
    }
}

static void play_startup_beep(void)
{
    ESP_LOGI(TAG, "Playing startup beep");
    write_stereo_tone(880.0f, 20000.0f, 150);
    vTaskDelay(pdMS_TO_TICKS(80));
    write_stereo_tone(1760.0f, 20000.0f, 100);
    ESP_LOGI(TAG, "Startup beep done");
}

static void audio_playback_task(void *arg)
{
    while (true) {
        size_t item_size = 0;
        const TickType_t wait_ticks = tone_enabled ? pdMS_TO_TICKS(1) : pdMS_TO_TICKS(50);
        uint8_t *item = (uint8_t *)xRingbufferReceive(audio_ring, &item_size, wait_ticks);
        if (!item) {
            if (tone_enabled) {
                write_stereo_tone(TONE_FREQUENCY_HZ, TONE_AMPLITUDE, (TONE_FRAMES * 1000) / CONFIG_AUDIO_BRIDGE_SAMPLE_RATE);
            }
            continue;
        }

        if ((item_size % 2) != 0) {
            ESP_LOGW(TAG, "Odd-sized PCM packet; dropping %u bytes", (unsigned)item_size);
            vRingbufferReturnItem(audio_ring, item);
            continue;
        }

        const size_t mono_samples = item_size / sizeof(int16_t);
        if (mono_samples > (sizeof(stereo_expand_buffer) / (sizeof(int16_t) * 2))) {
            ESP_LOGW(TAG, "PCM packet too large for stereo expansion; dropping %u bytes", (unsigned)item_size);
            vRingbufferReturnItem(audio_ring, item);
            continue;
        }

        const int16_t *mono = (const int16_t *)item;
        for (size_t i = 0; i < mono_samples; i++) {
            const int16_t sample = mono[i];
            stereo_expand_buffer[i * 2] = sample;
            stereo_expand_buffer[(i * 2) + 1] = sample;
        }

        size_t bytes_written = 0;
        const size_t stereo_bytes = mono_samples * sizeof(int16_t) * 2;
        esp_err_t err = i2s_channel_write(tx_chan, stereo_expand_buffer, stereo_bytes, &bytes_written, portMAX_DELAY);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "i2s_channel_write failed: %s", esp_err_to_name(err));
        } else if (bytes_written != stereo_bytes) {
            ESP_LOGW(TAG, "Short write: wrote=%u expected=%u", (unsigned)bytes_written, (unsigned)stereo_bytes);
        } else {
            i2s_audio_bytes_written += bytes_written;
            if (i2s_audio_bytes_written == bytes_written || (i2s_audio_bytes_written % (16 * 1024)) < bytes_written) {
                ESP_LOGI(TAG, "I2S audio progress: bytes_written=%llu", (unsigned long long)i2s_audio_bytes_written);
            }
        }

        vRingbufferReturnItem(audio_ring, item);
    }
}

static void send_sink_init(void)
{
    char payload[256];
    int len = snprintf(
        payload,
        sizeof(payload),
        "{\"type\":\"init\",\"role\":\"sink\",\"room\":\"%s\"}",
        CONFIG_AUDIO_BRIDGE_ROOM
    );
    if (len <= 0 || len >= (int)sizeof(payload)) {
        ESP_LOGE(TAG, "Failed to build sink init payload");
        return;
    }

    int sent = esp_websocket_client_send_text(ws_client, payload, len, portMAX_DELAY);
    if (sent < 0) {
        ESP_LOGE(TAG, "Failed to send sink init payload");
        return;
    }
    ESP_LOGI(TAG, "Sent sink init for room=%s", CONFIG_AUDIO_BRIDGE_ROOM);
}

static void websocket_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data)
{
    esp_websocket_event_data_t *data = (esp_websocket_event_data_t *)event_data;

    switch (event_id) {
    case WEBSOCKET_EVENT_CONNECTED:
        ESP_LOGI(TAG, "Bridge connected: %s", CONFIG_AUDIO_BRIDGE_URI);
        send_sink_init();
        break;
    case WEBSOCKET_EVENT_DISCONNECTED:
        ESP_LOGW(TAG, "Bridge disconnected");
        break;
    case WEBSOCKET_EVENT_ERROR:
        ESP_LOGE(TAG, "Bridge error: handshake=%d tls=%s sock_errno=%d",
            data->error_handle.esp_ws_handshake_status_code,
            esp_err_to_name(data->error_handle.esp_tls_last_esp_err),
            data->error_handle.esp_transport_sock_errno);
        break;
    case WEBSOCKET_EVENT_DATA:
        if (data->op_code == 0x2 && data->data_len > 0) {
            ws_audio_packets_received += 1;
            ws_audio_bytes_received += data->data_len;
            if (ws_audio_packets_received == 1 || (ws_audio_packets_received % 25) == 0) {
                ESP_LOGI(
                    TAG,
                    "Audio packets received: packets=%u bytes=%llu last_packet=%d",
                    (unsigned)ws_audio_packets_received,
                    (unsigned long long)ws_audio_bytes_received,
                    data->data_len
                );
            }
            BaseType_t ok = xRingbufferSend(audio_ring, data->data_ptr, data->data_len, 0);
            if (ok != pdTRUE) {
                ESP_LOGW(TAG, "Audio ring buffer full; dropping %d bytes", data->data_len);
            }
        } else if (data->op_code == 0x1 && data->data_len > 0) {
            ESP_LOGI(TAG, "Bridge text: %.*s", data->data_len, data->data_ptr);
            if ((int)data->data_len < 256) {
                char json[256];
                memcpy(json, data->data_ptr, data->data_len);
                json[data->data_len] = '\0';
                if (strstr(json, "\"type\":\"control\"") != NULL) {
                    if (strstr(json, "\"action\":\"tone_start\"") != NULL) {
                        tone_enabled = true;
                        ESP_LOGI(TAG, "ESP32 local tone enabled");
                    } else if (strstr(json, "\"action\":\"tone_stop\"") != NULL) {
                        tone_enabled = false;
                        ESP_LOGI(TAG, "ESP32 local tone disabled");
                    }
                }
            }
        }
        break;
    default:
        break;
    }
}

static void start_websocket_client(void)
{
    esp_websocket_client_config_t ws_cfg = {
        .uri = CONFIG_AUDIO_BRIDGE_URI,
        .buffer_size = 4096,
        .network_timeout_ms = 10000,
        .reconnect_timeout_ms = 2000,
        .task_stack = 6144,
        .disable_auto_reconnect = false,
        .keep_alive_enable = true,
        .keep_alive_idle = 5,
        .keep_alive_interval = 5,
        .keep_alive_count = 3,
    };

    ws_client = esp_websocket_client_init(&ws_cfg);
    ESP_ERROR_CHECK(ws_client ? ESP_OK : ESP_FAIL);
    ESP_ERROR_CHECK(esp_websocket_register_events(ws_client, WEBSOCKET_EVENT_ANY, websocket_event_handler, ws_client));
    ESP_ERROR_CHECK(esp_websocket_client_start(ws_client));
}

void app_main(void)
{
    esp_log_level_set("*", ESP_LOG_INFO);

    audio_ring = xRingbufferCreate(CONFIG_AUDIO_BRIDGE_RINGBUF_BYTES, RINGBUF_TYPE_BYTEBUF);
    if (!audio_ring) {
        ESP_LOGE(TAG, "Failed to allocate audio ring buffer");
        return;
    }

    init_i2s_output();
    play_startup_beep();
    xTaskCreate(audio_playback_task, "audio_playback_task", 4096, NULL, 5, NULL);

    if (!lk_example_network_connect()) {
        ESP_LOGE(TAG, "Network connect failed");
        return;
    }

    start_websocket_client();
}
