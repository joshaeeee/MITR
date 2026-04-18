#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "boot_feedback.h"
#include "board.h"
#include "device_api.h"
#include "device_storage.h"
#include "example.h"
#include "media.h"
#include "network.h"
#include "ota_manager.h"
#include "sounds.h"

static const char *TAG = "mitr_device_main";

static const int ROOM_RETRY_BACKOFFS_SEC[] = {2, 5, 10, 30};
static const int ROOM_RETRY_CAP_SEC = 60;
static const int BOOTSTRAP_RETRY_SEC = 10;
static const int NETWORK_RETRY_SEC = 30;
static const int CONFIG_RETRY_SEC = 60;

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

static void log_boot_state(const char *state)
{
    ESP_LOGW(TAG, "[BOOT] t=%lldms state=%s", now_ms(), state);
}

static void sleep_seconds(int seconds)
{
    vTaskDelay(pdMS_TO_TICKS(seconds * 1000));
}

static int next_room_retry_delay_sec(int attempt, int64_t recovery_started_at_ms)
{
    const int reconnect_window_sec = session_reconnect_window_sec();
    if (recovery_started_at_ms > 0 &&
        reconnect_window_sec > 0 &&
        (now_ms() - recovery_started_at_ms) >= ((int64_t)reconnect_window_sec * 1000)) {
        return ROOM_RETRY_CAP_SEC;
    }

    const size_t backoff_count = sizeof(ROOM_RETRY_BACKOFFS_SEC) / sizeof(ROOM_RETRY_BACKOFFS_SEC[0]);
    const size_t index = attempt < (int)backoff_count ? (size_t)attempt : (backoff_count - 1);
    return ROOM_RETRY_BACKOFFS_SEC[index];
}

static bool ensure_device_bootstrapped(void)
{
    if (mitr_device_has_access_token()) {
        return true;
    }
    if (!mitr_device_has_pairing_token()) {
        ESP_LOGE(TAG, "Device is missing both a long-lived access token and a pairing token");
        return false;
    }

    while (!mitr_device_has_access_token()) {
        esp_err_t err = mitr_device_complete_bootstrap();
        if (err == ESP_OK) {
            ESP_LOGI(TAG, "Device bootstrap completed; long-lived credential stored");
            return true;
        }

        ESP_LOGW(TAG, "Device bootstrap failed: %s. Retrying in %d seconds",
                 esp_err_to_name(err), BOOTSTRAP_RETRY_SEC);
        sleep_seconds(BOOTSTRAP_RETRY_SEC);
    }

    return true;
}

static void connect_room_blocking(void)
{
    int attempt = 0;
    int64_t recovery_started_ms = 0;

    while (true) {
        if (!mitr_network_connect()) {
            ESP_LOGW(TAG, "[ROOM] Wi-Fi unavailable; retrying in %d s", NETWORK_RETRY_SEC);
            sleep_seconds(NETWORK_RETRY_SEC);
            continue;
        }

        if (join_room()) {
            return;
        }

        if (recovery_started_ms == 0) recovery_started_ms = now_ms();
        const int delay = next_room_retry_delay_sec(attempt, recovery_started_ms);
        ESP_LOGW(TAG, "[ROOM] join_room() failed; retry #%d in %d s", attempt + 1, delay);
        attempt++;
        sleep_seconds(delay);
    }
}

static void maybe_apply_pending_update_if_idle(void)
{
    if (!mitr_ota_has_pending_update()) {
        return;
    }
    if (session_is_conversation_active()) {
        return;
    }

    ESP_LOGI(TAG, "[OTA] Pending update found; leaving room to apply");
    leave_room();

    esp_err_t err = mitr_ota_apply_pending_update();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "[OTA] apply failed: %s — reconnecting room", esp_err_to_name(err));
        connect_room_blocking();
        return;
    }

    ESP_LOGW(TAG, "[OTA] apply returned without rebooting; forcing restart");
    esp_restart();
}

static void mitr_device_task(void *arg)
{
    (void)arg;

    esp_ota_mark_app_valid_cancel_rollback();

    ESP_ERROR_CHECK(mitr_device_storage_init());
    ESP_ERROR_CHECK(mitr_ota_init());
    ESP_ERROR_CHECK(livekit_system_init());
    board_init();
    ESP_ERROR_CHECK(media_init());
    sounds_init();
    mitr_boot_feedback_init();

    ESP_LOGI(
        TAG,
        "Booting Mitr device: backend=%s firmware=%s hardware=%s language=%s",
        mitr_device_backend_base_url(),
        mitr_device_firmware_version(),
        mitr_device_hardware_rev(),
        mitr_device_language());

    esp_sntp_config_t sntp_config = ESP_NETIF_SNTP_DEFAULT_CONFIG_MULTIPLE(
        2,
        ESP_SNTP_SERVER_LIST("time.google.com", "pool.ntp.org"));
    esp_netif_sntp_init(&sntp_config);

    mitr_boot_feedback_set_state(MITR_BOOT_STATE_WIFI_CONNECTING);
    log_boot_state("wifi_connecting");
    while (true) {
        if (!mitr_network_connect()) {
            ESP_LOGW(TAG, "Wi-Fi connection failed; retrying in %d seconds", NETWORK_RETRY_SEC);
            mitr_boot_feedback_set_state(MITR_BOOT_STATE_RETRYING);
            sleep_seconds(NETWORK_RETRY_SEC);
            mitr_boot_feedback_set_state(MITR_BOOT_STATE_WIFI_CONNECTING);
            log_boot_state("wifi_connecting");
            continue;
        }

        mitr_boot_feedback_set_state(MITR_BOOT_STATE_BACKEND_BOOTSTRAP);
        log_boot_state("bootstrap_start");
        if (!ensure_device_bootstrapped()) {
            ESP_LOGW(TAG, "Device bootstrap prerequisites are incomplete; retrying in %d seconds",
                     CONFIG_RETRY_SEC);
            mitr_boot_feedback_set_state(MITR_BOOT_STATE_RETRYING);
            sleep_seconds(CONFIG_RETRY_SEC);
            mitr_boot_feedback_set_state(MITR_BOOT_STATE_BACKEND_BOOTSTRAP);
            log_boot_state("bootstrap_start");
            continue;
        }

        log_boot_state("bootstrap_complete");
        if (mitr_ota_has_pending_update()) {
            esp_err_t err = mitr_ota_apply_pending_update();
            if (err != ESP_OK) {
                ESP_LOGW(TAG, "Pending OTA update was not applied: %s", esp_err_to_name(err));
            }
        }
        break;
    }

    connect_room_blocking();
    mitr_boot_feedback_set_state(MITR_BOOT_STATE_READY_CONNECTED);
    log_boot_state("ready_connected");
    esp_log_level_set("*", ESP_LOG_INFO);

    while (true) {
        if (!session_is_active()) {
            ESP_LOGW(TAG, "[ROOM] Session inactive; reconnecting persistent room");
            leave_room();
            mitr_boot_feedback_set_state(MITR_BOOT_STATE_RETRYING);
            connect_room_blocking();
            if (!session_is_conversation_active()) {
                mitr_boot_feedback_set_state(MITR_BOOT_STATE_READY_CONNECTED);
            }
        }

        if (!session_is_conversation_active()) {
            maybe_apply_pending_update_if_idle();
        }

        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}

void app_main(void)
{
    BaseType_t created = xTaskCreatePinnedToCore(
        mitr_device_task,
        "mitr_device_task",
        12288,
        NULL,
        5,
        NULL,
        tskNO_AFFINITY);

    ESP_ERROR_CHECK(created == pdPASS ? ESP_OK : ESP_FAIL);
}
