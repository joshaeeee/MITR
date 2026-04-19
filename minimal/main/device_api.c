#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_check.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "sdkconfig.h"

#include "device_api.h"
#include "device_storage.h"

static const char *TAG = "mitr_device_api";

typedef struct {
    char *data;
    size_t length;
    size_t capacity;
} response_buffer_t;

static const char *const DEVICE_HARDWARE_REV = CONFIG_MITR_DEVICE_HARDWARE_REV;
static const char *const DEVICE_FIRMWARE_VERSION = CONFIG_MITR_DEVICE_FIRMWARE_VERSION;

static void free_buffer(response_buffer_t *buffer)
{
    if (!buffer) {
        return;
    }
    free(buffer->data);
    buffer->data = NULL;
    buffer->length = 0;
    buffer->capacity = 0;
}

static esp_err_t ensure_capacity(response_buffer_t *buffer, size_t extra_bytes)
{
    if ((buffer->length + extra_bytes + 1) <= buffer->capacity) {
        return ESP_OK;
    }

    size_t next_capacity = buffer->capacity == 0 ? 1024 : buffer->capacity;
    while ((buffer->length + extra_bytes + 1) > next_capacity) {
        next_capacity *= 2;
    }

    char *next = realloc(buffer->data, next_capacity);
    ESP_RETURN_ON_FALSE(next != NULL, ESP_ERR_NO_MEM, TAG, "Failed to grow HTTP response buffer");
    buffer->data = next;
    buffer->capacity = next_capacity;
    return ESP_OK;
}

static esp_err_t http_event_handler(esp_http_client_event_t *event)
{
    response_buffer_t *buffer = (response_buffer_t *)event->user_data;
    if (!buffer) {
        return ESP_OK;
    }

    if (event->event_id == HTTP_EVENT_ON_DATA && event->data && event->data_len > 0) {
        ESP_RETURN_ON_ERROR(ensure_capacity(buffer, (size_t)event->data_len), TAG, "Failed to buffer HTTP response");
        memcpy(buffer->data + buffer->length, event->data, (size_t)event->data_len);
        buffer->length += (size_t)event->data_len;
        buffer->data[buffer->length] = '\0';
    }

    return ESP_OK;
}

static char *join_url(const char *path)
{
    const char *base = mitr_device_storage_backend_base_url();
    const bool base_has_slash = base[strlen(base) - 1] == '/';
    const bool path_has_slash = path[0] == '/';
    const char *normalized_path = path_has_slash ? path + 1 : path;
    const char *separator = base_has_slash ? "" : "/";
    int needed = snprintf(NULL, 0, "%s%s%s", base, separator, normalized_path);
    if (needed <= 0) {
        return NULL;
    }
    char *url = calloc((size_t)needed + 1, 1);
    if (!url) {
        return NULL;
    }
    snprintf(url, (size_t)needed + 1, "%s%s%s", base, separator, normalized_path);
    return url;
}

static esp_err_t ensure_device_configured(bool require_access_token)
{
    ESP_RETURN_ON_ERROR(mitr_device_storage_init(), TAG, "Failed to initialize device storage");
    ESP_RETURN_ON_FALSE(strlen(mitr_device_storage_backend_base_url()) > 0, ESP_ERR_INVALID_STATE, TAG, "Missing backend base URL");
    ESP_RETURN_ON_FALSE(strlen(mitr_device_storage_device_id()) > 0, ESP_ERR_INVALID_STATE, TAG, "Missing device ID");
    if (require_access_token) {
        ESP_RETURN_ON_FALSE(strlen(mitr_device_storage_access_token()) > 0, ESP_ERR_INVALID_STATE, TAG, "Missing device access token");
    }
    return ESP_OK;
}

static char *dup_json_string(const cJSON *node)
{
    if (!cJSON_IsString(node) || !node->valuestring) {
        return NULL;
    }
    return strdup(node->valuestring);
}

static void copy_json_string(const cJSON *node, char *dest, size_t capacity)
{
    if (!dest || capacity == 0) {
        return;
    }
    dest[0] = '\0';
    if (!cJSON_IsString(node) || !node->valuestring) {
        return;
    }
    strlcpy(dest, node->valuestring, capacity);
}

static int read_json_int(const cJSON *node, int fallback)
{
    if (!cJSON_IsNumber(node)) {
        return fallback;
    }
    return node->valueint;
}

static bool read_json_bool(const cJSON *node, bool fallback)
{
    if (cJSON_IsBool(node)) {
        return cJSON_IsTrue(node);
    }
    return fallback;
}

static esp_err_t http_post_json(const char *path, const char *body, const char *bearer_token, cJSON **response_json, int *status_code)
{
    esp_err_t err = ESP_OK;
    *response_json = NULL;
    if (status_code) {
        *status_code = 0;
    }

    ESP_RETURN_ON_ERROR(ensure_device_configured(bearer_token != NULL), TAG, "Device config is incomplete");

    char *url = join_url(path);
    ESP_RETURN_ON_FALSE(url != NULL, ESP_ERR_NO_MEM, TAG, "Failed to build request URL");

    response_buffer_t buffer = {0};
    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 15000,
        .event_handler = http_event_handler,
        .user_data = &buffer,
        .buffer_size = 2048,
    };

    if (strncmp(url, "https://", 8) == 0) {
        config.crt_bundle_attach = esp_crt_bundle_attach;
    }

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) {
        err = ESP_FAIL;
        ESP_LOGE(TAG, "Failed to init HTTP client");
        goto cleanup;
    }

    if (bearer_token != NULL) {
        char auth_header[512];
        int auth_len = snprintf(auth_header, sizeof(auth_header), "Bearer %s", bearer_token);
        if (!(auth_len > 7 && auth_len < (int)sizeof(auth_header))) {
            err = ESP_ERR_INVALID_SIZE;
            ESP_LOGE(TAG, "Device access token is too large");
            goto cleanup;
        }

        err = esp_http_client_set_header(client, "Authorization", auth_header);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Failed to set auth header: %s", esp_err_to_name(err));
            goto cleanup;
        }
    }
    err = esp_http_client_set_header(client, "Content-Type", "application/json");
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to set content-type header: %s", esp_err_to_name(err));
        goto cleanup;
    }
    if (body) {
        err = esp_http_client_set_post_field(client, body, (int)strlen(body));
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Failed to set POST body: %s", esp_err_to_name(err));
            goto cleanup;
        }
    }

    err = esp_http_client_perform(client);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "HTTP request failed: %s", esp_err_to_name(err));
        goto cleanup;
    }

    const int status = esp_http_client_get_status_code(client);
    if (status_code) {
        *status_code = status;
    }

    if (buffer.length == 0) {
        buffer.data = calloc(1, 1);
        if (buffer.data == NULL) {
            err = ESP_ERR_NO_MEM;
            ESP_LOGE(TAG, "Failed to allocate empty HTTP response");
            goto cleanup;
        }
    }

    if (status < 200 || status >= 300) {
        ESP_LOGE(TAG, "Backend returned HTTP %d for %s: %s", status, path, buffer.data);
        err = ESP_FAIL;
        goto cleanup;
    }

    *response_json = cJSON_Parse(buffer.data);
    if (*response_json == NULL) {
        ESP_LOGE(TAG, "Failed to parse backend response for %s: %s", path, buffer.data);
        err = ESP_FAIL;
        goto cleanup;
    }

cleanup:
    if (client) {
        esp_http_client_cleanup(client);
    }
    free(url);
    free_buffer(&buffer);
    return err;
}

static cJSON *build_metadata_payload(void)
{
    cJSON *metadata = cJSON_CreateObject();
    if (!metadata) {
        return NULL;
    }

    cJSON_AddStringToObject(metadata, "platform", "esp32-s3");
    cJSON_AddStringToObject(metadata, "transport", "livekit");
    cJSON_AddStringToObject(metadata, "runtime", "esp-idf");
    return metadata;
}

const char *mitr_device_backend_base_url(void)
{
    return mitr_device_storage_backend_base_url();
}

const char *mitr_device_device_id(void)
{
    return mitr_device_storage_device_id();
}

const char *mitr_device_language(void)
{
    return mitr_device_storage_language();
}

const char *mitr_device_hardware_rev(void)
{
    return DEVICE_HARDWARE_REV;
}

const char *mitr_device_firmware_version(void)
{
    return DEVICE_FIRMWARE_VERSION;
}

bool mitr_device_has_access_token(void)
{
    return mitr_device_storage_has_access_token();
}

bool mitr_device_has_pairing_token(void)
{
    return mitr_device_storage_has_pairing_token();
}

esp_err_t mitr_device_complete_bootstrap(void)
{
    ESP_RETURN_ON_ERROR(ensure_device_configured(false), TAG, "Device config is incomplete");
    ESP_RETURN_ON_FALSE(mitr_device_storage_has_pairing_token(), ESP_ERR_INVALID_STATE, TAG, "Missing pairing token");

    cJSON *body = cJSON_CreateObject();
    ESP_RETURN_ON_FALSE(body != NULL, ESP_ERR_NO_MEM, TAG, "Failed to create bootstrap body");
    cJSON_AddStringToObject(body, "pairingToken", mitr_device_storage_pairing_token());
    cJSON_AddStringToObject(body, "deviceId", mitr_device_storage_device_id());
    cJSON_AddStringToObject(body, "hardwareRev", DEVICE_HARDWARE_REV);
    cJSON_AddStringToObject(body, "firmwareVersion", DEVICE_FIRMWARE_VERSION);
    cJSON *metadata = build_metadata_payload();
    if (metadata != NULL) {
        cJSON_AddItemToObject(body, "metadata", metadata);
    }

    char *body_string = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);
    ESP_RETURN_ON_FALSE(body_string != NULL, ESP_ERR_NO_MEM, TAG, "Failed to serialize bootstrap body");

    cJSON *response = NULL;
    esp_err_t err = http_post_json("/devices/bootstrap/complete", body_string, NULL, &response, NULL);
    free(body_string);
    ESP_RETURN_ON_ERROR(err, TAG, "Bootstrap completion failed");

    char *device_access_token = dup_json_string(cJSON_GetObjectItemCaseSensitive(response, "deviceAccessToken"));
    char *device_id = dup_json_string(cJSON_GetObjectItemCaseSensitive(response, "deviceId"));
    cJSON_Delete(response);

    ESP_RETURN_ON_FALSE(device_access_token != NULL, ESP_FAIL, TAG, "Bootstrap response missing deviceAccessToken");
    err = mitr_device_storage_store_access_token(device_access_token, device_id ? device_id : mitr_device_storage_device_id());
    free(device_access_token);
    free(device_id);
    return err;
}

esp_err_t mitr_device_request_token(mitr_device_token_response_t *out)
{
    ESP_RETURN_ON_FALSE(out != NULL, ESP_ERR_INVALID_ARG, TAG, "Missing token response");
    memset(out, 0, sizeof(*out));

    cJSON *body = cJSON_CreateObject();
    ESP_RETURN_ON_FALSE(body != NULL, ESP_ERR_NO_MEM, TAG, "Failed to create token request body");
    cJSON_AddStringToObject(body, "language", mitr_device_language());
    cJSON_AddStringToObject(body, "firmwareVersion", DEVICE_FIRMWARE_VERSION);
    cJSON_AddStringToObject(body, "hardwareRev", DEVICE_HARDWARE_REV);
    cJSON *metadata = build_metadata_payload();
    if (metadata != NULL) {
        cJSON_AddItemToObject(body, "metadata", metadata);
    }

    char *body_string = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);
    ESP_RETURN_ON_FALSE(body_string != NULL, ESP_ERR_NO_MEM, TAG, "Failed to serialize token request body");

    cJSON *response = NULL;
    int token_http_status = 0;
    esp_err_t err = http_post_json("/devices/token", body_string, mitr_device_storage_access_token(), &response, &token_http_status);
    free(body_string);
    if (err != ESP_OK) {
        if (token_http_status == 401) {
            ESP_LOGE(TAG, "Device access token revoked (HTTP 401). Clearing credentials and restarting into provisioning mode.");
            mitr_device_storage_clear_access_token();
            esp_wifi_restore();
            esp_restart();
        }
        ESP_RETURN_ON_ERROR(err, TAG, "Token request failed");
    }

    out->session_id = dup_json_string(cJSON_GetObjectItemCaseSensitive(response, "sessionId"));
    out->server_url = dup_json_string(cJSON_GetObjectItemCaseSensitive(response, "serverUrl"));
    out->participant_token = dup_json_string(cJSON_GetObjectItemCaseSensitive(response, "participantToken"));
    out->room_name = dup_json_string(cJSON_GetObjectItemCaseSensitive(response, "roomName"));
    out->identity = dup_json_string(cJSON_GetObjectItemCaseSensitive(response, "identity"));
    out->agent_name = dup_json_string(cJSON_GetObjectItemCaseSensitive(response, "agentName"));
    const cJSON *participant_token_expires_at_ms =
        cJSON_GetObjectItemCaseSensitive(response, "participantTokenExpiresAtMs");
    if (cJSON_IsNumber(participant_token_expires_at_ms)) {
        out->participant_token_expires_at_ms = (int64_t)participant_token_expires_at_ms->valuedouble;
    }

    const cJSON *dispatch = cJSON_GetObjectItemCaseSensitive(response, "dispatchMetadata");
    if (cJSON_IsObject(dispatch)) {
        out->device_id = dup_json_string(cJSON_GetObjectItemCaseSensitive(dispatch, "device_id"));
        out->user_id = dup_json_string(cJSON_GetObjectItemCaseSensitive(dispatch, "user_id"));
        if (!out->device_id) {
            out->device_id = strdup(mitr_device_storage_device_id());
        }
    }

    cJSON_Delete(response);

    if (!out->session_id || !out->server_url || !out->participant_token) {
        mitr_device_token_response_free(out);
        return ESP_FAIL;
    }

    return ESP_OK;
}

void mitr_device_token_response_free(mitr_device_token_response_t *response)
{
    if (!response) {
        return;
    }

    free(response->session_id);
    free(response->server_url);
    free(response->participant_token);
    free(response->room_name);
    free(response->identity);
    free(response->agent_name);
    free(response->device_id);
    free(response->user_id);
    memset(response, 0, sizeof(*response));
}

esp_err_t mitr_device_send_heartbeat(
    const mitr_device_heartbeat_t *heartbeat,
    mitr_device_heartbeat_response_t *out_response)
{
    ESP_RETURN_ON_FALSE(heartbeat != NULL, ESP_ERR_INVALID_ARG, TAG, "Missing heartbeat payload");
    if (out_response) {
        memset(out_response, 0, sizeof(*out_response));
    }
    cJSON *body = cJSON_CreateObject();
    ESP_RETURN_ON_FALSE(body != NULL, ESP_ERR_NO_MEM, TAG, "Failed to create heartbeat body");

    if (heartbeat->session_id) {
        cJSON_AddStringToObject(body, "sessionId", heartbeat->session_id);
    }
    cJSON_AddStringToObject(body, "firmwareVersion", DEVICE_FIRMWARE_VERSION);
    cJSON_AddNumberToObject(body, "wifiRssiDbm", heartbeat->wifi_rssi_dbm);
    if (heartbeat->network_type) {
        cJSON_AddStringToObject(body, "networkType", heartbeat->network_type);
    }
    if (heartbeat->ip_address) {
        cJSON_AddStringToObject(body, "ipAddress", heartbeat->ip_address);
    }

    cJSON *metadata = cJSON_CreateObject();
    if (metadata != NULL) {
        if (heartbeat->connection_state) {
            cJSON_AddStringToObject(metadata, "connectionState", heartbeat->connection_state);
        }
        if (heartbeat->last_failure_reason && heartbeat->last_failure_reason[0] != '\0') {
            cJSON_AddStringToObject(metadata, "lastFailureReason", heartbeat->last_failure_reason);
        }
        if (heartbeat->last_end_reason && heartbeat->last_end_reason[0] != '\0') {
            cJSON_AddStringToObject(metadata, "lastEndReason", heartbeat->last_end_reason);
        }
        if (heartbeat->reconnect_state && heartbeat->reconnect_state[0] != '\0') {
            cJSON_AddStringToObject(metadata, "reconnectState", heartbeat->reconnect_state);
        }
        cJSON_AddNumberToObject(metadata, "reconnectAttemptCount", heartbeat->reconnect_attempt_count);
        if (heartbeat->ota_state && heartbeat->ota_state[0] != '\0') {
            cJSON_AddStringToObject(metadata, "otaState", heartbeat->ota_state);
        }
        if (heartbeat->ota_target_version && heartbeat->ota_target_version[0] != '\0') {
            cJSON_AddStringToObject(metadata, "otaTargetVersion", heartbeat->ota_target_version);
        }
        cJSON_AddBoolToObject(metadata, "lastBootOk", heartbeat->last_boot_ok);
        cJSON_AddBoolToObject(metadata, "speakerMuted", heartbeat->speaker_muted);
        cJSON_AddNumberToObject(metadata, "speakerVolume", heartbeat->speaker_volume);
        cJSON_AddItemToObject(body, "metadata", metadata);
    }

    char *body_string = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);
    ESP_RETURN_ON_FALSE(body_string != NULL, ESP_ERR_NO_MEM, TAG, "Failed to serialize heartbeat body");

    cJSON *response_json = NULL;
    esp_err_t err = http_post_json("/devices/heartbeat", body_string, mitr_device_storage_access_token(), &response_json, NULL);
    free(body_string);
    if (err != ESP_OK) {
        if (response_json) {
            cJSON_Delete(response_json);
        }
        return err;
    }

    if (response_json && out_response) {
        const cJSON *recommended = cJSON_GetObjectItemCaseSensitive(response_json, "recommendedFirmware");
        const cJSON *session_policy = cJSON_GetObjectItemCaseSensitive(response_json, "sessionPolicy");
        mitr_device_heartbeat_response_t *parsed = out_response;
        if (recommended != NULL && cJSON_IsObject(recommended)) {
            parsed->recommended_firmware.has_recommended_firmware = true;
            copy_json_string(cJSON_GetObjectItemCaseSensitive(recommended, "version"), parsed->recommended_firmware.version, sizeof(parsed->recommended_firmware.version));
            copy_json_string(cJSON_GetObjectItemCaseSensitive(recommended, "downloadUrl"), parsed->recommended_firmware.download_url, sizeof(parsed->recommended_firmware.download_url));
            parsed->recommended_firmware.mandatory = read_json_bool(
                cJSON_GetObjectItemCaseSensitive(recommended, "mandatory"),
                false);
            copy_json_string(cJSON_GetObjectItemCaseSensitive(recommended, "releaseNotes"), parsed->recommended_firmware.release_notes, sizeof(parsed->recommended_firmware.release_notes));

            const cJSON *metadata_json = cJSON_GetObjectItemCaseSensitive(recommended, "metadata");
            if (metadata_json != NULL && cJSON_IsObject(metadata_json)) {
                copy_json_string(cJSON_GetObjectItemCaseSensitive(metadata_json, "sha256"), parsed->recommended_firmware.sha256, sizeof(parsed->recommended_firmware.sha256));
                parsed->recommended_firmware.min_battery_pct = read_json_int(
                    cJSON_GetObjectItemCaseSensitive(metadata_json, "minBatteryPct"),
                    0);
                parsed->recommended_firmware.rollout_percentage = read_json_int(
                    cJSON_GetObjectItemCaseSensitive(metadata_json, "rolloutPercentage"),
                    100);
                parsed->recommended_firmware.size_bytes = read_json_int(
                    cJSON_GetObjectItemCaseSensitive(metadata_json, "sizeBytes"),
                    0);
            }
        }

        if (session_policy != NULL && cJSON_IsObject(session_policy)) {
            parsed->session_policy.has_session_policy = true;
            parsed->session_policy.always_connected = read_json_bool(
                cJSON_GetObjectItemCaseSensitive(session_policy, "alwaysConnected"),
                true);
            parsed->session_policy.reconnect_window_sec = read_json_int(
                cJSON_GetObjectItemCaseSensitive(session_policy, "reconnectWindowSec"),
                180);
            parsed->session_policy.heartbeat_interval_sec = read_json_int(
                cJSON_GetObjectItemCaseSensitive(session_policy, "heartbeatIntervalSec"),
                CONFIG_MITR_DEVICE_HEARTBEAT_INTERVAL_SEC);
            parsed->session_policy.telemetry_backoff_sec = read_json_int(
                cJSON_GetObjectItemCaseSensitive(session_policy, "telemetryBackoffSec"),
                30);
        }
    }
    if (response_json) {
        cJSON_Delete(response_json);
    }
    return ESP_OK;
}

esp_err_t mitr_device_send_telemetry(
    const char *session_id,
    const char *event_type,
    const char *level,
    const char *message)
{
    ESP_RETURN_ON_FALSE(event_type != NULL && strlen(event_type) > 0, ESP_ERR_INVALID_ARG, TAG, "Missing event type");

    cJSON *body = cJSON_CreateObject();
    ESP_RETURN_ON_FALSE(body != NULL, ESP_ERR_NO_MEM, TAG, "Failed to create telemetry body");

    if (session_id) {
        cJSON_AddStringToObject(body, "sessionId", session_id);
    }
    cJSON_AddStringToObject(body, "eventType", event_type);
    cJSON_AddStringToObject(body, "level", level ? level : "info");
    cJSON *payload = cJSON_CreateObject();
    if (payload != NULL) {
        if (message) {
            cJSON_AddStringToObject(payload, "message", message);
        }
        cJSON_AddStringToObject(payload, "firmwareVersion", DEVICE_FIRMWARE_VERSION);
        cJSON_AddStringToObject(payload, "hardwareRev", DEVICE_HARDWARE_REV);
        cJSON_AddItemToObject(body, "payload", payload);
    }

    char *body_string = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);
    ESP_RETURN_ON_FALSE(body_string != NULL, ESP_ERR_NO_MEM, TAG, "Failed to serialize telemetry body");

    cJSON *response = NULL;
    esp_err_t err = http_post_json("/devices/telemetry", body_string, mitr_device_storage_access_token(), &response, NULL);
    free(body_string);
    if (response) {
        cJSON_Delete(response);
    }
    return err;
}

esp_err_t mitr_device_notify_wake_detected(
    const char *session_id,
    const char *model_name,
    const char *phrase,
    float score)
{
    ESP_RETURN_ON_FALSE(session_id != NULL && strlen(session_id) > 0, ESP_ERR_INVALID_ARG, TAG, "Missing session id");
    ESP_RETURN_ON_FALSE(model_name != NULL && strlen(model_name) > 0, ESP_ERR_INVALID_ARG, TAG, "Missing model name");
    ESP_RETURN_ON_FALSE(phrase != NULL && strlen(phrase) > 0, ESP_ERR_INVALID_ARG, TAG, "Missing wake phrase");

    int path_len = snprintf(NULL, 0, "/internal/device-sessions/%s/wake-detected", session_id);
    ESP_RETURN_ON_FALSE(path_len > 0, ESP_FAIL, TAG, "Failed to size wake-detected path");

    char *path = calloc((size_t)path_len + 1, 1);
    ESP_RETURN_ON_FALSE(path != NULL, ESP_ERR_NO_MEM, TAG, "Failed to allocate wake-detected path");
    snprintf(path, (size_t)path_len + 1, "/internal/device-sessions/%s/wake-detected", session_id);

    cJSON *body = cJSON_CreateObject();
    if (body == NULL) {
        free(path);
        return ESP_ERR_NO_MEM;
    }
    cJSON_AddStringToObject(body, "modelName", model_name);
    cJSON_AddStringToObject(body, "phrase", phrase);
    cJSON_AddNumberToObject(body, "score", score);
    cJSON_AddNumberToObject(body, "detectedAtMs", (double)(esp_timer_get_time() / 1000));

    char *body_string = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);
    if (body_string == NULL) {
        free(path);
        return ESP_ERR_NO_MEM;
    }

    cJSON *response = NULL;
    esp_err_t err = http_post_json(path, body_string, mitr_device_storage_access_token(), &response, NULL);
    free(path);
    free(body_string);
    if (err != ESP_OK) {
        if (response) {
            cJSON_Delete(response);
        }
        return err;
    }

    const cJSON *accepted = cJSON_GetObjectItemCaseSensitive(response, "accepted");
    if (!cJSON_IsTrue(accepted)) {
        const cJSON *reason = cJSON_GetObjectItemCaseSensitive(response, "reason");
        const char *reason_str =
            (cJSON_IsString(reason) && reason->valuestring) ? reason->valuestring : "unknown";
        ESP_LOGW(
            TAG,
            "Wake detection rejected: %s",
            reason_str);
        cJSON_Delete(response);
        if (strcmp(reason_str, "conversation_not_idle") == 0) {
            return ESP_ERR_INVALID_STATE;
        }
        return ESP_FAIL;
    }

    cJSON_Delete(response);
    return ESP_OK;
}

esp_err_t mitr_device_end_session(const char *session_id, const char *reason)
{
    ESP_RETURN_ON_FALSE(session_id != NULL && strlen(session_id) > 0, ESP_ERR_INVALID_ARG, TAG, "Missing session id");

    cJSON *body = cJSON_CreateObject();
    ESP_RETURN_ON_FALSE(body != NULL, ESP_ERR_NO_MEM, TAG, "Failed to create end-session body");
    cJSON_AddStringToObject(body, "sessionId", session_id);
    cJSON_AddStringToObject(body, "reason", reason ? reason : "device_shutdown");

    char *body_string = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);
    ESP_RETURN_ON_FALSE(body_string != NULL, ESP_ERR_NO_MEM, TAG, "Failed to serialize end-session body");

    cJSON *response = NULL;
    esp_err_t err = http_post_json("/devices/session/end", body_string, mitr_device_storage_access_token(), &response, NULL);
    free(body_string);
    if (response) {
        cJSON_Delete(response);
    }
    return err;
}
