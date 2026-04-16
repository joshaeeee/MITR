#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

#include "device_storage.h"
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
    bool using_wifi_hint;
    bool fallback_scan_requested;
    esp_netif_t *sta_netif;
    wifi_config_t hinted_config;
    wifi_config_t fallback_config;
} network_state_t;

static network_state_t state = {0};

static int64_t boot_now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

static void log_boot_state(const char *state_name)
{
    ESP_LOGW(TAG, "[BOOT] t=%lldms state=%s", boot_now_ms(), state_name);
}

static bool wifi_reason_invalidates_hint(wifi_err_reason_t reason)
{
    switch (reason) {
        case WIFI_REASON_AUTH_EXPIRE:
        case WIFI_REASON_AUTH_FAIL:
        case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
        case WIFI_REASON_HANDSHAKE_TIMEOUT:
        case WIFI_REASON_NO_AP_FOUND:
        case WIFI_REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD:
        case WIFI_REASON_NO_AP_FOUND_IN_RSSI_THRESHOLD:
            return true;
        default:
            return false;
    }
}

static void ip_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
    ESP_LOGI(TAG, "Connected: ip=" IPSTR ", gateway=" IPSTR, IP2STR(&event->ip_info.ip), IP2STR(&event->ip_info.gw));
    state.retry_attempt = 0;
    state.connected = true;
    state.using_wifi_hint = false;
    state.fallback_scan_requested = false;
    wifi_ap_record_t ap_info = {0};
    if (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) {
        (void)mitr_device_storage_store_wifi_hint(ap_info.primary, ap_info.bssid);
    }
    log_boot_state("wifi_connected");
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

            if (event && wifi_reason_invalidates_hint(event->reason)) {
                (void)mitr_device_storage_clear_wifi_hint();
            }

            if (state.using_wifi_hint && !state.fallback_scan_requested) {
                state.fallback_scan_requested = true;
                state.using_wifi_hint = false;
                ESP_LOGI(TAG, "Fast reconnect hint failed, falling back to full scan");
                ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &state.fallback_config));
                esp_wifi_connect();
                return;
            }

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
    wifi_config_t base_config = {0};
    if (has_static_wifi) {
        strlcpy((char *)base_config.sta.ssid, CONFIG_LK_EXAMPLE_WIFI_SSID, sizeof(base_config.sta.ssid));
        strlcpy((char *)base_config.sta.password, CONFIG_LK_EXAMPLE_WIFI_PASSWORD, sizeof(base_config.sta.password));
        base_config.sta.threshold.authmode = strlen(CONFIG_LK_EXAMPLE_WIFI_PASSWORD) == 0 ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA_PSK;
        base_config.sta.pmf_cfg.capable = true;
        base_config.sta.pmf_cfg.required = false;
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
        if (!has_static_wifi) {
            ESP_ERROR_CHECK(esp_wifi_get_config(WIFI_IF_STA, &base_config));
        }

        state.fallback_config = base_config;
        state.fallback_config.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
        state.fallback_config.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
        state.fallback_config.sta.channel = 0;
        state.fallback_config.sta.bssid_set = 0;

        uint8_t hinted_channel = 0;
        uint8_t hinted_bssid[6] = {0};
        if (mitr_device_storage_get_wifi_hint(&hinted_channel, hinted_bssid)) {
            state.hinted_config = base_config;
            state.hinted_config.sta.scan_method = WIFI_FAST_SCAN;
            state.hinted_config.sta.channel = hinted_channel;
            state.hinted_config.sta.bssid_set = 1;
            memcpy(state.hinted_config.sta.bssid, hinted_bssid, sizeof(hinted_bssid));
            state.using_wifi_hint = true;
            state.fallback_scan_requested = false;
            ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &state.hinted_config));
        } else {
            state.using_wifi_hint = false;
            state.fallback_scan_requested = false;
            ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &state.fallback_config));
        }

        ESP_LOGI(
            TAG,
            "Connecting WiFi: ssid=%s auth_threshold=%d fast_hint=%d",
            base_config.sta.ssid[0] != '\0' ? (const char *)base_config.sta.ssid : "<saved-from-provisioning>",
            base_config.sta.threshold.authmode,
            state.using_wifi_hint);
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
