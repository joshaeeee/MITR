#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "esp_err.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "livekit.h"

#include "device_api.h"
#include "example.h"
#include "media.h"

static const char *TAG = "mitr_livekit_device";

static livekit_room_handle_t room_handle;

typedef struct {
    mitr_device_token_response_t token;
    livekit_connection_state_t connection_state;
    bool agent_joined;
    bool session_end_sent;
    TaskHandle_t heartbeat_task;
} session_state_t;

static session_state_t session = {
    .connection_state = LIVEKIT_CONNECTION_STATE_DISCONNECTED,
};

static int current_wifi_rssi_dbm(void)
{
    wifi_ap_record_t ap_info = {0};
    if (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) {
        return ap_info.rssi;
    }
    return 0;
}

static void report_telemetry(const char *event_type, const char *level, const char *message)
{
    if (!session.token.session_id) {
        return;
    }

    esp_err_t err = mitr_device_send_telemetry(session.token.session_id, event_type, level, message);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Failed to send telemetry event %s: %s", event_type, esp_err_to_name(err));
    }
}

static void report_session_end(const char *reason)
{
    if (session.session_end_sent || !session.token.session_id) {
        return;
    }

    esp_err_t err = mitr_device_end_session(session.token.session_id, reason);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Failed to report session end: %s", esp_err_to_name(err));
    } else {
        session.session_end_sent = true;
    }
}

static void heartbeat_task(void *arg)
{
    const TickType_t delay_ticks = pdMS_TO_TICKS(CONFIG_MITR_DEVICE_HEARTBEAT_INTERVAL_SEC * 1000);

    while (room_handle != NULL) {
        const livekit_connection_state_t state = session.connection_state;
        if (state == LIVEKIT_CONNECTION_STATE_CONNECTED || state == LIVEKIT_CONNECTION_STATE_RECONNECTING) {
            mitr_device_heartbeat_t heartbeat = {
                .session_id = session.token.session_id,
                .wifi_rssi_dbm = current_wifi_rssi_dbm(),
                .network_type = "wifi",
                .ip_address = NULL,
                .connection_state = livekit_connection_state_str(state),
            };
            esp_err_t err = mitr_device_send_heartbeat(&heartbeat);
            if (err != ESP_OK) {
                ESP_LOGW(TAG, "Heartbeat failed: %s", esp_err_to_name(err));
            }
        }

        if (state == LIVEKIT_CONNECTION_STATE_FAILED || state == LIVEKIT_CONNECTION_STATE_DISCONNECTED) {
            report_session_end(state == LIVEKIT_CONNECTION_STATE_FAILED ? "room_failed" : "room_disconnected");
            break;
        }

        vTaskDelay(delay_ticks);
    }

    session.heartbeat_task = NULL;
    vTaskDelete(NULL);
}

static void on_state_changed(livekit_connection_state_t state, void *ctx)
{
    session.connection_state = state;
    ESP_LOGI(TAG, "Room state changed: %s", livekit_connection_state_str(state));

    if (room_handle != NULL) {
        livekit_failure_reason_t reason = livekit_room_get_failure_reason(room_handle);
        if (reason != LIVEKIT_FAILURE_REASON_NONE) {
            ESP_LOGE(TAG, "Failure reason: %s", livekit_failure_reason_str(reason));
        }
    }

    switch (state) {
        case LIVEKIT_CONNECTION_STATE_CONNECTED:
            report_telemetry("room_connected", "info", "LiveKit room connected");
            break;
        case LIVEKIT_CONNECTION_STATE_RECONNECTING:
            report_telemetry("room_reconnecting", "warn", "LiveKit room reconnecting");
            break;
        case LIVEKIT_CONNECTION_STATE_FAILED:
            report_telemetry("room_failed", "error", "LiveKit room connection failed");
            report_session_end("room_failed");
            break;
        case LIVEKIT_CONNECTION_STATE_DISCONNECTED:
            report_telemetry("room_disconnected", "warn", "LiveKit room disconnected");
            report_session_end("room_disconnected");
            break;
        default:
            break;
    }
}

static void on_participant_info(const livekit_participant_info_t *info, void *ctx)
{
    if (info->kind != LIVEKIT_PARTICIPANT_KIND_AGENT) {
        return;
    }

    bool joined = false;
    switch (info->state) {
        case LIVEKIT_PARTICIPANT_STATE_ACTIVE:
            joined = true;
            break;
        case LIVEKIT_PARTICIPANT_STATE_DISCONNECTED:
            joined = false;
            break;
        default:
            return;
    }

    if (joined == session.agent_joined) {
        return;
    }

    session.agent_joined = joined;
    ESP_LOGI(TAG, "Agent participant %s the room", joined ? "joined" : "left");
    report_telemetry(joined ? "agent_joined" : "agent_left", "info", joined ? "Agent participant active" : "Agent participant left");
}

static void on_data_received(const livekit_data_received_t *data, void *ctx)
{
    if (!data || !data->payload.bytes || data->payload.size == 0) {
        return;
    }

    const size_t preview_bytes = data->payload.size < 96 ? data->payload.size : 96;
    char preview[97];
    memcpy(preview, data->payload.bytes, preview_bytes);
    preview[preview_bytes] = '\0';

    ESP_LOGI(
        TAG,
        "Received data packet: sender=%s topic=%s size=%u preview=%s",
        data->sender_identity ? data->sender_identity : "(unknown)",
        data->topic ? data->topic : "(none)",
        (unsigned)data->payload.size,
        preview);
}

static void rpc_ping(const livekit_rpc_invocation_t *invocation, void *ctx)
{
    livekit_rpc_return_ok("{\"ok\":true}");
}

static void rpc_get_device_status(const livekit_rpc_invocation_t *invocation, void *ctx)
{
    char payload[512];
    snprintf(
        payload,
        sizeof(payload),
        "{\"deviceId\":\"%s\",\"userId\":\"%s\",\"firmwareVersion\":\"%s\",\"hardwareRev\":\"%s\",\"language\":\"%s\",\"roomName\":\"%s\",\"connectionState\":\"%s\"}",
        session.token.device_id ? session.token.device_id : "",
        session.token.user_id ? session.token.user_id : "",
        mitr_device_firmware_version(),
        mitr_device_hardware_rev(),
        mitr_device_language(),
        session.token.room_name ? session.token.room_name : "",
        livekit_connection_state_str(session.connection_state));
    livekit_rpc_return_ok(payload);
}

static void cleanup_room(void)
{
    if (room_handle != NULL) {
        if (livekit_room_close(room_handle) != LIVEKIT_ERR_NONE) {
            ESP_LOGW(TAG, "Failed to close room cleanly");
        }
        if (livekit_room_destroy(room_handle) != LIVEKIT_ERR_NONE) {
            ESP_LOGW(TAG, "Failed to destroy room cleanly");
        }
        room_handle = NULL;
    }

    session.connection_state = LIVEKIT_CONNECTION_STATE_DISCONNECTED;
    session.agent_joined = false;
    session.session_end_sent = false;
    mitr_device_token_response_free(&session.token);
}

bool join_room(void)
{
    if (room_handle != NULL) {
        ESP_LOGW(TAG, "Room already created");
        return true;
    }

    esp_err_t err = mitr_device_request_token(&session.token);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to fetch device token: %s", esp_err_to_name(err));
        return false;
    }

    ESP_LOGI(
        TAG,
        "Fetched session token: room=%s identity=%s backend=%s",
        session.token.room_name ? session.token.room_name : "(generated)",
        session.token.identity ? session.token.identity : "(generated)",
        mitr_device_backend_base_url());

    livekit_room_options_t room_options = {
        .publish = {
            .kind = LIVEKIT_MEDIA_TYPE_AUDIO,
            .audio_encode = {
                .codec = LIVEKIT_AUDIO_CODEC_OPUS,
                .sample_rate = 16000,
                .channel_count = 1,
            },
            .capturer = media_get_capturer(),
        },
        .subscribe = {
            .kind = LIVEKIT_MEDIA_TYPE_AUDIO,
            .renderer = media_get_renderer(),
        },
        .on_state_changed = on_state_changed,
        .on_participant_info = on_participant_info,
        .on_data_received = on_data_received,
    };

    if (livekit_room_create(&room_handle, &room_options) != LIVEKIT_ERR_NONE) {
        ESP_LOGE(TAG, "Failed to create LiveKit room");
        mitr_device_token_response_free(&session.token);
        return false;
    }

    livekit_room_rpc_register(room_handle, "mitr_ping", rpc_ping);
    livekit_room_rpc_register(room_handle, "mitr_get_device_status", rpc_get_device_status);

    session.connection_state = LIVEKIT_CONNECTION_STATE_CONNECTING;
    session.session_end_sent = false;
    report_telemetry("session_bootstrap", "info", "Fetched LiveKit token and starting room connect");

    livekit_err_t connect_res = livekit_room_connect(room_handle, session.token.server_url, session.token.participant_token);
    if (connect_res != LIVEKIT_ERR_NONE) {
        ESP_LOGE(TAG, "Failed to connect to room");
        report_telemetry("room_connect_error", "error", "livekit_room_connect returned an error");
        cleanup_room();
        return false;
    }

    if (session.heartbeat_task == NULL) {
        xTaskCreatePinnedToCore(heartbeat_task, "mitr_heartbeat", 6144, NULL, 5, &session.heartbeat_task, tskNO_AFFINITY);
    }

    return true;
}

void leave_room(void)
{
    report_session_end("device_shutdown");
    cleanup_room();
}

bool session_is_active(void)
{
    return room_handle != NULL &&
           session.connection_state != LIVEKIT_CONNECTION_STATE_FAILED &&
           session.connection_state != LIVEKIT_CONNECTION_STATE_DISCONNECTED;
}
