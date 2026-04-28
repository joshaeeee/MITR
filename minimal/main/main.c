#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "livekit.h"

#include "boot_feedback.h"
#include "board.h"
#include "device_api.h"
#include "device_storage.h"
#include "example.h"
#include "media.h"
#include "network.h"
#include "ota_manager.h"
#include "sounds.h"
#include "wake_word.h"

static const char *TAG = "mitr_device_main";
static const EventBits_t WAKE_DETECTED_BIT = BIT0;

static const int CLOUD_RETRY_SEC = 5;
static const int ROOM_RECONNECT_GRACE_MS = 1000;

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
                 esp_err_to_name(err), CLOUD_RETRY_SEC);
        sleep_seconds(CLOUD_RETRY_SEC);
    }

    return true;
}

static void wait_for_network_blocking(void)
{
    while (true) {
        if (mitr_network_wait_connected(pdMS_TO_TICKS(CLOUD_RETRY_SEC * 1000))) {
            return;
        }

        ESP_LOGW(TAG, "Wi-Fi still connecting; checking again in %d seconds", CLOUD_RETRY_SEC);
        bool provisioning_started = false;
        esp_err_t err = mitr_network_start(&provisioning_started);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "Wi-Fi start failed: %s", esp_err_to_name(err));
            mitr_boot_feedback_set_state(MITR_BOOT_STATE_RETRYING);
        }
        if (provisioning_started) {
            mitr_boot_feedback_set_state(MITR_BOOT_STATE_PROVISIONING_WAIT);
        } else {
            mitr_boot_feedback_set_state(MITR_BOOT_STATE_WIFI_CONNECTING);
        }
    }
}

static void connect_room_blocking(void)
{
    while (true) {
        wait_for_network_blocking();
        if (join_room()) {
            return;
        }

        ESP_LOGW(TAG, "[ROOM] join_room() failed; retrying in %d seconds", CLOUD_RETRY_SEC);
        mitr_boot_feedback_set_state(MITR_BOOT_STATE_RETRYING);
        sleep_seconds(CLOUD_RETRY_SEC);
    }
}

static void start_wake_detection(EventGroupHandle_t wake_event_group, bool wake_word_ready)
{
    if (!wake_word_ready || wake_event_group == NULL || session_is_conversation_active()) {
        return;
    }
    xEventGroupClearBits(wake_event_group, WAKE_DETECTED_BIT);
    wake_word_start(wake_event_group, WAKE_DETECTED_BIT);
}

static void maybe_apply_pending_update_if_idle(EventGroupHandle_t wake_event_group, bool wake_word_ready)
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
        start_wake_detection(wake_event_group, wake_word_ready);
        if (!session_is_conversation_active()) {
            mitr_boot_feedback_set_state(MITR_BOOT_STATE_READY_CONNECTED);
        }
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
    mitr_boot_feedback_init();
    mitr_boot_feedback_set_state(MITR_BOOT_STATE_WIFI_CONNECTING);
    log_boot_state("wifi_connecting");

    bool provisioning_started = false;
    ESP_ERROR_CHECK(mitr_network_start(&provisioning_started));

    ESP_ERROR_CHECK(livekit_system_init());
    board_init();
    ESP_ERROR_CHECK(media_init());
    esp_log_level_set("wake_word", ESP_LOG_INFO);
    esp_log_level_set("media", ESP_LOG_INFO);
    esp_log_level_set("preconnect_audio", ESP_LOG_INFO);
    const bool wake_word_ready = wake_word_init() == 0;
    sounds_init();

    ESP_LOGI(
        TAG,
        "Booting Mitr device: backend=%s firmware=%s hardware=%s language=%s",
        mitr_device_backend_base_url(),
        mitr_device_firmware_version(),
        mitr_device_hardware_rev(),
        mitr_device_language());
    if (!wake_word_ready) {
        ESP_LOGE(TAG, "wake_word_init() failed; local wake detection disabled");
    }

    EventGroupHandle_t wake_event_group = xEventGroupCreate();
    if (wake_event_group == NULL) {
        ESP_LOGE(TAG, "Failed to create wake event group");
        vTaskDelete(NULL);
        return;
    }

    esp_sntp_config_t sntp_config = ESP_NETIF_SNTP_DEFAULT_CONFIG_MULTIPLE(
        2,
        ESP_SNTP_SERVER_LIST("time.google.com", "pool.ntp.org"));
    esp_netif_sntp_init(&sntp_config);

    if (provisioning_started) {
        mitr_boot_feedback_set_state(MITR_BOOT_STATE_PROVISIONING_WAIT);
    }

    while (true) {
        wait_for_network_blocking();

        mitr_boot_feedback_set_state(MITR_BOOT_STATE_BACKEND_BOOTSTRAP);
        log_boot_state("bootstrap_start");
        if (!ensure_device_bootstrapped()) {
            ESP_LOGW(TAG, "Device bootstrap prerequisites are incomplete; retrying in %d seconds",
                     CLOUD_RETRY_SEC);
            mitr_boot_feedback_set_state(MITR_BOOT_STATE_RETRYING);
            sleep_seconds(CLOUD_RETRY_SEC);
            mitr_boot_feedback_set_state(MITR_BOOT_STATE_BACKEND_BOOTSTRAP);
            log_boot_state("bootstrap_start");
            continue;
        }

        log_boot_state("bootstrap_complete");
        break;
    }

    if (media_start_preconnect_capture() != ESP_OK) {
        ESP_LOGW(TAG, "Preconnect capture failed to start; wake detector may not receive audio until room capture starts");
    }

    connect_room_blocking();
    start_wake_detection(wake_event_group, wake_word_ready);
    mitr_boot_feedback_set_state(MITR_BOOT_STATE_READY_CONNECTED);
    log_boot_state("ready_connected");
    esp_log_level_set("*", ESP_LOG_INFO);

    while (true) {
        EventBits_t wake_bits = xEventGroupWaitBits(
            wake_event_group,
            WAKE_DETECTED_BIT,
            pdTRUE,
            pdFALSE,
            pdMS_TO_TICKS(100));
        if ((wake_bits & WAKE_DETECTED_BIT) != 0) {
            if (!session_is_active()) {
                ESP_LOGW(TAG, "[ROOM] Wake detected while room inactive; reconnecting before re-arming");
                leave_room();
                vTaskDelay(pdMS_TO_TICKS(ROOM_RECONNECT_GRACE_MS));
                mitr_boot_feedback_set_state(MITR_BOOT_STATE_RETRYING);
                connect_room_blocking();
                if (!session_is_conversation_active()) {
                    mitr_boot_feedback_set_state(MITR_BOOT_STATE_READY_CONNECTED);
                }
                start_wake_detection(wake_event_group, wake_word_ready);
            } else {
                on_wake_detected();
            }
        }

        if (!session_is_active()) {
            ESP_LOGW(TAG, "[ROOM] Session inactive; reconnecting persistent room");
            leave_room();
            vTaskDelay(pdMS_TO_TICKS(ROOM_RECONNECT_GRACE_MS));
            mitr_boot_feedback_set_state(MITR_BOOT_STATE_RETRYING);
            connect_room_blocking();
            start_wake_detection(wake_event_group, wake_word_ready);
            if (!session_is_conversation_active()) {
                mitr_boot_feedback_set_state(MITR_BOOT_STATE_READY_CONNECTED);
            }
        }

        if (!session_is_conversation_active()) {
            maybe_apply_pending_update_if_idle(wake_event_group, wake_word_ready);
        }
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
