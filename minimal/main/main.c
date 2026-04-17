#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "esp_ota_ops.h"
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

// ---------------------------------------------------------------------------
// State machine event group — bit set by wake_word.c on detection.
// ---------------------------------------------------------------------------
#define EG_WAKE_DETECTED    (EventBits_t)BIT0

// ---------------------------------------------------------------------------
// Retry / timing constants
// ---------------------------------------------------------------------------
static const int ROOM_RETRY_BACKOFFS_SEC[] = {2, 5, 10, 30};
static const int ROOM_RETRY_CAP_SEC = 60;
static const int BOOTSTRAP_RETRY_SEC = 10;
static const int NETWORK_RETRY_SEC = 30;
static const int CONFIG_RETRY_SEC = 60;

// How long after a turn ends (with no agent turn_ended signal) before the
// device auto-re-mutes as a safety net. Matches the prior inactivity timer.
static const int TURN_WATCHDOG_TIMEOUT_MS = 20000;

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

// Connect (or reconnect) the persistent LiveKit room. Blocks with exponential
// backoff until it succeeds. Always returns once connected so the caller can
// enter the wake-listen loop.
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

// Apply a pending OTA if there is one and we're in a safe state (muted, no
// wake handling in progress). OTA apply reboots on success so this returns
// only when there was nothing to do or the apply failed.
static void maybe_apply_pending_update_if_idle(void)
{
    if (!mitr_ota_has_pending_update()) {
        return;
    }
    if (!media_is_input_muted()) {
        /* Turn in progress — skip; try again after the turn ends. */
        return;
    }

    ESP_LOGI(TAG, "[OTA] Pending update found; leaving room to apply");
    leave_room();

    esp_err_t err = mitr_ota_apply_pending_update();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "[OTA] apply failed: %s — reconnecting room", esp_err_to_name(err));
        connect_room_blocking();
        media_set_input_muted(true);
        return;
    }

    /* apply should reboot — if we return, treat it as a failure. */
    ESP_LOGW(TAG, "[OTA] apply returned without rebooting; forcing restart");
    esp_restart();
}

// ---------------------------------------------------------------------------
// Main device task
// ---------------------------------------------------------------------------

static void mitr_device_task(void *arg)
{
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
    sounds_init();
    mitr_boot_feedback_init();

    ESP_LOGI(
        TAG,
        "Booting Mitr device: backend=%s firmware=%s hardware=%s language=%s",
        mitr_device_backend_base_url(),
        mitr_device_firmware_version(),
        mitr_device_hardware_rev(),
        mitr_device_language());

    if (wake_word_init() != 0) {
        ESP_LOGE(TAG, "wake_word_init() failed — continuing without wake word detection");
    }

    esp_sntp_config_t sntp_config = ESP_NETIF_SNTP_DEFAULT_CONFIG_MULTIPLE(
        2,
        ESP_SNTP_SERVER_LIST("time.google.com", "pool.ntp.org"));
    esp_netif_sntp_init(&sntp_config);

    /* ---------------------------------------------------------------------------
     * Network / bootstrap — run once before joining the persistent room.
     * --------------------------------------------------------------------------- */
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
        /* Apply any pending OTA now, BEFORE connecting the persistent room,
         * so we don't have to tear a healthy room down mid-conversation. */
        if (mitr_ota_has_pending_update()) {
            esp_err_t err = mitr_ota_apply_pending_update();
            if (err != ESP_OK) {
                ESP_LOGW(TAG, "Pending OTA update was not applied: %s", esp_err_to_name(err));
            }
        }
        break;
    }

    /* ---------------------------------------------------------------------------
     * Persistent warm LiveKit connection.
     *
     *   1. Connect the room once. Stay connected across reboots-worth of idle.
     *   2. Start the shared capture pipeline. Keep mic MUTED — the wake-word
     *      tap receives frames off the capture ring without the LiveKit encoder
     *      actually publishing any audio.
     *   3. On wake: unmute, publish {type:"wake"} to the agent, chime. Agent
     *      handles the turn via its VAD/STT pipeline while mic audio flows in
     *      real time (no cold-start tail).
     *   4. On agent turn_ended (or watchdog): re-mute, re-arm wake word.
     *   5. Room never closes during normal operation. Reconnect is handled by
     *      the LiveKit client SDK internally; we only force a rejoin on hard
     *      failure.
     * --------------------------------------------------------------------------- */
    EventGroupHandle_t eg = xEventGroupCreate();
    if (!eg) {
        ESP_LOGE(TAG, "Failed to create state event group — halting");
        vTaskDelete(NULL);
        return;
    }

    /* Order is load-bearing:
     *   1. media_start_preconnect_capture() opens the I2S codec device and
     *      kicks off the capture task. The codec MUST be open before any
     *      esp_codec_dev_set_in_mute() call can succeed.
     *   2. media_set_input_muted(true) — now safe; also closes the window
     *      where unmuted mic audio could leak into LiveKit's publish path.
     *   3. connect_room_blocking() — LiveKit subscribes to the already-running
     *      capture source and sees muted frames from the very first publish.
     */
    esp_err_t preconnect_err = media_start_preconnect_capture();
    if (preconnect_err != ESP_OK) {
        ESP_LOGE(TAG, "[STATE] Failed to start preconnect capture: %s",
                 esp_err_to_name(preconnect_err));
    }

    esp_err_t mute_err = media_set_input_muted(true);
    if (mute_err != ESP_OK) {
        ESP_LOGE(TAG, "[STATE] Initial mic mute failed: %s", esp_err_to_name(mute_err));
    }

    connect_room_blocking();

    xEventGroupClearBits(eg, EG_WAKE_DETECTED);
    wake_word_start(eg, EG_WAKE_DETECTED);

    mitr_boot_feedback_set_state(MITR_BOOT_STATE_READY_CONNECTED);
    log_boot_state("ready_connected");
    esp_log_level_set("*", ESP_LOG_INFO);

    while (true) {
        /* Wait for a wake event. While muted the LiveKit SDK publishes silent
         * frames so the server-side connection stays healthy; billing-wise
         * this is explicit v1 scope (warm connection always on). */
        ESP_LOGI(TAG, "[STATE] Waiting for wake word (mic muted)");
        xEventGroupWaitBits(eg, EG_WAKE_DETECTED, pdTRUE, pdFALSE, portMAX_DELAY);

        /* Gate on the room actually being connected. If LiveKit dropped while
         * we were idle, reconnect before handing the turn over. */
        if (!session_is_active()) {
            ESP_LOGW(TAG, "[STATE] Wake but room not active — reconnecting");
            leave_room();
            connect_room_blocking();
            media_set_input_muted(true);
            wake_word_rearm();
            continue;
        }

        const int64_t wake_at_ms = wake_word_last_detected_at_ms() > 0
            ? wake_word_last_detected_at_ms()
            : now_ms();

        mitr_boot_feedback_set_state(MITR_BOOT_STATE_ACTIVE_SESSION);
        ESP_LOGI(TAG, "[STATE] Wake at t=%lldms — unmuting and notifying agent", wake_at_ms);

        /* Order matters: unmute FIRST (that's the latency-critical path),
         * then notify the agent, then the chime. The chime runs on the
         * renderer which is a different codec path from the mic, so it
         * doesn't delay the mic-to-agent frame delivery. */
        media_set_input_muted(false);
        publish_wake_event(wake_at_ms);
        sounds_play_chime();

        /* Wait for the agent's turn_ended signal, or fall back to a watchdog
         * if the agent never sends one. Break out on hard session loss. */
        const int64_t turn_started_ms = now_ms();
        while (true) {
            if (consume_turn_ended()) {
                ESP_LOGI(TAG, "[STATE] Turn ended by agent");
                break;
            }
            if (!session_is_active()) {
                ESP_LOGW(TAG, "[STATE] Session lost during turn");
                break;
            }
            if ((now_ms() - turn_started_ms) >= TURN_WATCHDOG_TIMEOUT_MS) {
                ESP_LOGW(TAG, "[STATE] Turn watchdog fired after %d ms", TURN_WATCHDOG_TIMEOUT_MS);
                break;
            }
            vTaskDelay(pdMS_TO_TICKS(100));
        }

        /* Return to the warm-listening state: mute, re-arm wake word. */
        media_set_input_muted(true);
        wake_word_rearm();
        xEventGroupClearBits(eg, EG_WAKE_DETECTED);

        /* If the room dropped, force a clean rejoin before the next wake. */
        if (!session_is_active()) {
            leave_room();
            connect_room_blocking();
            media_set_input_muted(true);
        }

        /* Apply any pending OTA now that we're idle again. Reboots on success. */
        maybe_apply_pending_update_if_idle();
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
