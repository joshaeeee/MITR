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
    int64_t connect_started_ms;
    int64_t wifi_start_called_ms;
    int64_t last_connect_call_ms;
    int64_t sta_connected_ms;
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

static void log_boot_timing(const char *state_name, int64_t started_at_ms)
{
    const int64_t now = boot_now_ms();
    if (started_at_ms > 0) {
        ESP_LOGW(TAG, "[BOOT] t=%lldms state=%s elapsed=%lldms",
                 (long long)now,
                 state_name,
                 (long long)(now - started_at_ms));
        return;
    }
    ESP_LOGW(TAG, "[BOOT] t=%lldms state=%s", (long long)now, state_name);
}

static void log_bssid(const char *state_name, const uint8_t bssid[6], uint8_t channel)
{
    ESP_LOGW(TAG, "[BOOT] t=%lldms state=%s channel=%u bssid=%02x:%02x:%02x:%02x:%02x:%02x",
             (long long)boot_now_ms(),
             state_name,
             channel,
             bssid[0],
             bssid[1],
             bssid[2],
             bssid[3],
             bssid[4],
             bssid[5]);
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
    const bool used_wifi_hint = state.using_wifi_hint;
    const bool used_fallback_scan = state.fallback_scan_requested;
    state.retry_attempt = 0;
    state.connected = true;
    wifi_ap_record_t ap_info = {0};
    if (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) {
        ESP_LOGW(
            TAG,
            "[BOOT] t=%lldms state=wifi_got_ip elapsed=%lldms sta_connected_elapsed=%lldms channel=%u rssi=%d used_hint=%d used_fallback=%d bssid=%02x:%02x:%02x:%02x:%02x:%02x",
            (long long)boot_now_ms(),
            (long long)(state.connect_started_ms > 0 ? boot_now_ms() - state.connect_started_ms : 0),
            (long long)(state.sta_connected_ms > 0 ? boot_now_ms() - state.sta_connected_ms : 0),
            ap_info.primary,
            ap_info.rssi,
            used_wifi_hint,
            used_fallback_scan,
            ap_info.bssid[0],
            ap_info.bssid[1],
            ap_info.bssid[2],
            ap_info.bssid[3],
            ap_info.bssid[4],
            ap_info.bssid[5]);
        (void)mitr_device_storage_store_wifi_hint(ap_info.primary, ap_info.bssid);
    } else {
        ESP_LOGW(
            TAG,
            "[BOOT] t=%lldms state=wifi_got_ip elapsed=%lldms sta_connected_elapsed=%lldms used_hint=%d used_fallback=%d",
            (long long)boot_now_ms(),
            (long long)(state.connect_started_ms > 0 ? boot_now_ms() - state.connect_started_ms : 0),
            (long long)(state.sta_connected_ms > 0 ? boot_now_ms() - state.sta_connected_ms : 0),
            used_wifi_hint,
            used_fallback_scan);
    }
    state.using_wifi_hint = false;
    state.fallback_scan_requested = false;
    log_boot_state("wifi_connected");
    xEventGroupSetBits(state.event_group, NETWORK_EVENT_CONNECTED);
}

static void wifi_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    switch (event_id) {
        case WIFI_EVENT_STA_START:
            log_boot_timing("wifi_sta_start", state.wifi_start_called_ms);
            state.last_connect_call_ms = boot_now_ms();
            log_boot_state("wifi_connect_call");
            esp_wifi_connect();
            break;
        case WIFI_EVENT_STA_CONNECTED:
            state.sta_connected_ms = boot_now_ms();
            ESP_LOGW(
                TAG,
                "[BOOT] t=%lldms state=wifi_sta_connected elapsed=%lldms connect_call_elapsed=%lldms used_hint=%d used_fallback=%d",
                (long long)state.sta_connected_ms,
                (long long)(state.connect_started_ms > 0 ? state.sta_connected_ms - state.connect_started_ms : 0),
                (long long)(state.last_connect_call_ms > 0 ? state.sta_connected_ms - state.last_connect_call_ms : 0),
                state.using_wifi_hint,
                state.fallback_scan_requested);
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
            ESP_LOGW(
                TAG,
                "[BOOT] t=%lldms state=wifi_disconnected reason=%d elapsed=%lldms used_hint=%d fallback_requested=%d",
                (long long)boot_now_ms(),
                event ? event->reason : -1,
                (long long)(state.connect_started_ms > 0 ? boot_now_ms() - state.connect_started_ms : 0),
                state.using_wifi_hint,
                state.fallback_scan_requested);

            if (event && wifi_reason_invalidates_hint(event->reason)) {
                (void)mitr_device_storage_clear_wifi_hint();
            }

            if (state.using_wifi_hint && !state.fallback_scan_requested) {
                state.fallback_scan_requested = true;
                state.using_wifi_hint = false;
                ESP_LOGI(TAG, "Fast reconnect hint failed, falling back to full scan");
                log_boot_state("wifi_fast_hint_failed_fallback_scan");
                ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &state.fallback_config));
                state.last_connect_call_ms = boot_now_ms();
                log_boot_state("wifi_connect_call");
                esp_wifi_connect();
                return;
            }

            if (CONFIG_LK_EXAMPLE_NETWORK_MAX_RETRIES < 0 ||
                state.retry_attempt < CONFIG_LK_EXAMPLE_NETWORK_MAX_RETRIES) {
                state.retry_attempt++;
                state.last_connect_call_ms = boot_now_ms();
                log_boot_state("wifi_connect_retry");
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
    state.connect_started_ms = boot_now_ms();
    state.wifi_start_called_ms = 0;
    state.last_connect_call_ms = 0;
    state.sta_connected_ms = 0;
    log_boot_state("wifi_connect_enter");

    ESP_ERROR_CHECK(init_common());
    log_boot_timing("wifi_common_init_done", state.connect_started_ms);
    if (state.sta_netif == NULL) {
        state.sta_netif = esp_netif_create_default_wifi_sta();
        log_boot_timing("wifi_netif_create_done", state.connect_started_ms);
    }

    if (!state.wifi_initialized) {
        wifi_init_config_t wifi_init_config = WIFI_INIT_CONFIG_DEFAULT();
        ESP_ERROR_CHECK(esp_wifi_init(&wifi_init_config));
        state.wifi_initialized = true;
        log_boot_timing("wifi_driver_init_done", state.connect_started_ms);
    }
    if (!state.handlers_registered) {
        ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &ip_event_handler, NULL));
        ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL));
        state.handlers_registered = true;
        log_boot_timing("wifi_handlers_registered", state.connect_started_ms);
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
        log_boot_timing("wifi_already_connected", state.connect_started_ms);
        return true;
    }

    if (provisioning_started) {
        ESP_LOGI(TAG, "Device is not provisioned yet; waiting for BLE onboarding to provide Wi-Fi credentials");
    } else {
        ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
        ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_FLASH));
        ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));
        log_boot_timing("wifi_radio_config_done", state.connect_started_ms);
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
            log_bssid("wifi_hint_ignored", hinted_bssid, hinted_channel);
        }
        state.using_wifi_hint = false;
        state.fallback_scan_requested = true;
        ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &state.fallback_config));
        ESP_LOGW(TAG, "[BOOT] t=%lldms state=wifi_config_done fast_hint=0 channel=0 bssid_set=0 reason=hint_disabled",
                 (long long)boot_now_ms());

        ESP_LOGW(
            TAG,
            "[BOOT] t=%lldms state=wifi_connect_config ssid=%s auth_threshold=%d fast_hint=%d",
            (long long)boot_now_ms(),
            base_config.sta.ssid[0] != '\0' ? (const char *)base_config.sta.ssid : "<saved-from-provisioning>",
            base_config.sta.threshold.authmode,
            state.using_wifi_hint);
        if (!state.wifi_started) {
            state.wifi_start_called_ms = boot_now_ms();
            log_boot_state("wifi_start_call");
            ESP_ERROR_CHECK(esp_wifi_start());
            state.wifi_started = true;
        } else {
            state.last_connect_call_ms = boot_now_ms();
            log_boot_state("wifi_connect_call");
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
