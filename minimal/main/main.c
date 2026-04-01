#include "esp_log.h"
#include "esp_netif_sntp.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "livekit.h"
#include "livekit_example_utils.h"

#include "board.h"
#include "device_api.h"
#include "example.h"
#include "media.h"

static const char *TAG = "mitr_device_main";

void app_main(void)
{
    esp_log_level_set("*", ESP_LOG_INFO);

    ESP_ERROR_CHECK(livekit_system_init());
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

    if (!lk_example_network_connect()) {
        ESP_LOGE(TAG, "Wi-Fi connection failed");
        vTaskDelay(portMAX_DELAY);
        return;
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
