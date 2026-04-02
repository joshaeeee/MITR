#include <stdbool.h>
#include <string.h>

#include "esp_check.h"
#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

#include "device_storage.h"

static const char *TAG = "mitr_device_storage";
static const char *NAMESPACE = "mitr_device";

#define STORAGE_STR_CAPACITY 256
#define STORAGE_TOKEN_CAPACITY 160
#define STORAGE_DEVICE_ID_CAPACITY 96

typedef struct {
    bool initialized;
    char backend_base_url[STORAGE_STR_CAPACITY];
    char device_access_token[STORAGE_TOKEN_CAPACITY];
    char pairing_token[STORAGE_TOKEN_CAPACITY];
    char device_id[STORAGE_DEVICE_ID_CAPACITY];
    char language[32];
} storage_state_t;

static storage_state_t state = {0};

static void copy_string(char *dest, size_t capacity, const char *value)
{
    if (!dest || capacity == 0) {
        return;
    }
    if (!value) {
        dest[0] = '\0';
        return;
    }
    strlcpy(dest, value, capacity);
}

static esp_err_t init_nvs_if_needed(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    if (err == ESP_ERR_NVS_INVALID_STATE) {
        return ESP_OK;
    }
    return err;
}

static void load_value(nvs_handle_t handle, const char *key, char *dest, size_t capacity, const char *fallback)
{
    size_t required = capacity;
    esp_err_t err = nvs_get_str(handle, key, dest, &required);
    if (err == ESP_OK) {
        return;
    }
    copy_string(dest, capacity, fallback);
}

esp_err_t mitr_device_storage_init(void)
{
    if (state.initialized) {
        return ESP_OK;
    }

    ESP_RETURN_ON_ERROR(init_nvs_if_needed(), TAG, "Failed to initialize NVS");

    nvs_handle_t handle;
    esp_err_t err = nvs_open(NAMESPACE, NVS_READWRITE, &handle);
    ESP_RETURN_ON_ERROR(err, TAG, "Failed to open device storage");

    load_value(handle, "backend_url", state.backend_base_url, sizeof(state.backend_base_url), CONFIG_MITR_DEVICE_BACKEND_BASE_URL);
    load_value(handle, "device_token", state.device_access_token, sizeof(state.device_access_token), CONFIG_MITR_DEVICE_ACCESS_TOKEN);
    load_value(handle, "pairing_token", state.pairing_token, sizeof(state.pairing_token), CONFIG_MITR_DEVICE_PAIRING_TOKEN);
    load_value(handle, "device_id", state.device_id, sizeof(state.device_id), CONFIG_MITR_DEVICE_DEVICE_ID);
    load_value(handle, "language", state.language, sizeof(state.language), CONFIG_MITR_DEVICE_LANGUAGE);

    nvs_close(handle);
    state.initialized = true;
    return ESP_OK;
}

const char *mitr_device_storage_backend_base_url(void)
{
    return state.backend_base_url;
}

const char *mitr_device_storage_device_id(void)
{
    return state.device_id;
}

const char *mitr_device_storage_access_token(void)
{
    return state.device_access_token;
}

const char *mitr_device_storage_pairing_token(void)
{
    return state.pairing_token;
}

const char *mitr_device_storage_language(void)
{
    return state.language;
}

bool mitr_device_storage_has_access_token(void)
{
    return state.device_access_token[0] != '\0';
}

bool mitr_device_storage_has_pairing_token(void)
{
    return state.pairing_token[0] != '\0';
}

esp_err_t mitr_device_storage_store_bootstrap(
    const char *backend_base_url,
    const char *pairing_token,
    const char *device_id,
    const char *language)
{
    ESP_RETURN_ON_ERROR(mitr_device_storage_init(), TAG, "Storage is unavailable");

    nvs_handle_t handle;
    esp_err_t err = nvs_open(NAMESPACE, NVS_READWRITE, &handle);
    ESP_RETURN_ON_ERROR(err, TAG, "Failed to open device storage");

    if (backend_base_url && backend_base_url[0] != '\0') {
        err = nvs_set_str(handle, "backend_url", backend_base_url);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Failed to store backend URL: %s", esp_err_to_name(err));
            goto exit;
        }
        copy_string(state.backend_base_url, sizeof(state.backend_base_url), backend_base_url);
    }
    if (pairing_token && pairing_token[0] != '\0') {
        err = nvs_set_str(handle, "pairing_token", pairing_token);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Failed to store pairing token: %s", esp_err_to_name(err));
            goto exit;
        }
        copy_string(state.pairing_token, sizeof(state.pairing_token), pairing_token);
    }
    if (device_id && device_id[0] != '\0') {
        err = nvs_set_str(handle, "device_id", device_id);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Failed to store device ID: %s", esp_err_to_name(err));
            goto exit;
        }
        copy_string(state.device_id, sizeof(state.device_id), device_id);
    }
    if (language && language[0] != '\0') {
        err = nvs_set_str(handle, "language", language);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Failed to store preferred language: %s", esp_err_to_name(err));
            goto exit;
        }
        copy_string(state.language, sizeof(state.language), language);
    }

    err = nvs_commit(handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to commit bootstrap config: %s", esp_err_to_name(err));
        goto exit;
    }

exit:
    nvs_close(handle);
    return err;
}

esp_err_t mitr_device_storage_store_access_token(
    const char *device_access_token,
    const char *device_id)
{
    ESP_RETURN_ON_ERROR(mitr_device_storage_init(), TAG, "Storage is unavailable");
    ESP_RETURN_ON_FALSE(device_access_token && device_access_token[0] != '\0', ESP_ERR_INVALID_ARG, TAG, "Missing device access token");

    nvs_handle_t handle;
    esp_err_t err = nvs_open(NAMESPACE, NVS_READWRITE, &handle);
    ESP_RETURN_ON_ERROR(err, TAG, "Failed to open device storage");

    err = nvs_set_str(handle, "device_token", device_access_token);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to store device access token: %s", esp_err_to_name(err));
        goto exit;
    }
    copy_string(state.device_access_token, sizeof(state.device_access_token), device_access_token);

    err = nvs_erase_key(handle, "pairing_token");
    if (err != ESP_OK && err != ESP_ERR_NVS_NOT_FOUND) {
        ESP_LOGE(TAG, "Failed to clear pairing token: %s", esp_err_to_name(err));
        goto exit;
    }
    state.pairing_token[0] = '\0';

    if (device_id && device_id[0] != '\0') {
        err = nvs_set_str(handle, "device_id", device_id);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Failed to persist device ID: %s", esp_err_to_name(err));
            goto exit;
        }
        copy_string(state.device_id, sizeof(state.device_id), device_id);
    }

    err = nvs_commit(handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to commit device access token: %s", esp_err_to_name(err));
        goto exit;
    }

exit:
    nvs_close(handle);
    return err;
}
