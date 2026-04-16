#include <ctype.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_check.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_wifi.h"
#include "protocomm.h"
#include "sdkconfig.h"
#include "esp_timer.h"
#include "wifi_provisioning/manager.h"
#include "wifi_provisioning/scheme_ble.h"

#include "boot_feedback.h"
#include "device_storage.h"
#include "provisioning.h"

static const char *TAG = "mitr_provisioning";

static int64_t boot_now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

static void copy_upper_suffix(char *dest, size_t capacity, const char *source, size_t suffix_len)
{
    if (!dest || capacity == 0) {
        return;
    }

    const size_t source_len = source ? strlen(source) : 0;
    const char *start = source;
    if (source_len > suffix_len) {
        start = source + (source_len - suffix_len);
    }

    size_t out_index = 0;
    for (const char *cursor = start; *cursor != '\0' && out_index + 1 < capacity; ++cursor) {
        dest[out_index++] = (char)toupper((unsigned char)*cursor);
    }
    dest[out_index] = '\0';
}

static void get_service_name(char *service_name, size_t capacity)
{
    char suffix[16];
    copy_upper_suffix(suffix, sizeof(suffix), mitr_device_storage_device_id(), 6);
    snprintf(service_name, capacity, "MITR-%s", suffix[0] ? suffix : "DEVICE");
}

static void log_qr_payload(const char *service_name, const char *proof_of_possession)
{
    char payload[256];
    snprintf(
        payload,
        sizeof(payload),
        "{\"ver\":\"v1\",\"name\":\"%s\",\"deviceId\":\"%s\",\"pop\":\"%s\",\"transport\":\"ble\",\"security\":\"1\"}",
        service_name,
        mitr_device_storage_device_id(),
        proof_of_possession);
    ESP_LOGI(TAG, "Provisioning QR payload: %s", payload);
}

static esp_err_t respond_with_json(cJSON *response_root, uint8_t **outbuf, ssize_t *outlen)
{
    char *serialized = cJSON_PrintUnformatted(response_root);
    cJSON_Delete(response_root);
    ESP_RETURN_ON_FALSE(serialized != NULL, ESP_ERR_NO_MEM, TAG, "Failed to serialize provisioning response");
    *outbuf = (uint8_t *)serialized;
    *outlen = (ssize_t)strlen(serialized);
    return ESP_OK;
}

static esp_err_t bootstrap_endpoint_handler(
    uint32_t session_id,
    const uint8_t *inbuf,
    ssize_t inlen,
    uint8_t **outbuf,
    ssize_t *outlen,
    void *priv_data)
{
    (void)session_id;
    (void)priv_data;

    ESP_RETURN_ON_FALSE(inbuf != NULL && inlen > 0, ESP_ERR_INVALID_ARG, TAG, "Missing bootstrap payload");

    cJSON *request = cJSON_ParseWithLength((const char *)inbuf, (size_t)inlen);
    ESP_RETURN_ON_FALSE(request != NULL, ESP_ERR_INVALID_ARG, TAG, "Failed to parse bootstrap payload");

    const cJSON *backend_base_url = cJSON_GetObjectItemCaseSensitive(request, "backendBaseUrl");
    const cJSON *pairing_token = cJSON_GetObjectItemCaseSensitive(request, "pairingToken");
    const cJSON *device_id = cJSON_GetObjectItemCaseSensitive(request, "deviceId");
    const cJSON *language = cJSON_GetObjectItemCaseSensitive(request, "language");

    if (!cJSON_IsString(backend_base_url) || !backend_base_url->valuestring ||
        !cJSON_IsString(pairing_token) || !pairing_token->valuestring ||
        !cJSON_IsString(device_id) || !device_id->valuestring) {
        cJSON_Delete(request);
        ESP_LOGE(TAG, "Bootstrap payload missing required fields");
        return ESP_ERR_INVALID_ARG;
    }

    esp_err_t err = mitr_device_storage_store_bootstrap(
        backend_base_url->valuestring,
        pairing_token->valuestring,
        device_id->valuestring,
        cJSON_IsString(language) ? language->valuestring : NULL);
    cJSON_Delete(request);
    ESP_RETURN_ON_ERROR(err, TAG, "Failed to persist bootstrap payload");

    cJSON *response = cJSON_CreateObject();
    ESP_RETURN_ON_FALSE(response != NULL, ESP_ERR_NO_MEM, TAG, "Failed to create provisioning response");
    cJSON_AddBoolToObject(response, "ok", true);
    cJSON_AddStringToObject(response, "deviceId", mitr_device_storage_device_id());
    return respond_with_json(response, outbuf, outlen);
}

static void provisioning_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    (void)arg;

    if (event_base == WIFI_PROV_EVENT) {
        switch (event_id) {
            case WIFI_PROV_START:
                ESP_LOGI(TAG, "BLE provisioning started");
                break;
            case WIFI_PROV_CRED_RECV: {
                wifi_sta_config_t *wifi_sta_cfg = (wifi_sta_config_t *)event_data;
                ESP_LOGI(TAG, "Received Wi-Fi credentials for SSID=%s", wifi_sta_cfg ? (const char *)wifi_sta_cfg->ssid : "(unknown)");
                break;
            }
            case WIFI_PROV_CRED_FAIL:
                ESP_LOGW(TAG, "Provisioning received Wi-Fi credentials but failed to connect");
                break;
            case WIFI_PROV_CRED_SUCCESS:
                ESP_LOGI(TAG, "Provisioning completed successfully");
                break;
            case WIFI_PROV_END:
                ESP_LOGI(TAG, "Provisioning manager ended");
                wifi_prov_mgr_deinit();
                break;
            default:
                break;
        }
        return;
    }

    if (event_base == PROTOCOMM_TRANSPORT_BLE_EVENT) {
        switch (event_id) {
            case PROTOCOMM_TRANSPORT_BLE_CONNECTED:
                ESP_LOGI(TAG, "Provisioning BLE transport connected");
                break;
            case PROTOCOMM_TRANSPORT_BLE_DISCONNECTED:
                ESP_LOGI(TAG, "Provisioning BLE transport disconnected");
                break;
            default:
                break;
        }
        return;
    }

    if (event_base == PROTOCOMM_SECURITY_SESSION_EVENT) {
        switch (event_id) {
            case PROTOCOMM_SECURITY_SESSION_SETUP_OK:
                ESP_LOGI(TAG, "Provisioning secured session established");
                break;
            case PROTOCOMM_SECURITY_SESSION_INVALID_SECURITY_PARAMS:
                ESP_LOGE(TAG, "Provisioning rejected invalid security params");
                break;
            case PROTOCOMM_SECURITY_SESSION_CREDENTIALS_MISMATCH:
                ESP_LOGE(TAG, "Provisioning PoP mismatch");
                break;
            default:
                break;
        }
    }
}

esp_err_t mitr_provisioning_start_if_needed(bool *started)
{
    ESP_RETURN_ON_FALSE(started != NULL, ESP_ERR_INVALID_ARG, TAG, "Missing started flag");
    *started = false;

    ESP_RETURN_ON_ERROR(mitr_device_storage_init(), TAG, "Failed to initialize device storage");

    ESP_RETURN_ON_ERROR(esp_event_handler_register(WIFI_PROV_EVENT, ESP_EVENT_ANY_ID, &provisioning_event_handler, NULL), TAG, "Failed to register provisioning events");
    ESP_RETURN_ON_ERROR(esp_event_handler_register(PROTOCOMM_TRANSPORT_BLE_EVENT, ESP_EVENT_ANY_ID, &provisioning_event_handler, NULL), TAG, "Failed to register BLE transport events");
    ESP_RETURN_ON_ERROR(esp_event_handler_register(PROTOCOMM_SECURITY_SESSION_EVENT, ESP_EVENT_ANY_ID, &provisioning_event_handler, NULL), TAG, "Failed to register provisioning security events");

    wifi_prov_mgr_config_t config = {
        .scheme = wifi_prov_scheme_ble,
        .scheme_event_handler = WIFI_PROV_SCHEME_BLE_EVENT_HANDLER_FREE_BTDM,
    };

    ESP_RETURN_ON_ERROR(wifi_prov_mgr_init(config), TAG, "Failed to init provisioning manager");

    bool provisioned = false;
    ESP_RETURN_ON_ERROR(wifi_prov_mgr_is_provisioned(&provisioned), TAG, "Failed to read provisioning state");
    if (provisioned) {
        wifi_prov_mgr_deinit();
        return ESP_OK;
    }

    const char *proof_of_possession = mitr_device_storage_device_id();
    char service_name[32];
    get_service_name(service_name, sizeof(service_name));

    ESP_RETURN_ON_ERROR(wifi_prov_mgr_endpoint_create(MITR_PROVISIONING_CUSTOM_ENDPOINT), TAG, "Failed to create custom provisioning endpoint");
    ESP_RETURN_ON_ERROR(
        wifi_prov_mgr_start_provisioning(WIFI_PROV_SECURITY_1, proof_of_possession, service_name, NULL),
        TAG,
        "Failed to start BLE provisioning");
    ESP_RETURN_ON_ERROR(
        wifi_prov_mgr_endpoint_register(MITR_PROVISIONING_CUSTOM_ENDPOINT, bootstrap_endpoint_handler, NULL),
        TAG,
        "Failed to register custom provisioning endpoint");

    log_qr_payload(service_name, proof_of_possession);
    ESP_LOGW(TAG, "[BOOT] t=%lldms state=provisioning_wait", boot_now_ms());
    mitr_boot_feedback_set_state(MITR_BOOT_STATE_PROVISIONING_WAIT);
    *started = true;
    return ESP_OK;
}
