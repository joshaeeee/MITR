#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include "boot_feedback.h"
#include "board.h"
#include "device_api.h"
#include "device_storage.h"
#include "gateway_client.h"
#include "media.h"
#include "network.h"
#include "ota_manager.h"
#include "sounds.h"
#if CONFIG_MITR_TRANSPORT_PIPECAT_GATEWAY && !CONFIG_MITR_GATEWAY_SERVER_WAKE_PHRASE
#include "wake_word.h"
#endif

static const char *TAG = "mitr_device_main";
#if CONFIG_MITR_TRANSPORT_PIPECAT_GATEWAY && !CONFIG_MITR_GATEWAY_SERVER_WAKE_PHRASE
static const EventBits_t WAKE_DETECTED_BIT = BIT0;
#endif

static const int BOOTSTRAP_RETRY_SEC = 10;
static const int NETWORK_RETRY_SEC = 30;
static const int CONFIG_RETRY_SEC = 60;

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

static void log_boot_state(const char *state)
{
    ESP_LOGI(TAG, "Boot state: %s (%lldms)", state, now_ms());
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
                 esp_err_to_name(err), BOOTSTRAP_RETRY_SEC);
        sleep_seconds(BOOTSTRAP_RETRY_SEC);
    }

    return true;
}

static void configure_runtime_logging(void)
{
    esp_log_level_set("*", ESP_LOG_WARN);
    esp_log_level_set(TAG, ESP_LOG_INFO);
    esp_log_level_set("mitr_gateway", ESP_LOG_INFO);
    esp_log_level_set("network", ESP_LOG_INFO);
    esp_log_level_set("ota_manager", ESP_LOG_INFO);
#if CONFIG_MITR_TRANSPORT_PIPECAT_GATEWAY && !CONFIG_MITR_GATEWAY_SERVER_WAKE_PHRASE
    esp_log_level_set("wake_word", ESP_LOG_INFO);
#endif
}

#if CONFIG_MITR_TRANSPORT_PIPECAT_GATEWAY
#if !CONFIG_MITR_GATEWAY_SERVER_WAKE_PHRASE
static bool transport_conversation_active(void)
{
    return mitr_gateway_client_is_active();
}

static void start_wake_detection(EventGroupHandle_t wake_event_group, bool wake_word_ready)
{
    if (!wake_word_ready || wake_event_group == NULL || transport_conversation_active()) {
        return;
    }
    xEventGroupClearBits(wake_event_group, WAKE_DETECTED_BIT);
    wake_word_start(wake_event_group, WAKE_DETECTED_BIT);
}
#endif

static void run_gateway_mode(EventGroupHandle_t wake_event_group, bool wake_word_ready)
{
    ESP_LOGI(TAG, "Starting Pipecat gateway transport");
    while (mitr_gateway_client_start() != ESP_OK) {
        ESP_LOGW(TAG, "Gateway connect failed; retrying in %d seconds", NETWORK_RETRY_SEC);
        mitr_boot_feedback_set_state(MITR_BOOT_STATE_RETRYING);
        sleep_seconds(NETWORK_RETRY_SEC);
    }

    mitr_boot_feedback_set_state(MITR_BOOT_STATE_READY_CONNECTED);
    log_boot_state("gateway_ready");

#if CONFIG_MITR_GATEWAY_SERVER_WAKE_PHRASE
    (void)wake_event_group;
    (void)wake_word_ready;
    ESP_LOGI(TAG, "Wake phrase handled by Pipecat backend");
    while (true) {
        sleep_seconds(60);
    }
#else
    start_wake_detection(wake_event_group, wake_word_ready);

    while (true) {
        EventBits_t wake_bits = xEventGroupWaitBits(
            wake_event_group,
            WAKE_DETECTED_BIT,
            pdTRUE,
            pdFALSE,
            pdMS_TO_TICKS(100));
        if ((wake_bits & WAKE_DETECTED_BIT) != 0) {
            mitr_gateway_client_on_wake_detected();
        }
    }
#endif
}
#endif

static void mitr_device_task(void *arg)
{
    (void)arg;
    configure_runtime_logging();

    esp_ota_mark_app_valid_cancel_rollback();

    ESP_ERROR_CHECK(mitr_device_storage_init());
    ESP_ERROR_CHECK(mitr_ota_init());
    board_init();
    ESP_ERROR_CHECK(media_init());
#if CONFIG_MITR_MIC_LOOPBACK_PROBE
    media_run_mic_loopback_probe();
#endif
#if CONFIG_MITR_TRANSPORT_PIPECAT_GATEWAY && !CONFIG_MITR_GATEWAY_SERVER_WAKE_PHRASE
    const bool wake_word_ready = wake_word_init() == 0;
#else
    const bool wake_word_ready = false;
#endif
    sounds_init();
    mitr_boot_feedback_init();

    ESP_LOGI(
        TAG,
        "Booting Mitr device: backend=%s firmware=%s hardware=%s language=%s",
        mitr_device_backend_base_url(),
        mitr_device_firmware_version(),
        mitr_device_hardware_rev(),
        mitr_device_language());
#if CONFIG_MITR_TRANSPORT_PIPECAT_GATEWAY && !CONFIG_MITR_GATEWAY_SERVER_WAKE_PHRASE
    if (!wake_word_ready) {
        ESP_LOGE(TAG, "wake_word_init() failed; local wake detection disabled");
    }
#endif

    EventGroupHandle_t wake_event_group = NULL;
#if CONFIG_MITR_TRANSPORT_PIPECAT_GATEWAY && !CONFIG_MITR_GATEWAY_SERVER_WAKE_PHRASE
    wake_event_group = xEventGroupCreate();
    if (wake_event_group == NULL) {
        ESP_LOGE(TAG, "Failed to create wake event group");
        vTaskDelete(NULL);
        return;
    }
#endif

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

    if (media_start_preconnect_capture() != ESP_OK) {
        ESP_LOGW(TAG, "Preconnect capture failed to start; gateway capture may not receive audio immediately");
    }

    run_gateway_mode(wake_event_group, wake_word_ready);
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
