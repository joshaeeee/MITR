#include "gateway_client.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_websocket_client.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include "boot_feedback.h"
#include "device_api.h"
#include "device_storage.h"
#include "media.h"
#include "preconnect_audio_src.h"

#ifndef MITR_GATEWAY_SERVER_WAKE_MODE
#define MITR_GATEWAY_SERVER_WAKE_MODE 0
#endif

#if !MITR_GATEWAY_SERVER_WAKE_MODE
#include "wake_word.h"
#endif

static const char *TAG = "mitr_gateway";

#define GATEWAY_MIC_SAMPLES      512
#define GATEWAY_PCM_PACKET_BYTES 640
#define GATEWAY_QUEUE_DEPTH      24
#define GATEWAY_CONNECT_TIMEOUT_MS 15000
#define GATEWAY_SEND_TIMEOUT_MS 1000
#define GATEWAY_RECONNECT_TIMEOUT_MS 1000

typedef struct {
    int sample_count;
    int16_t samples[GATEWAY_MIC_SAMPLES];
} gateway_mic_frame_t;

typedef struct {
    int byte_count;
    uint8_t bytes[GATEWAY_PCM_PACKET_BYTES];
} gateway_playback_frame_t;

static esp_websocket_client_handle_t s_ws = NULL;
static QueueHandle_t s_mic_queue = NULL;
static QueueHandle_t s_playback_queue = NULL;
static TaskHandle_t s_sender_task = NULL;
static TaskHandle_t s_playback_task = NULL;
static volatile bool s_connected = false;
static volatile bool s_started = false;
static volatile bool s_active = false;
#if !MITR_GATEWAY_SERVER_WAKE_MODE
static uint32_t s_wake_generation = 0;
#endif

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

static void reset_gateway_queues(void)
{
    if (s_mic_queue != NULL) {
        xQueueReset(s_mic_queue);
    }
    if (s_playback_queue != NULL) {
        xQueueReset(s_playback_queue);
    }
}

static void cleanup_start_failure(void)
{
    if (s_ws != NULL) {
        esp_websocket_client_stop(s_ws);
        esp_websocket_client_destroy(s_ws);
        s_ws = NULL;
    }
    if (s_mic_queue != NULL) {
        vQueueDelete(s_mic_queue);
        s_mic_queue = NULL;
    }
    if (s_playback_queue != NULL) {
        vQueueDelete(s_playback_queue);
        s_playback_queue = NULL;
    }
    s_connected = false;
}

static void gateway_mic_tap(const int16_t *mono_pcm, size_t n_samples, void *ctx)
{
    (void)ctx;
    if (!s_started || !s_connected || (!MITR_GATEWAY_SERVER_WAKE_MODE && !s_active) ||
        s_mic_queue == NULL || mono_pcm == NULL) {
        return;
    }

    gateway_mic_frame_t frame = {
        .sample_count = n_samples > GATEWAY_MIC_SAMPLES ? GATEWAY_MIC_SAMPLES : (int)n_samples,
    };
    if (frame.sample_count <= 0) {
        return;
    }
    memcpy(frame.samples, mono_pcm, (size_t)frame.sample_count * sizeof(int16_t));
    (void)xQueueSend(s_mic_queue, &frame, 0);
}

static void send_gateway_control(const char *type)
{
    if (!s_ws || !s_connected || !type) {
        return;
    }

    char payload[384];
    int written = snprintf(
        payload,
        sizeof(payload),
        "{\"type\":\"%s\",\"deviceId\":\"%s\",\"language\":\"%s\",\"ts\":%lld}",
        type,
        mitr_device_device_id(),
        mitr_device_language(),
        now_ms());
    if (written <= 0 || written >= (int)sizeof(payload)) {
        return;
    }
    (void)esp_websocket_client_send_text(s_ws, payload, written, pdMS_TO_TICKS(GATEWAY_SEND_TIMEOUT_MS));
}

static bool send_pcm_packet(const uint8_t *bytes, int byte_count)
{
    if (!s_ws || !s_connected || (!MITR_GATEWAY_SERVER_WAKE_MODE && !s_active) ||
        bytes == NULL || byte_count <= 0) {
        return false;
    }
    if (!esp_websocket_client_is_connected(s_ws)) {
        s_connected = false;
        return false;
    }

    int sent = esp_websocket_client_send_bin(
        s_ws,
        (const char *)bytes,
        byte_count,
        pdMS_TO_TICKS(GATEWAY_SEND_TIMEOUT_MS));
    if (sent != byte_count) {
        ESP_LOGW(TAG, "Failed to send PCM packet: sent=%d expected=%d", sent, byte_count);
        return false;
    }
    return true;
}

static void sender_task(void *arg)
{
    (void)arg;
    gateway_mic_frame_t frame = {0};
    uint8_t packet[GATEWAY_PCM_PACKET_BYTES] = {0};
    int packet_bytes = 0;

    while (s_started) {
        if (xQueueReceive(s_mic_queue, &frame, pdMS_TO_TICKS(100)) != pdTRUE) {
            if (!MITR_GATEWAY_SERVER_WAKE_MODE && !s_active) {
                packet_bytes = 0;
            }
            continue;
        }
        if (!s_connected || (!MITR_GATEWAY_SERVER_WAKE_MODE && !s_active) || s_ws == NULL) {
            packet_bytes = 0;
            continue;
        }

        const uint8_t *src = (const uint8_t *)frame.samples;
        int remaining = frame.sample_count * (int)sizeof(int16_t);
        int offset = 0;

        while (remaining > 0 && s_started && s_connected &&
               (MITR_GATEWAY_SERVER_WAKE_MODE || s_active)) {
            int capacity = GATEWAY_PCM_PACKET_BYTES - packet_bytes;
            int copy_bytes = remaining < capacity ? remaining : capacity;
            memcpy(packet + packet_bytes, src + offset, (size_t)copy_bytes);
            packet_bytes += copy_bytes;
            offset += copy_bytes;
            remaining -= copy_bytes;

            if (packet_bytes == GATEWAY_PCM_PACKET_BYTES) {
                if (!send_pcm_packet(packet, packet_bytes)) {
                    packet_bytes = 0;
                    break;
                }
                packet_bytes = 0;
            }
        }
    }
    vTaskDelete(NULL);
}

static void playback_task(void *arg)
{
    (void)arg;
    gateway_playback_frame_t frame = {0};
    while (s_started) {
        if (xQueueReceive(s_playback_queue, &frame, pdMS_TO_TICKS(100)) != pdTRUE) {
            continue;
        }
        if (frame.byte_count <= 0) {
            continue;
        }
        (void)media_stream_write_mono_pcm16((const int16_t *)frame.bytes, frame.byte_count / 2);
    }
    media_stream_playback_stop();
    vTaskDelete(NULL);
}

#if !MITR_GATEWAY_SERVER_WAKE_MODE
static void conversation_window_task(void *arg)
{
    const uint32_t generation = (uint32_t)(uintptr_t)arg;
    vTaskDelay(pdMS_TO_TICKS(CONFIG_MITR_GATEWAY_TALK_WINDOW_SEC * 1000));
    if (s_active && generation == s_wake_generation) {
        s_active = false;
        send_gateway_control("stop");
        media_stream_playback_stop();
        mitr_boot_feedback_set_state(MITR_BOOT_STATE_READY_CONNECTED);
        wake_word_rearm();
        ESP_LOGI(TAG, "Gateway talk window ended; local wake rearmed");
    }
    vTaskDelete(NULL);
}
#endif

static void handle_ws_data(const esp_websocket_event_data_t *data)
{
    if (!data || !data->data_ptr || data->data_len <= 0) {
        return;
    }

    uint8_t first_byte = (uint8_t)data->data_ptr[0];
    bool looks_like_json = first_byte == '{' || first_byte == '[';
    if (data->op_code == 0x2 || !looks_like_json) {
        if (s_playback_queue == NULL) {
            return;
        }
        gateway_playback_frame_t frame = {0};
        frame.byte_count = data->data_len > GATEWAY_PCM_PACKET_BYTES
            ? GATEWAY_PCM_PACKET_BYTES
            : data->data_len;
        memcpy(frame.bytes, data->data_ptr, (size_t)frame.byte_count);
        (void)xQueueSend(s_playback_queue, &frame, 0);
        return;
    }

    char preview[160];
    int len = data->data_len < ((int)sizeof(preview) - 1) ? data->data_len : ((int)sizeof(preview) - 1);
    memcpy(preview, data->data_ptr, (size_t)len);
    preview[len] = '\0';
    ESP_LOGD(TAG, "Gateway text: %s", preview);
}

static void websocket_event_handler(void *handler_args, esp_event_base_t base, int32_t event_id, void *event_data)
{
    (void)handler_args;
    (void)base;
    esp_websocket_event_data_t *data = (esp_websocket_event_data_t *)event_data;

    switch (event_id) {
        case WEBSOCKET_EVENT_CONNECTED:
            s_connected = true;
            if (MITR_GATEWAY_SERVER_WAKE_MODE) {
                reset_gateway_queues();
            }
            ESP_LOGI(TAG, "Gateway connected");
            send_gateway_control("hello");
            break;
        case WEBSOCKET_EVENT_DISCONNECTED:
        case WEBSOCKET_EVENT_CLOSED:
            s_connected = false;
            s_active = false;
            reset_gateway_queues();
            media_stream_playback_stop();
            ESP_LOGW(TAG, "Disconnected from Pipecat gateway");
            break;
        case WEBSOCKET_EVENT_DATA:
            handle_ws_data(data);
            break;
        case WEBSOCKET_EVENT_ERROR:
            ESP_LOGW(TAG, "Pipecat gateway websocket error");
            break;
        default:
            break;
    }
}

esp_err_t mitr_gateway_client_start(void)
{
    if (s_started) {
        return ESP_OK;
    }

    s_mic_queue = xQueueCreate(GATEWAY_QUEUE_DEPTH, sizeof(gateway_mic_frame_t));
    s_playback_queue = xQueueCreate(GATEWAY_QUEUE_DEPTH, sizeof(gateway_playback_frame_t));
    if (s_mic_queue == NULL || s_playback_queue == NULL) {
        ESP_LOGE(TAG, "Failed to allocate gateway queues");
        cleanup_start_failure();
        return ESP_ERR_NO_MEM;
    }

    char ws_url[256];
    int url_len = snprintf(
        ws_url,
        sizeof(ws_url),
        "%s?deviceId=%s&language=%s",
        CONFIG_MITR_GATEWAY_WS_URL,
        mitr_device_device_id(),
        mitr_device_language());
    if (url_len <= 0 || url_len >= (int)sizeof(ws_url)) {
        ESP_LOGE(TAG, "Gateway websocket URL is too long");
        cleanup_start_failure();
        return ESP_ERR_INVALID_SIZE;
    }

    char ws_headers[320];
    int headers_len = snprintf(
        ws_headers,
        sizeof(ws_headers),
        "Authorization: Bearer %s\r\n"
        "X-Mitr-Device-Id: %s\r\n"
        "X-Mitr-Language: %s\r\n",
        mitr_device_storage_access_token(),
        mitr_device_device_id(),
        mitr_device_language());
    if (headers_len <= 0 || headers_len >= (int)sizeof(ws_headers)) {
        ESP_LOGE(TAG, "Gateway websocket headers are too long");
        cleanup_start_failure();
        return ESP_ERR_INVALID_SIZE;
    }

    esp_websocket_client_config_t config = {
        .uri = ws_url,
        .headers = ws_headers,
        .buffer_size = 4096,
        .network_timeout_ms = 30000,
        .reconnect_timeout_ms = GATEWAY_RECONNECT_TIMEOUT_MS,
        .disable_auto_reconnect = false,
        .enable_close_reconnect = true,
        .keep_alive_enable = true,
        .user_agent = "mitr-esp32-pipecat-gateway/0.1",
#ifdef CONFIG_MBEDTLS_CERTIFICATE_BUNDLE
        .crt_bundle_attach = esp_crt_bundle_attach,
#endif
    };

    s_ws = esp_websocket_client_init(&config);
    if (s_ws == NULL) {
        ESP_LOGE(TAG, "Failed to init gateway websocket client");
        cleanup_start_failure();
        return ESP_FAIL;
    }

    esp_err_t err = esp_websocket_register_events(s_ws, WEBSOCKET_EVENT_ANY, websocket_event_handler, NULL);
    if (err != ESP_OK) {
        cleanup_start_failure();
        return err;
    }
    err = esp_websocket_client_start(s_ws);
    if (err != ESP_OK) {
        cleanup_start_failure();
        ESP_LOGE(TAG, "Failed to start gateway websocket");
        return err;
    }

    int64_t wait_started_ms = now_ms();
    while (!s_connected && (now_ms() - wait_started_ms) < GATEWAY_CONNECT_TIMEOUT_MS) {
        vTaskDelay(pdMS_TO_TICKS(50));
    }
    if (!s_connected) {
        cleanup_start_failure();
        ESP_LOGE(TAG, "Timed out connecting to Pipecat gateway");
        return ESP_ERR_TIMEOUT;
    }

    err = mitr_preconnect_audio_src_register_tap(gateway_mic_tap, NULL);
    if (err != ESP_OK) {
        cleanup_start_failure();
        ESP_LOGE(TAG, "Failed to register mic tap");
        return err;
    }

    s_started = true;
    if (MITR_GATEWAY_SERVER_WAKE_MODE) {
        ESP_LOGI(TAG, "Gateway audio stream ready: backend wake phrase mode");
    }
    xTaskCreatePinnedToCore(
        sender_task,
        "gateway_send",
        MITR_GATEWAY_SERVER_WAKE_MODE ? 8192 : 4096,
        NULL,
        5,
        &s_sender_task,
        tskNO_AFFINITY);
    xTaskCreatePinnedToCore(playback_task, "gateway_play", 4096, NULL, 5, &s_playback_task, tskNO_AFFINITY);
    return ESP_OK;
}

void mitr_gateway_client_stop(void)
{
    if (!s_started) {
        return;
    }
    s_started = false;
    s_active = false;
    s_connected = false;
    mitr_preconnect_audio_src_unregister_tap(gateway_mic_tap, NULL);
    if (s_ws != NULL) {
        esp_websocket_client_stop(s_ws);
        esp_websocket_client_destroy(s_ws);
        s_ws = NULL;
    }
    if (s_mic_queue != NULL) {
        vQueueDelete(s_mic_queue);
        s_mic_queue = NULL;
    }
    if (s_playback_queue != NULL) {
        vQueueDelete(s_playback_queue);
        s_playback_queue = NULL;
    }
    media_stream_playback_stop();
}

bool mitr_gateway_client_is_connected(void)
{
    return s_connected;
}

bool mitr_gateway_client_is_active(void)
{
    if (MITR_GATEWAY_SERVER_WAKE_MODE) {
        return false;
    }
    return s_active;
}

void mitr_gateway_client_on_wake_detected(void)
{
#if MITR_GATEWAY_SERVER_WAKE_MODE
    return;
#else
    if (!s_connected) {
        ESP_LOGW(TAG, "Wake detected but gateway is not connected");
        wake_word_rearm();
        return;
    }
    if (s_active) {
        ESP_LOGW(TAG, "Ignoring wake because gateway conversation is already active");
        return;
    }

    s_wake_generation += 1;
    xQueueReset(s_mic_queue);
    xQueueReset(s_playback_queue);
    s_active = true;
    mitr_boot_feedback_set_state(MITR_BOOT_STATE_ACTIVE_SESSION);
    send_gateway_control("wake");
    ESP_LOGI(TAG, "Gateway wake started for %d seconds", CONFIG_MITR_GATEWAY_TALK_WINDOW_SEC);
    xTaskCreatePinnedToCore(
        conversation_window_task,
        "gateway_window",
        3072,
        (void *)(uintptr_t)s_wake_generation,
        5,
        NULL,
        tskNO_AFFINITY);
#endif
}
