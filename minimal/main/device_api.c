#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_check.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "sdkconfig.h"

#include "device_api.h"

static const char *TAG = "mitr_device_api";

typedef struct {
    char *data;
    size_t length;
    size_t capacity;
} response_buffer_t;

static const char *const DEVICE_BACKEND_BASE_URL = CONFIG_MITR_DEVICE_BACKEND_BASE_URL;
static const char *const DEVICE_ACCESS_TOKEN = CONFIG_MITR_DEVICE_ACCESS_TOKEN;
static const char *const DEVICE_LANGUAGE = CONFIG_MITR_DEVICE_LANGUAGE;
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
    const char *base = DEVICE_BACKEND_BASE_URL;
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

static esp_err_t ensure_device_configured(void)
{
    ESP_RETURN_ON_FALSE(strlen(DEVICE_BACKEND_BASE_URL) > 0, ESP_ERR_INVALID_STATE, TAG, "Missing backend base URL");
    ESP_RETURN_ON_FALSE(strlen(DEVICE_ACCESS_TOKEN) > 0, ESP_ERR_INVALID_STATE, TAG, "Missing device access token");
    return ESP_OK;
}

static char *dup_json_string(const cJSON *node)
{
    if (!cJSON_IsString(node) || !node->valuestring) {
        return NULL;
    }
    return strdup(node->valuestring);
}

static esp_err_t http_post_json(const char *path, const char *body, cJSON **response_json, int *status_code)
{
    esp_err_t err = ESP_OK;
    *response_json = NULL;
    if (status_code) {
        *status_code = 0;
    }

    ESP_RETURN_ON_ERROR(ensure_device_configured(), TAG, "Device config is incomplete");

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

    char auth_header[512];
    int auth_len = snprintf(auth_header, sizeof(auth_header), "Bearer %s", DEVICE_ACCESS_TOKEN);
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
    return DEVICE_BACKEND_BASE_URL;
}

const char *mitr_device_language(void)
{
    return DEVICE_LANGUAGE;
}

const char *mitr_device_hardware_rev(void)
{
    return DEVICE_HARDWARE_REV;
}

const char *mitr_device_firmware_version(void)
{
    return DEVICE_FIRMWARE_VERSION;
}

esp_err_t mitr_device_request_token(mitr_device_token_response_t *out)
{
    ESP_RETURN_ON_FALSE(out != NULL, ESP_ERR_INVALID_ARG, TAG, "Missing token response");
    memset(out, 0, sizeof(*out));

    cJSON *body = cJSON_CreateObject();
    ESP_RETURN_ON_FALSE(body != NULL, ESP_ERR_NO_MEM, TAG, "Failed to create token request body");
    cJSON_AddStringToObject(body, "language", DEVICE_LANGUAGE);
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
    esp_err_t err = http_post_json("/devices/token", body_string, &response, NULL);
    free(body_string);
    ESP_RETURN_ON_ERROR(err, TAG, "Token request failed");

    out->session_id = dup_json_string(cJSON_GetObjectItemCaseSensitive(response, "sessionId"));
    out->server_url = dup_json_string(cJSON_GetObjectItemCaseSensitive(response, "serverUrl"));
    out->participant_token = dup_json_string(cJSON_GetObjectItemCaseSensitive(response, "participantToken"));
    out->room_name = dup_json_string(cJSON_GetObjectItemCaseSensitive(response, "roomName"));
    out->identity = dup_json_string(cJSON_GetObjectItemCaseSensitive(response, "identity"));
    out->agent_name = dup_json_string(cJSON_GetObjectItemCaseSensitive(response, "agentName"));

    const cJSON *dispatch = cJSON_GetObjectItemCaseSensitive(response, "dispatchMetadata");
    if (cJSON_IsObject(dispatch)) {
        out->device_id = dup_json_string(cJSON_GetObjectItemCaseSensitive(dispatch, "device_id"));
        out->user_id = dup_json_string(cJSON_GetObjectItemCaseSensitive(dispatch, "user_id"));
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

esp_err_t mitr_device_send_heartbeat(const mitr_device_heartbeat_t *heartbeat)
{
    ESP_RETURN_ON_FALSE(heartbeat != NULL, ESP_ERR_INVALID_ARG, TAG, "Missing heartbeat payload");
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
        cJSON_AddItemToObject(body, "metadata", metadata);
    }

    char *body_string = cJSON_PrintUnformatted(body);
    cJSON_Delete(body);
    ESP_RETURN_ON_FALSE(body_string != NULL, ESP_ERR_NO_MEM, TAG, "Failed to serialize heartbeat body");

    cJSON *response = NULL;
    esp_err_t err = http_post_json("/devices/heartbeat", body_string, &response, NULL);
    free(body_string);
    if (response) {
        cJSON_Delete(response);
    }
    return err;
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
    esp_err_t err = http_post_json("/devices/telemetry", body_string, &response, NULL);
    free(body_string);
    if (response) {
        cJSON_Delete(response);
    }
    return err;
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
    esp_err_t err = http_post_json("/devices/session/end", body_string, &response, NULL);
    free(body_string);
    if (response) {
        cJSON_Delete(response);
    }
    return err;
}
