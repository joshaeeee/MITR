#include <stdbool.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>

#include "cJSON.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "livekit.h"

#include "device_api.h"
#include "example.h"
#include "latency_trace.h"
#include "media.h"
#include "ota_manager.h"
#include "boot_feedback.h"
#include "sounds.h"
#include "wake_word.h"

static const char *TAG = "mitr_livekit_device";
static const char *DEVICE_EVENT_TOPIC = "mitr.device_event";
static const char *DEVICE_CONTROL_TOPIC = "mitr.device_control";
static const float WAKEWORD_DETECTION_SCORE = 1.0f;

static livekit_room_handle_t room_handle;

typedef struct {
    mitr_device_token_response_t token;
    livekit_connection_state_t connection_state;
    bool agent_joined;
    bool session_end_sent;
    bool restart_requested;
    bool last_boot_ok;
    bool conversation_active;
    TaskHandle_t heartbeat_task;
    int reconnect_attempt_count;
    int reconnect_window_sec;
    int heartbeat_interval_sec;
    int telemetry_backoff_sec;
    uint32_t room_generation;
    char last_failure_reason[64];
    char last_end_reason[64];
} session_state_t;

static session_state_t session = {
    .connection_state = LIVEKIT_CONNECTION_STATE_DISCONNECTED,
    .reconnect_window_sec = 180,
    .heartbeat_interval_sec = CONFIG_MITR_DEVICE_HEARTBEAT_INTERVAL_SEC,
    .telemetry_backoff_sec = 30,
};

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

static uint32_t callback_room_generation(void *ctx)
{
    return (uint32_t)(uintptr_t)ctx;
}

static bool is_current_room_callback(void *ctx)
{
    return room_handle != NULL && callback_room_generation(ctx) == session.room_generation;
}

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
        "{\"eventType\":\"%s\",\"detail\":\"%s\",\"deviceId\":\"%s\",\"roomName\":\"%s\",\"connectionState\":\"%s\",\"reconnectAttemptCount\":%d,\"lastFailureReason\":\"%s\",\"conversationActive\":%s,\"otaState\":\"%s\",\"otaTargetVersion\":\"%s\"}",
        event_type,
        detail ? detail : "",
        session.token.device_id ? session.token.device_id : mitr_device_device_id(),
        session.token.room_name ? session.token.room_name : "",
        livekit_connection_state_str(session.connection_state),
        session.reconnect_attempt_count,
        session.last_failure_reason,
        session.conversation_active ? "true" : "false",
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

static void set_conversation_active(bool active, const char *reason, bool play_chime)
{
    session.conversation_active = active;
    mitr_boot_feedback_set_state(active ? MITR_BOOT_STATE_ACTIVE_SESSION : MITR_BOOT_STATE_READY_CONNECTED);
    if (active && play_chime) {
        sounds_play_chime();
    }
    if (!active) {
        mitr_latency_end_wake(reason ? reason : "conversation_ended");
    }
    publish_device_event(active ? "conversation_started" : "conversation_ended", reason);
    report_telemetry(active ? "conversation_started" : "conversation_ended", "info", reason ? reason : "");
}

static void request_session_restart(const char *reason)
{
    session.restart_requested = true;
    set_last_end_reason(reason && reason[0] != '\0' ? reason : "remote_restart");
    publish_device_event("restart_requested", session.last_end_reason);
    report_telemetry("restart_requested", "warn", session.last_end_reason);
}

bool session_begin_local_wake(const char *model_name, const char *phrase, bool play_chime)
{
    if (session.conversation_active) {
        ESP_LOGW(TAG, "Ignoring wake because a conversation is already active");
        return false;
    }

    mitr_latency_begin_wake("wake_detected");
    ESP_LOGI(TAG, "Wake word detected locally; activating conversation (model=%s, phrase=%s)",
             model_name ? model_name : "unknown",
             phrase ? phrase : "unknown");
    set_conversation_active(true, phrase ? phrase : "wake_detected", play_chime);
    mitr_latency_mark_wake("wake_local_ready");
    return true;
}

esp_err_t session_notify_wake_detected(const char *model_name, const char *phrase)
{
    if (!session.token.session_id || session.token.session_id[0] == '\0') {
        return ESP_ERR_INVALID_STATE;
    }

    mitr_latency_mark_wake("wake_notify_start");

    esp_err_t err = mitr_device_notify_wake_detected(
        session.token.session_id,
        model_name ? model_name : "unknown",
        phrase,
        WAKEWORD_DETECTION_SCORE);
    if (err != ESP_OK) {
        if (err == ESP_ERR_INVALID_STATE) {
            ESP_LOGW(TAG, "Backend already has a conversation in flight; staying active and waiting for agent state");
            mitr_latency_mark_wake("wake_notify_rejected");
            return err;
        }
        ESP_LOGW(TAG, "Wake notification rejected or failed: %s", esp_err_to_name(err));
        mitr_latency_mark_wake("wake_notify_failed");
        set_conversation_active(false, "wake_rejected", false);
        wake_word_rearm();
        return err;
    }
    mitr_latency_mark_wake("wake_notify_ok");
    return ESP_OK;
}

void on_wake_detected(void)
{
    const char *model_name = wake_word_model_name();
    const char *phrase = wake_word_phrase();
    if (!session_begin_local_wake(model_name, phrase, true)) {
        return;
    }
    (void)session_notify_wake_detected(model_name, phrase);
}

static void on_state_changed(livekit_connection_state_t state, void *ctx)
{
    if (!is_current_room_callback(ctx)) {
        ESP_LOGW(TAG, "Ignoring stale room state callback: state=%s gen=%u current=%u",
                 livekit_connection_state_str(state),
                 (unsigned)callback_room_generation(ctx),
                 (unsigned)session.room_generation);
        return;
    }

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
            mitr_latency_mark("room_connected");
            if (session.conversation_active) {
                mitr_latency_mark_wake("room_connected");
            }
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
            session.conversation_active = false;
            if (session.last_failure_reason[0] == '\0') {
                copy_string(session.last_failure_reason, sizeof(session.last_failure_reason), "room_failed");
            }
            set_last_end_reason("room_failed");
            publish_device_event("session_failed", session.last_failure_reason);
            report_telemetry("room_failed", "error", session.last_failure_reason);
            report_session_end("room_failed");
            break;
        case LIVEKIT_CONNECTION_STATE_DISCONNECTED:
            session.conversation_active = false;
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
    if (!is_current_room_callback(ctx)) {
        return;
    }

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
    if (joined) {
        mitr_latency_mark("agent_joined");
        if (session.conversation_active) {
            mitr_latency_mark_wake("agent_joined");
        }
    }
    publish_device_event(joined ? "agent_joined" : "agent_left", joined ? "agent_joined" : "agent_left");
    report_telemetry(joined ? "agent_joined" : "agent_left", "info", joined ? "Agent participant active" : "Agent participant left");
}

static void handle_device_control_message(const cJSON *root)
{
    const cJSON *action = cJSON_GetObjectItemCaseSensitive(root, "action");
    const char *action_str = (cJSON_IsString(action) && action->valuestring) ? action->valuestring : NULL;
    const cJSON *type = cJSON_GetObjectItemCaseSensitive(root, "type");
    const char *type_str = (cJSON_IsString(type) && type->valuestring) ? type->valuestring : NULL;
    const char *message_type = action_str ? action_str : type_str;

    if (!message_type) {
        return;
    }

    if (strcmp(message_type, "conversation_started") == 0) {
        const cJSON *wakeword = cJSON_GetObjectItemCaseSensitive(root, "wakeword");
        const char *reason = (cJSON_IsString(wakeword) && wakeword->valuestring) ? wakeword->valuestring : "wake_detected";
        if (!session.conversation_active) {
            set_conversation_active(true, reason, false);
        }
        return;
    }

    if (strcmp(message_type, "conversation_ended") == 0) {
        const cJSON *reason = cJSON_GetObjectItemCaseSensitive(root, "reason");
        const char *reason_str = (cJSON_IsString(reason) && reason->valuestring) ? reason->valuestring : "conversation_ended";
        set_conversation_active(false, reason_str, false);
        wake_word_rearm();
        return;
    }

    if (strcmp(message_type, "conversation_error") == 0) {
        const cJSON *reason = cJSON_GetObjectItemCaseSensitive(root, "reason");
        const char *reason_str = (cJSON_IsString(reason) && reason->valuestring) ? reason->valuestring : "conversation_error";
        session.conversation_active = false;
        mitr_boot_feedback_set_state(MITR_BOOT_STATE_READY_CONNECTED);
        publish_device_event("conversation_error", reason_str);
        report_telemetry("conversation_error", "warn", reason_str);
        wake_word_rearm();
        return;
    }

    if (strcmp(message_type, "restart_session") == 0) {
        request_session_restart("remote_restart");
        return;
    }
}

static void on_data_received(const livekit_data_received_t *data, void *ctx)
{
    if (!is_current_room_callback(ctx)) {
        return;
    }

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
        "{\"deviceId\":\"%s\",\"userId\":\"%s\",\"firmwareVersion\":\"%s\",\"hardwareRev\":\"%s\",\"language\":\"%s\",\"roomName\":\"%s\",\"connectionState\":\"%s\",\"conversationActive\":%s,\"reconnectAttemptCount\":%d,\"lastFailureReason\":\"%s\",\"otaState\":\"%s\",\"otaTargetVersion\":\"%s\"}",
        session.token.device_id ? session.token.device_id : "",
        session.token.user_id ? session.token.user_id : "",
        mitr_device_firmware_version(),
        mitr_device_hardware_rev(),
        mitr_device_language(),
        session.token.room_name ? session.token.room_name : "",
        livekit_connection_state_str(session.connection_state),
        session.conversation_active ? "true" : "false",
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
        "{\"deviceId\":\"%s\",\"firmwareVersion\":\"%s\",\"hardwareRev\":\"%s\",\"connectionState\":\"%s\",\"agentJoined\":%s,\"conversationActive\":%s,\"speakerMuted\":%s,\"speakerVolume\":%d,\"wifiRssiDbm\":%d,\"freeHeapBytes\":%u,\"freePsramBytes\":%u,\"reconnectAttemptCount\":%d,\"lastFailureReason\":\"%s\",\"lastEndReason\":\"%s\",\"otaState\":\"%s\",\"otaTargetVersion\":\"%s\",\"otaLastError\":\"%s\",\"otaPendingVerify\":%s,\"otaValidationHeartbeats\":%d}",
        session.token.device_id ? session.token.device_id : mitr_device_device_id(),
        mitr_device_firmware_version(),
        mitr_device_hardware_rev(),
        livekit_connection_state_str(session.connection_state),
        session.agent_joined ? "true" : "false",
        session.conversation_active ? "true" : "false",
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

static void rpc_restart_session(const livekit_rpc_invocation_t *invocation, void *ctx)
{
    request_session_restart("remote_restart");
    livekit_rpc_return_ok("{\"ok\":true}");
}

static void cleanup_room(void)
{
    livekit_room_handle_t handle = room_handle;
    room_handle = NULL;

    if (handle != NULL) {
        if (livekit_room_close(handle) != LIVEKIT_ERR_NONE) {
            ESP_LOGW(TAG, "Failed to close room cleanly");
        }
        vTaskDelay(pdMS_TO_TICKS(500));
        if (livekit_room_destroy(handle) != LIVEKIT_ERR_NONE) {
            ESP_LOGW(TAG, "Failed to destroy room cleanly");
        }
    }

    session.connection_state = LIVEKIT_CONNECTION_STATE_DISCONNECTED;
    session.agent_joined = false;
    session.conversation_active = false;
    session.session_end_sent = false;
    session.restart_requested = false;
    mitr_device_token_response_free(&session.token);
}

static bool wait_for_initial_connect(void)
{
    const int64_t deadline_ms = now_ms() + 15000;
    while (now_ms() < deadline_ms) {
        switch (session.connection_state) {
            case LIVEKIT_CONNECTION_STATE_CONNECTED:
                return true;
            case LIVEKIT_CONNECTION_STATE_FAILED:
            case LIVEKIT_CONNECTION_STATE_DISCONNECTED:
                return false;
            default:
                break;
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }

    copy_string(session.last_failure_reason, sizeof(session.last_failure_reason), "connect_timeout");
    ESP_LOGW(TAG, "Timed out waiting for initial room connection");
    return false;
}

static bool create_and_connect_room(void)
{
    const uint32_t room_generation = session.room_generation + 1;
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
        .ctx = (void *)(uintptr_t)room_generation,
    };

    if (livekit_room_create(&room_handle, &room_options) != LIVEKIT_ERR_NONE) {
        ESP_LOGE(TAG, "Failed to create LiveKit room");
        return false;
    }

    session.room_generation = room_generation;

    livekit_room_rpc_register(room_handle, "mitr_ping", rpc_ping);
    livekit_room_rpc_register(room_handle, "mitr_get_device_status", rpc_get_device_status);
    livekit_room_rpc_register(room_handle, "mitr_get_diagnostics", rpc_get_diagnostics);
    livekit_room_rpc_register(room_handle, "mitr_restart_session", rpc_restart_session);

    session.connection_state = LIVEKIT_CONNECTION_STATE_CONNECTING;
    mitr_latency_mark("room_connect_start");

    livekit_err_t connect_res = livekit_room_connect(room_handle, session.token.server_url, session.token.participant_token);
    if (connect_res != LIVEKIT_ERR_NONE) {
        ESP_LOGE(TAG, "Failed to connect to room");
        copy_string(session.last_failure_reason, sizeof(session.last_failure_reason), "connect_error");
        report_telemetry("room_connect_error", "error", "livekit_room_connect returned an error");
        cleanup_room();
        return false;
    }

    if (!wait_for_initial_connect()) {
        report_telemetry("room_connect_error", "error", session.last_failure_reason);
        cleanup_room();
        return false;
    }

    if (session.heartbeat_task == NULL) {
        xTaskCreatePinnedToCore(heartbeat_task, "mitr_heartbeat", 8192, NULL, 5, &session.heartbeat_task, tskNO_AFFINITY);
    }
    return true;
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
    session.connection_state = LIVEKIT_CONNECTION_STATE_DISCONNECTED;
    session.conversation_active = false;

    mitr_latency_mark("token_fetch_start");
    esp_err_t token_err = mitr_device_request_token(&session.token);
    if (token_err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to obtain device token: %s", esp_err_to_name(token_err));
        return false;
    }
    mitr_latency_mark("token_fetch_end");

    ESP_LOGI(
        TAG,
        "Fetched session token: room=%s identity=%s backend=%s",
        session.token.room_name ? session.token.room_name : "(generated)",
        session.token.identity ? session.token.identity : "(generated)",
        mitr_device_backend_base_url());

    return create_and_connect_room();
}

void leave_room(void)
{
    wake_word_stop();
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

bool session_has_livekit_session(void)
{
    return session.token.session_id != NULL && session.token.session_id[0] != '\0';
}

bool session_is_conversation_active(void)
{
    return room_handle != NULL && session.conversation_active;
}

int session_reconnect_window_sec(void)
{
    return session.reconnect_window_sec > 0 ? session.reconnect_window_sec : 180;
}
