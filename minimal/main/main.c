#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "livekit.h"

#include "board.h"
#include "device_api.h"
#include "device_storage.h"
#include "example.h"
#include "media.h"
#include "network.h"

static const char *TAG = "mitr_device_main";

static void mitr_device_task(void *arg)
{
    esp_log_level_set("*", ESP_LOG_INFO);

    ESP_ERROR_CHECK(livekit_system_init());
    ESP_ERROR_CHECK(mitr_device_storage_init());
    board_init();
    ESP_ERROR_CHECK(media_init());

    esp_sntp_config_t sntp_config = ESP_NETIF_SNTP_DEFAULT_CONFIG_MULTIPLE(
        2,
        ESP_SNTP_SERVER_LIST("time.google.com", "pool.ntp.org"));
    esp_netif_sntp_init(&sntp_config);

    ESP_LOGI(
        TAG,
        "Booting Mitr device: backend=%s firmware=%s hardware=%s language=%s",
        mitr_device_backend_base_url(),
        mitr_device_firmware_version(),
        mitr_device_hardware_rev(),
        mitr_device_language());

    if (!mitr_network_connect()) {
        ESP_LOGE(TAG, "Wi-Fi connection failed");
        vTaskDelay(portMAX_DELAY);
        return;
    }

    if (!mitr_device_has_access_token()) {
        if (!mitr_device_has_pairing_token()) {
            ESP_LOGE(TAG, "Device is missing both a long-lived access token and a pairing token");
            vTaskDelay(portMAX_DELAY);
            return;
        }

        while (!mitr_device_has_access_token()) {
            esp_err_t err = mitr_device_complete_bootstrap();
            if (err == ESP_OK) {
                ESP_LOGI(TAG, "Device bootstrap completed; long-lived credential stored");
                break;
            }
            ESP_LOGW(TAG, "Device bootstrap failed: %s. Retrying in 10 seconds", esp_err_to_name(err));
            vTaskDelay(pdMS_TO_TICKS(10 * 1000));
        }
    }

    while (!join_room()) {
        ESP_LOGW(TAG, "Session bootstrap failed; retrying in 10 seconds");
        vTaskDelay(pdMS_TO_TICKS(10 * 1000));
    }

    while (session_is_active()) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }

    ESP_LOGW(TAG, "Session became inactive; device will stay idle until reboot");
    leave_room();
    vTaskDelay(portMAX_DELAY);
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
