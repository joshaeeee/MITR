#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "esp_ota_ops.h"
#include "livekit.h"

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

// ---------------------------------------------------------------------------
// State machine event group
// ---------------------------------------------------------------------------
// Bits set by wake_word.c (session timeout is backend-driven, not device-driven).
#define EG_WAKE_DETECTED    (EventBits_t)BIT0

// ---------------------------------------------------------------------------
// Retry / timing constants (unchanged from original)
// ---------------------------------------------------------------------------
static const int ROOM_RETRY_BACKOFFS_SEC[] = {2, 5, 10, 30};
static const int ROOM_RETRY_CAP_SEC = 60;
static const int BOOTSTRAP_RETRY_SEC = 10;
static const int NETWORK_RETRY_SEC = 30;
static const int CONFIG_RETRY_SEC = 60;

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
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

static void maybe_apply_pending_update(void)
{
    if (!mitr_ota_has_pending_update()) {
        return;
    }

    esp_err_t err = mitr_ota_apply_pending_update();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Pending OTA update was not applied: %s", esp_err_to_name(err));
    }
}

// ---------------------------------------------------------------------------
// Main device task
// ---------------------------------------------------------------------------

static void mitr_device_task(void *arg)
{
    esp_log_level_set("*", ESP_LOG_INFO);

    // Mark this firmware as valid immediately — prevents OTA rollback from
    // restoring the previous binary on next crash. The old behaviour (waiting
    // for 3 heartbeats over 5 minutes) caused a vicious cycle: new binary
    // crashes before heartbeats complete → rollback → old binary runs again.
    esp_ota_mark_app_valid_cancel_rollback();

    ESP_ERROR_CHECK(mitr_device_storage_init());
    ESP_ERROR_CHECK(mitr_ota_init());
    ESP_ERROR_CHECK(livekit_system_init());
    board_init();
    ESP_ERROR_CHECK(media_init());

    ESP_LOGI(
        TAG,
        "Booting Mitr device: backend=%s firmware=%s hardware=%s language=%s",
        mitr_device_backend_base_url(),
        mitr_device_firmware_version(),
        mitr_device_hardware_rev(),
        mitr_device_language());

    /* Initialise wake word engine and sound effects */
    if (wake_word_init() != 0) {
        ESP_LOGE(TAG, "wake_word_init() failed — continuing without wake word detection");
    }
    sounds_init();

    esp_sntp_config_t sntp_config = ESP_NETIF_SNTP_DEFAULT_CONFIG_MULTIPLE(
        2,
        ESP_SNTP_SERVER_LIST("time.google.com", "pool.ntp.org"));
    esp_netif_sntp_init(&sntp_config);

    /* ---------------------------------------------------------------------------
     * Network / bootstrap (run once before entering the wake-word loop)
     * --------------------------------------------------------------------------- */
    while (true) {
        if (!mitr_network_connect()) {
            ESP_LOGW(TAG, "Wi-Fi connection failed; retrying in %d seconds", NETWORK_RETRY_SEC);
            sleep_seconds(NETWORK_RETRY_SEC);
            continue;
        }

        if (!ensure_device_bootstrapped()) {
            ESP_LOGW(TAG, "Device bootstrap prerequisites are incomplete; retrying in %d seconds",
                     CONFIG_RETRY_SEC);
            sleep_seconds(CONFIG_RETRY_SEC);
            continue;
        }

        maybe_apply_pending_update();
        break;  /* Network and bootstrap are good — enter the wake-word state machine */
    }

    /* ---------------------------------------------------------------------------
     * SLEEPING / ACTIVE state machine
     * --------------------------------------------------------------------------- */
    EventGroupHandle_t eg = xEventGroupCreate();
    if (!eg) {
        ESP_LOGE(TAG, "Failed to create state event group — halting");
        vTaskDelete(NULL);
        return;
    }

    int room_retry_attempt    = 0;
    int64_t recovery_start_ms = 0;

    while (true) {
        /* ================================================================
         * SLEEPING — wake word listening, no LiveKit session
         * ================================================================ */
        ESP_LOGI(TAG, "[STATE] Entering SLEEPING — starting wake word listener");
        xEventGroupClearBits(eg, EG_WAKE_DETECTED);
        wake_word_start(eg, EG_WAKE_DETECTED);

        /* Block until wake word detected (indefinitely) */
        xEventGroupWaitBits(eg, EG_WAKE_DETECTED, pdTRUE, pdFALSE, portMAX_DELAY);
        wake_word_stop();

        ESP_LOGI(TAG, "[STATE] Wake word confirmed — transitioning to ACTIVE");
        sounds_play_chime();

        /* ================================================================
         * ACTIVE — LiveKit session running
         * ================================================================ */
        ESP_LOGI(TAG, "[STATE] Entering ACTIVE — joining LiveKit room");

        /* Make sure we have a live Wi-Fi connection before joining */
        if (!mitr_network_connect()) {
            ESP_LOGW(TAG, "[STATE] Wi-Fi lost; returning to SLEEPING");
            sleep_seconds(2);
            continue;
        }

        if (!join_room()) {
            if (recovery_start_ms == 0) recovery_start_ms = now_ms();
            const int delay_sec = next_room_retry_delay_sec(room_retry_attempt, recovery_start_ms);
            ESP_LOGW(TAG, "[STATE] join_room() failed; retry in %d s (attempt %d)",
                     delay_sec, room_retry_attempt + 1);
            room_retry_attempt++;
            sounds_play_beep();
            sleep_seconds(delay_sec);
            continue;
        }

        room_retry_attempt = 0;
        recovery_start_ms  = 0;

        /* ----------------------------------------------------------------
         * Wait for the backend/LiveKit to end the session.
         * The device does NOT impose an inactivity timeout — disconnection
         * is driven entirely by the backend (LiveKit server closes the room
         * or the agent sends a Leave signal). We just poll session_is_active()
         * every 500 ms and exit when the room goes away.
         * ---------------------------------------------------------------- */
        ESP_LOGI(TAG, "[STATE] Room joined — waiting for backend-driven disconnect");
        while (session_is_active()) {
            vTaskDelay(pdMS_TO_TICKS(500));
        }

        ESP_LOGI(TAG, "[STATE] LiveKit session ended by backend — returning to SLEEPING");
        sounds_play_beep();
        leave_room();
        maybe_apply_pending_update();
        sleep_seconds(1);
        /* Loop back to SLEEPING */
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
