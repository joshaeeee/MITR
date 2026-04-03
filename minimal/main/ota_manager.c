#include <stdbool.h>
#include <string.h>

#include "esp_app_desc.h"
#include "esp_check.h"
#include "esp_crt_bundle.h"
#include "esp_https_ota.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"

#include "ota_manager.h"

static const char *TAG = "mitr_ota";
static const int OTA_VALIDATION_HEARTBEATS = 3;
static const int64_t OTA_VALIDATION_WINDOW_MS = 5 * 60 * 1000;

typedef struct {
    bool initialized;
    bool pending_verify;
    bool update_available;
    int successful_heartbeats_since_boot;
    int64_t boot_started_at_ms;
    char state[32];
    char target_version[64];
    char download_url[256];
    char release_notes[256];
    char sha256[96];
    char last_error[128];
    bool mandatory;
    int min_battery_pct;
    int rollout_percentage;
    int size_bytes;
} ota_state_t;

static ota_state_t state = {0};

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

static void set_state(const char *value)
{
    strlcpy(state.state, value ? value : "idle", sizeof(state.state));
}

esp_err_t mitr_ota_init(void)
{
    if (state.initialized) {
        return ESP_OK;
    }

    memset(&state, 0, sizeof(state));
    state.boot_started_at_ms = now_ms();
    set_state("idle");

    const esp_partition_t *running = esp_ota_get_running_partition();
    ESP_RETURN_ON_FALSE(running != NULL, ESP_FAIL, TAG, "Failed to locate running OTA partition");

    esp_ota_img_states_t ota_state = ESP_OTA_IMG_UNDEFINED;
    esp_err_t err = esp_ota_get_state_partition(running, &ota_state);
    if (err == ESP_OK && ota_state == ESP_OTA_IMG_PENDING_VERIFY) {
        state.pending_verify = true;
        set_state("pending_verify");
        ESP_LOGW(TAG, "Running build is pending verification; rollback remains armed");
    } else if (err != ESP_OK && err != ESP_ERR_NOT_SUPPORTED) {
        ESP_LOGW(TAG, "Failed to inspect OTA image state: %s", esp_err_to_name(err));
    }

    state.initialized = true;
    return ESP_OK;
}

void mitr_ota_note_heartbeat_success(void)
{
    if (!state.pending_verify) {
        return;
    }

    state.successful_heartbeats_since_boot += 1;
    if (state.successful_heartbeats_since_boot < OTA_VALIDATION_HEARTBEATS) {
        return;
    }
    if ((now_ms() - state.boot_started_at_ms) < OTA_VALIDATION_WINDOW_MS) {
        return;
    }

    esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
    if (err != ESP_OK) {
        strlcpy(state.last_error, esp_err_to_name(err), sizeof(state.last_error));
        set_state("validation_error");
        ESP_LOGE(TAG, "Failed to mark OTA image valid: %s", esp_err_to_name(err));
        return;
    }

    state.pending_verify = false;
    set_state("stable");
    state.last_error[0] = '\0';
    ESP_LOGI(TAG, "OTA image marked valid after sustained heartbeats");
}

void mitr_ota_apply_heartbeat_response(const mitr_device_heartbeat_response_t *response)
{
    if (!response || !response->recommended_firmware.has_recommended_firmware) {
        return;
    }

    if (strncmp(response->recommended_firmware.version, CONFIG_MITR_DEVICE_FIRMWARE_VERSION, sizeof(state.target_version)) == 0) {
        if (!state.pending_verify && strcmp(state.state, "pending_verify") != 0) {
            set_state("idle");
        }
        state.update_available = false;
        state.target_version[0] = '\0';
        state.download_url[0] = '\0';
        state.release_notes[0] = '\0';
        state.sha256[0] = '\0';
        state.mandatory = false;
        state.min_battery_pct = 0;
        state.rollout_percentage = 0;
        state.size_bytes = 0;
        return;
    }

    if (response->recommended_firmware.download_url[0] == '\0') {
        set_state("update_available_no_url");
        return;
    }

    state.update_available = true;
    strlcpy(state.target_version, response->recommended_firmware.version, sizeof(state.target_version));
    strlcpy(state.download_url, response->recommended_firmware.download_url, sizeof(state.download_url));
    strlcpy(state.release_notes, response->recommended_firmware.release_notes, sizeof(state.release_notes));
    strlcpy(state.sha256, response->recommended_firmware.sha256, sizeof(state.sha256));
    state.mandatory = response->recommended_firmware.mandatory;
    state.min_battery_pct = response->recommended_firmware.min_battery_pct;
    state.rollout_percentage = response->recommended_firmware.rollout_percentage;
    state.size_bytes = response->recommended_firmware.size_bytes;
    if (strcmp(state.state, "downloading") != 0 && strcmp(state.state, "rebooting") != 0) {
        set_state("update_available");
    }
}

bool mitr_ota_has_pending_update(void)
{
    return state.update_available && state.download_url[0] != '\0';
}

esp_err_t mitr_ota_apply_pending_update(void)
{
    ESP_RETURN_ON_ERROR(mitr_ota_init(), TAG, "OTA manager is unavailable");
    ESP_RETURN_ON_FALSE(mitr_ota_has_pending_update(), ESP_ERR_INVALID_STATE, TAG, "No OTA update is pending");

    set_state("downloading");
    state.last_error[0] = '\0';
    ESP_LOGI(TAG, "Starting OTA update to version=%s url=%s", state.target_version, state.download_url);

    esp_http_client_config_t http_config = {
        .url = state.download_url,
        .timeout_ms = 30000,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .keep_alive_enable = true,
    };
    esp_https_ota_config_t ota_config = {
        .http_config = &http_config,
        .bulk_flash_erase = true,
    };

    esp_err_t err = esp_https_ota(&ota_config);
    if (err != ESP_OK) {
        strlcpy(state.last_error, esp_err_to_name(err), sizeof(state.last_error));
        state.update_available = false;
        set_state("error");
        ESP_LOGE(TAG, "OTA update failed: %s", esp_err_to_name(err));
        return err;
    }

    state.update_available = false;
    set_state("rebooting");
    ESP_LOGI(TAG, "OTA update staged successfully; rebooting into new partition");
    esp_restart();
    return ESP_OK;
}

const char *mitr_ota_state(void)
{
    return state.state[0] != '\0' ? state.state : "idle";
}

const char *mitr_ota_target_version(void)
{
    return state.target_version;
}

const char *mitr_ota_last_error(void)
{
    return state.last_error;
}

bool mitr_ota_pending_verify(void)
{
    return state.pending_verify;
}

int mitr_ota_validation_heartbeat_count(void)
{
    return state.successful_heartbeats_since_boot;
}
