#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

#include "network.h"
#include "provisioning.h"

static const char *TAG = "mitr_network";

#define NETWORK_EVENT_CONNECTED BIT0
#define NETWORK_EVENT_FAILED    BIT1

typedef struct {
    EventGroupHandle_t event_group;
    int retry_attempt;
    bool connected;
    bool wifi_initialized;
    bool handlers_registered;
    bool wifi_started;
    esp_netif_t *sta_netif;
} network_state_t;

static network_state_t state = {0};

static void ip_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
    ESP_LOGI(TAG, "Connected: ip=" IPSTR ", gateway=" IPSTR, IP2STR(&event->ip_info.ip), IP2STR(&event->ip_info.gw));
    state.retry_attempt = 0;
    state.connected = true;
    xEventGroupSetBits(state.event_group, NETWORK_EVENT_CONNECTED);
}

static void wifi_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    switch (event_id) {
        case WIFI_EVENT_STA_START:
            esp_wifi_connect();
            break;
        case WIFI_EVENT_STA_DISCONNECTED: {
            const wifi_event_sta_disconnected_t *event = (const wifi_event_sta_disconnected_t *)event_data;
            state.connected = false;
            ESP_LOGW(
                TAG,
                "Disconnected: reason=%d attempt=%d ssid=%s",
                event ? event->reason : -1,
                state.retry_attempt + 1,
                strlen(CONFIG_LK_EXAMPLE_WIFI_SSID) > 0 ? CONFIG_LK_EXAMPLE_WIFI_SSID : "<saved>");

            if (CONFIG_LK_EXAMPLE_NETWORK_MAX_RETRIES < 0 ||
                state.retry_attempt < CONFIG_LK_EXAMPLE_NETWORK_MAX_RETRIES) {
                state.retry_attempt++;
                esp_wifi_connect();
                return;
            }

            ESP_LOGE(TAG, "Unable to establish connection after %d attempts", state.retry_attempt);
            xEventGroupSetBits(state.event_group, NETWORK_EVENT_FAILED);
            break;
        }
        default:
            break;
    }
}

static esp_err_t init_common(void)
{
    if (!state.event_group) {
        state.event_group = xEventGroupCreate();
    }

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    if (err == ESP_ERR_NVS_INVALID_STATE) {
        err = ESP_OK;
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to init NVS: %s", esp_err_to_name(err));
        return err;
    }

    err = esp_netif_init();
    if (err != ESP_ERR_INVALID_STATE) {
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Failed to init netif: %s", esp_err_to_name(err));
            return err;
        }
    }

    err = esp_event_loop_create_default();
    if (err != ESP_ERR_INVALID_STATE) {
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Failed to init event loop: %s", esp_err_to_name(err));
            return err;
        }
    }

    return ESP_OK;
}

bool mitr_network_connect(void)
{
    ESP_ERROR_CHECK(init_common());
    if (state.sta_netif == NULL) {
        state.sta_netif = esp_netif_create_default_wifi_sta();
    }

    if (!state.wifi_initialized) {
        wifi_init_config_t wifi_init_config = WIFI_INIT_CONFIG_DEFAULT();
        ESP_ERROR_CHECK(esp_wifi_init(&wifi_init_config));
        state.wifi_initialized = true;
    }
    if (!state.handlers_registered) {
        ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &ip_event_handler, NULL));
        ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL));
        state.handlers_registered = true;
    }

    const bool has_static_wifi = strlen(CONFIG_LK_EXAMPLE_WIFI_SSID) > 0;
    bool provisioning_started = false;
    wifi_config_t wifi_config = {0};
    if (has_static_wifi) {
        strlcpy((char *)wifi_config.sta.ssid, CONFIG_LK_EXAMPLE_WIFI_SSID, sizeof(wifi_config.sta.ssid));
        strlcpy((char *)wifi_config.sta.password, CONFIG_LK_EXAMPLE_WIFI_PASSWORD, sizeof(wifi_config.sta.password));
        wifi_config.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
        wifi_config.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
        wifi_config.sta.threshold.authmode = strlen(CONFIG_LK_EXAMPLE_WIFI_PASSWORD) == 0 ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA_PSK;
        wifi_config.sta.pmf_cfg.capable = true;
        wifi_config.sta.pmf_cfg.required = false;
    } else {
        ESP_ERROR_CHECK(mitr_provisioning_start_if_needed(&provisioning_started));
    }

    state.retry_attempt = 0;
    xEventGroupClearBits(state.event_group, NETWORK_EVENT_CONNECTED | NETWORK_EVENT_FAILED);

    if (state.connected) {
        return true;
    }

    if (provisioning_started) {
        ESP_LOGI(TAG, "Device is not provisioned yet; waiting for BLE onboarding to provide Wi-Fi credentials");
    } else {
        ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
        ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_FLASH));
        ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
        if (has_static_wifi) {
            ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_config));
        }

        ESP_LOGI(
            TAG,
            "Connecting WiFi: ssid=%s auth_threshold=%d",
            has_static_wifi ? (const char *)wifi_config.sta.ssid : "<saved-from-provisioning>",
            has_static_wifi ? wifi_config.sta.threshold.authmode : -1);
        if (!state.wifi_started) {
            ESP_ERROR_CHECK(esp_wifi_start());
            state.wifi_started = true;
        } else {
            ESP_ERROR_CHECK(esp_wifi_connect());
        }
    }

    while (true) {
        EventBits_t bits = xEventGroupWaitBits(
            state.event_group,
            NETWORK_EVENT_CONNECTED | NETWORK_EVENT_FAILED,
            pdFALSE,
            pdFALSE,
            portMAX_DELAY);
        if (bits & NETWORK_EVENT_CONNECTED) {
            return true;
        }
        if (bits & NETWORK_EVENT_FAILED) {
            return false;
        }
    }
}
