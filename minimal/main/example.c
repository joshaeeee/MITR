#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "livekit.h"

#include "device_api.h"
#include "example.h"
#include "media.h"
#include "ota_manager.h"
#include "session_timeout.h"

static const char *TAG = "mitr_livekit_device";
static const char *DEVICE_EVENT_TOPIC = "mitr.device_event";
static const char *DEVICE_CONTROL_TOPIC = "mitr.device_control";

static livekit_room_handle_t room_handle;

typedef struct {
    mitr_device_token_response_t token;
    livekit_connection_state_t connection_state;
    bool agent_joined;
    bool session_end_sent;
    bool restart_requested;
    bool last_boot_ok;
    TaskHandle_t heartbeat_task;
    int reconnect_attempt_count;
    int reconnect_window_sec;
    int heartbeat_interval_sec;
    int telemetry_backoff_sec;
    char last_failure_reason[64];
    char last_end_reason[64];
} session_state_t;

static session_state_t session = {
    .connection_state = LIVEKIT_CONNECTION_STATE_DISCONNECTED,
    .reconnect_window_sec = 180,
    .heartbeat_interval_sec = CONFIG_MITR_DEVICE_HEARTBEAT_INTERVAL_SEC,
    .telemetry_backoff_sec = 30,
};

static void copy_string(char *dest, size_t capacity, const char *value)
{
    if (!dest || capacity == 0) {
        return;
    }
    strlcpy(dest, value ? value : "", capacity);
}

static int current_wifi_rssi_dbm(void)
{
    wifi_ap_record_t ap_info = {0};
    if (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) {
        return ap_info.rssi;
    }
    return 0;
}

static void publish_device_event(const char *event_type, const char *detail)
{
    if (room_handle == NULL || event_type == NULL || event_type[0] == '\0') {
        return;
    }

    char payload_json[768];
    int written = snprintf(
        payload_json,
        sizeof(payload_json),
        "{\"eventType\":\"%s\",\"detail\":\"%s\",\"deviceId\":\"%s\",\"roomName\":\"%s\",\"connectionState\":\"%s\",\"reconnectAttemptCount\":%d,\"lastFailureReason\":\"%s\",\"muted\":%s,\"otaState\":\"%s\",\"otaTargetVersion\":\"%s\"}",
        event_type,
        detail ? detail : "",
        session.token.device_id ? session.token.device_id : mitr_device_device_id(),
        session.token.room_name ? session.token.room_name : "",
        livekit_connection_state_str(session.connection_state),
        session.reconnect_attempt_count,
        session.last_failure_reason,
        media_is_input_muted() ? "true" : "false",
        mitr_ota_state(),
        mitr_ota_target_version());
    if (!(written > 0 && written < (int)sizeof(payload_json))) {
        ESP_LOGW(TAG, "Skipping device event %s because payload is too large", event_type);
        return;
    }

    livekit_data_payload_t payload = {
        .bytes = (uint8_t *)payload_json,
        .size = strlen(payload_json),
    };
    livekit_data_publish_options_t options = {
        .payload = &payload,
        .topic = (char *)DEVICE_EVENT_TOPIC,
        .lossy = false,
        .destination_identities = NULL,
        .destination_identities_count = 0,
    };

    livekit_err_t err = livekit_room_publish_data(room_handle, &options);
    if (err != LIVEKIT_ERR_NONE) {
        ESP_LOGW(TAG, "Failed to publish device event %s: %d", event_type, err);
    }
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

static void set_last_end_reason(const char *reason)
{
    copy_string(session.last_end_reason, sizeof(session.last_end_reason), reason);
}

static void update_failure_reason_from_room(void)
{
    if (room_handle == NULL) {
        return;
    }
    livekit_failure_reason_t reason = livekit_room_get_failure_reason(room_handle);
    if (reason == LIVEKIT_FAILURE_REASON_NONE) {
        return;
    }
    copy_string(session.last_failure_reason, sizeof(session.last_failure_reason), livekit_failure_reason_str(reason));
    ESP_LOGE(TAG, "Failure reason: %s", session.last_failure_reason);
}

static void report_session_end(const char *reason)
{
    const char *effective_reason =
        (reason && reason[0] != '\0') ? reason : (session.last_end_reason[0] != '\0' ? session.last_end_reason : "device_shutdown");

    if (session.session_end_sent || !session.token.session_id) {
        return;
    }

    esp_err_t err = mitr_device_end_session(session.token.session_id, effective_reason);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Failed to report session end: %s", esp_err_to_name(err));
    } else {
        session.session_end_sent = true;
        set_last_end_reason(effective_reason);
    }
}

static void apply_session_policy(const mitr_device_heartbeat_response_t *response)
{
    if (!response || !response->session_policy.has_session_policy) {
        return;
    }

    if (response->session_policy.heartbeat_interval_sec > 0) {
        session.heartbeat_interval_sec = response->session_policy.heartbeat_interval_sec;
    }
    if (response->session_policy.reconnect_window_sec > 0) {
        session.reconnect_window_sec = response->session_policy.reconnect_window_sec;
    }
    if (response->session_policy.telemetry_backoff_sec > 0) {
        session.telemetry_backoff_sec = response->session_policy.telemetry_backoff_sec;
    }
}

static void apply_recommended_firmware(const mitr_device_heartbeat_response_t *response)
{
    const bool had_pending_update = mitr_ota_has_pending_update();
    mitr_ota_apply_heartbeat_response(response);
    if (!had_pending_update && mitr_ota_has_pending_update()) {
        ESP_LOGI(
            TAG,
            "Firmware update available: version=%s url=%s mandatory=%d",
            response->recommended_firmware.version,
            response->recommended_firmware.download_url,
            response->recommended_firmware.mandatory);
        publish_device_event("ota_available", response->recommended_firmware.version);
        report_telemetry("ota_available", "info", response->recommended_firmware.version);
    }
}

static void heartbeat_task(void *arg)
{
    while (room_handle != NULL) {
        const livekit_connection_state_t state = session.connection_state;
        if (state == LIVEKIT_CONNECTION_STATE_CONNECTED || state == LIVEKIT_CONNECTION_STATE_RECONNECTING) {
            mitr_device_heartbeat_t heartbeat = {
                .session_id = session.token.session_id,
                .wifi_rssi_dbm = current_wifi_rssi_dbm(),
                .network_type = "wifi",
                .ip_address = NULL,
                .connection_state = livekit_connection_state_str(state),
                .last_failure_reason = session.last_failure_reason,
                .last_end_reason = session.last_end_reason,
                .reconnect_state = livekit_connection_state_str(state),
                .reconnect_attempt_count = session.reconnect_attempt_count,
                .ota_state = mitr_ota_state(),
                .ota_target_version = mitr_ota_target_version(),
                .last_boot_ok = session.last_boot_ok,
                .muted = media_is_input_muted(),
                .speaker_muted = media_is_output_muted(),
                .speaker_volume = media_get_output_volume(),
            };
            mitr_device_heartbeat_response_t response = {0};
            esp_err_t err = mitr_device_send_heartbeat(&heartbeat, &response);
            if (err != ESP_OK) {
                ESP_LOGW(TAG, "Heartbeat failed: %s", esp_err_to_name(err));
            } else {
                mitr_ota_note_heartbeat_success();
                apply_session_policy(&response);
                apply_recommended_firmware(&response);
            }
        }

        if (state == LIVEKIT_CONNECTION_STATE_FAILED || state == LIVEKIT_CONNECTION_STATE_DISCONNECTED) {
            report_session_end(state == LIVEKIT_CONNECTION_STATE_FAILED ? "room_failed" : "room_disconnected");
            break;
        }

        const int delay_sec = session.heartbeat_interval_sec > 0
            ? session.heartbeat_interval_sec
            : CONFIG_MITR_DEVICE_HEARTBEAT_INTERVAL_SEC;
        vTaskDelay(pdMS_TO_TICKS(delay_sec * 1000));
    }

    session.heartbeat_task = NULL;
    vTaskDelete(NULL);
}

static esp_err_t set_device_muted(bool muted, const char *source)
{
    esp_err_t err = media_set_input_muted(muted);
    if (err != ESP_OK) {
        return err;
    }

    publish_device_event("mute_changed", muted ? "muted" : "unmuted");
    report_telemetry("mute_changed", "info", muted ? "device_muted" : "device_unmuted");
    ESP_LOGI(TAG, "Input mute changed via %s: muted=%d", source ? source : "unknown", muted);
    return ESP_OK;
}

static void request_session_restart(const char *reason)
{
    session.restart_requested = true;
    set_last_end_reason(reason && reason[0] != '\0' ? reason : "remote_restart");
    publish_device_event("restart_requested", session.last_end_reason);
    report_telemetry("restart_requested", "warn", session.last_end_reason);
}

static void on_state_changed(livekit_connection_state_t state, void *ctx)
{
    const livekit_connection_state_t previous_state = session.connection_state;
    session.connection_state = state;
    ESP_LOGI(TAG, "Room state changed: %s", livekit_connection_state_str(state));

    if (room_handle != NULL) {
        update_failure_reason_from_room();
    }

    switch (state) {
        case LIVEKIT_CONNECTION_STATE_CONNECTED:
            session.last_boot_ok = true;
            set_last_end_reason("");
            // Room connected — reset inactivity timer so the session doesn't
            // time out before the agent spawns and responds.
            session_timeout_notify_activity();
            if (previous_state == LIVEKIT_CONNECTION_STATE_RECONNECTING) {
                publish_device_event("reconnected", "room_reconnected");
                report_telemetry("room_reconnected", "info", "LiveKit room reconnected");
            } else {
                publish_device_event("room_connected", "room_connected");
                report_telemetry("room_connected", "info", "LiveKit room connected");
            }
            break;
        case LIVEKIT_CONNECTION_STATE_RECONNECTING:
            session.reconnect_attempt_count += 1;
            publish_device_event("reconnecting", "room_reconnecting");
            report_telemetry("room_reconnecting", "warn", "LiveKit room reconnecting");
            break;
        case LIVEKIT_CONNECTION_STATE_FAILED:
            if (session.last_failure_reason[0] == '\0') {
                copy_string(session.last_failure_reason, sizeof(session.last_failure_reason), "room_failed");
            }
            set_last_end_reason("room_failed");
            publish_device_event("session_failed", session.last_failure_reason);
            report_telemetry("room_failed", "error", session.last_failure_reason);
            report_session_end("room_failed");
            break;
        case LIVEKIT_CONNECTION_STATE_DISCONNECTED:
            if (session.last_failure_reason[0] == '\0') {
                copy_string(session.last_failure_reason, sizeof(session.last_failure_reason), "room_disconnected");
            }
            set_last_end_reason("room_disconnected");
            publish_device_event("session_failed", session.last_failure_reason);
            report_telemetry("room_disconnected", "warn", session.last_failure_reason);
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
    publish_device_event(joined ? "agent_joined" : "agent_left", joined ? "agent_joined" : "agent_left");
    report_telemetry(joined ? "agent_joined" : "agent_left", "info", joined ? "Agent participant active" : "Agent participant left");

    // Agent joining counts as activity — reset the inactivity timer so the
    // session doesn't time out before the agent has a chance to process audio
    // and respond. Without this, a slow agent (>20s first response) would always
    // trigger the inactivity timeout even when the session is healthy.
    if (joined) {
        session_timeout_notify_activity();
    }
}

static void handle_device_control_message(const cJSON *root)
{
    const cJSON *action = cJSON_GetObjectItemCaseSensitive(root, "action");
    if (!cJSON_IsString(action) || !action->valuestring) {
        return;
    }

    if (strcmp(action->valuestring, "set_mute") == 0) {
        const cJSON *muted = cJSON_GetObjectItemCaseSensitive(root, "muted");
        if (cJSON_IsBool(muted)) {
            esp_err_t err = set_device_muted(cJSON_IsTrue(muted), "data_channel");
            if (err != ESP_OK) {
                ESP_LOGW(TAG, "Failed to apply mute from data channel: %s", esp_err_to_name(err));
            }
        }
        return;
    }

    if (strcmp(action->valuestring, "restart_session") == 0) {
        request_session_restart("remote_restart");
        return;
    }
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

    /* Any data from the server counts as activity — reset inactivity timer */
    session_timeout_notify_activity();

    if (!data->topic || strcmp(data->topic, DEVICE_CONTROL_TOPIC) != 0) {
        return;
    }

    cJSON *root = cJSON_ParseWithLength((const char *)data->payload.bytes, data->payload.size);
    if (!root) {
        ESP_LOGW(TAG, "Ignoring invalid JSON control packet");
        return;
    }
    handle_device_control_message(root);
    cJSON_Delete(root);
}

static void rpc_ping(const livekit_rpc_invocation_t *invocation, void *ctx)
{
    livekit_rpc_return_ok("{\"ok\":true}");
}

static void rpc_get_device_status(const livekit_rpc_invocation_t *invocation, void *ctx)
{
    char payload[768];
    snprintf(
        payload,
        sizeof(payload),
        "{\"deviceId\":\"%s\",\"userId\":\"%s\",\"firmwareVersion\":\"%s\",\"hardwareRev\":\"%s\",\"language\":\"%s\",\"roomName\":\"%s\",\"connectionState\":\"%s\",\"muted\":%s,\"reconnectAttemptCount\":%d,\"lastFailureReason\":\"%s\",\"otaState\":\"%s\",\"otaTargetVersion\":\"%s\"}",
        session.token.device_id ? session.token.device_id : "",
        session.token.user_id ? session.token.user_id : "",
        mitr_device_firmware_version(),
        mitr_device_hardware_rev(),
        mitr_device_language(),
        session.token.room_name ? session.token.room_name : "",
        livekit_connection_state_str(session.connection_state),
        media_is_input_muted() ? "true" : "false",
        session.reconnect_attempt_count,
        session.last_failure_reason,
        mitr_ota_state(),
        mitr_ota_target_version());
    livekit_rpc_return_ok(payload);
}

static void rpc_get_diagnostics(const livekit_rpc_invocation_t *invocation, void *ctx)
{
    char payload[1024];
    snprintf(
        payload,
        sizeof(payload),
        "{\"deviceId\":\"%s\",\"firmwareVersion\":\"%s\",\"hardwareRev\":\"%s\",\"connectionState\":\"%s\",\"agentJoined\":%s,\"muted\":%s,\"speakerMuted\":%s,\"speakerVolume\":%d,\"wifiRssiDbm\":%d,\"freeHeapBytes\":%u,\"freePsramBytes\":%u,\"reconnectAttemptCount\":%d,\"lastFailureReason\":\"%s\",\"lastEndReason\":\"%s\",\"otaState\":\"%s\",\"otaTargetVersion\":\"%s\",\"otaLastError\":\"%s\",\"otaPendingVerify\":%s,\"otaValidationHeartbeats\":%d}",
        session.token.device_id ? session.token.device_id : mitr_device_device_id(),
        mitr_device_firmware_version(),
        mitr_device_hardware_rev(),
        livekit_connection_state_str(session.connection_state),
        session.agent_joined ? "true" : "false",
        media_is_input_muted() ? "true" : "false",
        media_is_output_muted() ? "true" : "false",
        media_get_output_volume(),
        current_wifi_rssi_dbm(),
        (unsigned)esp_get_free_heap_size(),
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
        session.reconnect_attempt_count,
        session.last_failure_reason,
        session.last_end_reason,
        mitr_ota_state(),
        mitr_ota_target_version(),
        mitr_ota_last_error(),
        mitr_ota_pending_verify() ? "true" : "false",
        mitr_ota_validation_heartbeat_count());
    livekit_rpc_return_ok(payload);
}

static void rpc_set_mute(const livekit_rpc_invocation_t *invocation, void *ctx)
{
    if (invocation->payload == NULL) {
        livekit_rpc_return_error("Missing payload");
        return;
    }

    cJSON *root = cJSON_Parse(invocation->payload);
    if (!root) {
        livekit_rpc_return_error("Invalid JSON");
        return;
    }

    const cJSON *muted = cJSON_GetObjectItemCaseSensitive(root, "muted");
    if (!cJSON_IsBool(muted)) {
        cJSON_Delete(root);
        livekit_rpc_return_error("Unexpected JSON format");
        return;
    }

    esp_err_t err = set_device_muted(cJSON_IsTrue(muted), "rpc");
    cJSON_Delete(root);
    if (err != ESP_OK) {
        livekit_rpc_return_error("Failed to apply mute");
        return;
    }

    char payload[64];
    snprintf(payload, sizeof(payload), "{\"ok\":true,\"muted\":%s}", media_is_input_muted() ? "true" : "false");
    livekit_rpc_return_ok(payload);
}

static void rpc_restart_session(const livekit_rpc_invocation_t *invocation, void *ctx)
{
    request_session_restart("remote_restart");
    livekit_rpc_return_ok("{\"ok\":true}");
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
    session.restart_requested = false;
    mitr_device_token_response_free(&session.token);
}

bool join_room(void)
{
    if (room_handle != NULL) {
        ESP_LOGW(TAG, "Room already created");
        return true;
    }

    session.restart_requested = false;
    session.session_end_sent = false;
    session.reconnect_attempt_count = 0;
    session.last_failure_reason[0] = '\0';
    session.last_end_reason[0] = '\0';

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
    livekit_room_rpc_register(room_handle, "mitr_get_diagnostics", rpc_get_diagnostics);
    livekit_room_rpc_register(room_handle, "mitr_set_mute", rpc_set_mute);
    livekit_room_rpc_register(room_handle, "mitr_restart_session", rpc_restart_session);

    session.connection_state = LIVEKIT_CONNECTION_STATE_CONNECTING;
    report_telemetry("session_bootstrap", "info", "Fetched LiveKit token and starting room connect");

    livekit_err_t connect_res = livekit_room_connect(room_handle, session.token.server_url, session.token.participant_token);
    if (connect_res != LIVEKIT_ERR_NONE) {
        ESP_LOGE(TAG, "Failed to connect to room");
        copy_string(session.last_failure_reason, sizeof(session.last_failure_reason), "connect_error");
        report_telemetry("room_connect_error", "error", "livekit_room_connect returned an error");
        cleanup_room();
        return false;
    }

    if (session.heartbeat_task == NULL) {
        xTaskCreatePinnedToCore(heartbeat_task, "mitr_heartbeat", 8192, NULL, 5, &session.heartbeat_task, tskNO_AFFINITY);
    }

    return true;
}

void leave_room(void)
{
    const char *reason =
        session.restart_requested
            ? (session.last_end_reason[0] != '\0' ? session.last_end_reason : "remote_restart")
            : (session.last_end_reason[0] != '\0' ? session.last_end_reason : "device_shutdown");
    report_session_end(reason);
    cleanup_room();
}

bool session_is_active(void)
{
    return room_handle != NULL &&
           !session.restart_requested &&
           session.connection_state != LIVEKIT_CONNECTION_STATE_FAILED &&
           session.connection_state != LIVEKIT_CONNECTION_STATE_DISCONNECTED;
}

int session_reconnect_window_sec(void)
{
    return session.reconnect_window_sec > 0 ? session.reconnect_window_sec : 180;
}
