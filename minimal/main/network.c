#include <string.h>

#include "esp_check.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
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
    esp_netif_t *sta_netif;
    int retry_attempt;
    bool connected;
    bool wifi_initialized;
    bool handlers_registered;
    bool wifi_started;
    bool connect_failed;
    bool provisioning_started;
    int64_t started_ms;
} network_state_t;

static network_state_t state = {0};

static int64_t boot_now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

static void log_boot_state(const char *state_name)
{
    ESP_LOGW(TAG, "[BOOT] t=%lldms state=%s", (long long)boot_now_ms(), state_name);
}

static void log_boot_elapsed(const char *state_name)
{
    const int64_t now = boot_now_ms();
    ESP_LOGW(TAG,
             "[BOOT] t=%lldms state=%s elapsed=%lldms",
             (long long)now,
             state_name,
             (long long)(state.started_ms > 0 ? now - state.started_ms : 0));
}

static bool should_retry(void)
{
    return CONFIG_LK_EXAMPLE_NETWORK_MAX_RETRIES < 0 ||
           state.retry_attempt < CONFIG_LK_EXAMPLE_NETWORK_MAX_RETRIES;
}

static void wifi_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    (void)arg;
    (void)event_base;

    if (event_id == WIFI_EVENT_STA_START) {
        log_boot_state("wifi_sta_start");
        ESP_ERROR_CHECK(esp_wifi_connect());
        return;
    }

    if (event_id == WIFI_EVENT_STA_DISCONNECTED) {
        const wifi_event_sta_disconnected_t *event = (const wifi_event_sta_disconnected_t *)event_data;
        state.connected = false;
        ESP_LOGW(TAG,
                 "Wi-Fi disconnected: reason=%d attempt=%d",
                 event ? event->reason : -1,
                 state.retry_attempt + 1);

        if (should_retry()) {
            state.retry_attempt++;
            ESP_LOGI(TAG, "Retrying Wi-Fi connection");
            ESP_ERROR_CHECK(esp_wifi_connect());
            return;
        }

        state.connect_failed = true;
        ESP_LOGE(TAG, "Unable to establish Wi-Fi after %d attempt(s)", state.retry_attempt);
        xEventGroupSetBits(state.event_group, NETWORK_EVENT_FAILED);
    }
}

static void ip_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
    (void)arg;
    (void)event_base;
    (void)event_id;

    ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
    ESP_LOGI(TAG, "Connected: ip=" IPSTR ", gateway=" IPSTR, IP2STR(&event->ip_info.ip), IP2STR(&event->ip_info.gw));

    state.retry_attempt = 0;
    state.connected = true;
    state.connect_failed = false;
    log_boot_elapsed("wifi_connected");
    xEventGroupSetBits(state.event_group, NETWORK_EVENT_CONNECTED);
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
        ESP_LOGE(TAG, "Failed to initialize NVS: %s", esp_err_to_name(err));
        return err;
    }

    err = esp_netif_init();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "Failed to initialize netif: %s", esp_err_to_name(err));
        return err;
    }

    err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "Failed to create event loop: %s", esp_err_to_name(err));
        return err;
    }

    return ESP_OK;
}

static void fill_static_wifi_config(wifi_config_t *wifi_config)
{
    strlcpy((char *)wifi_config->sta.ssid, CONFIG_LK_EXAMPLE_WIFI_SSID, sizeof(wifi_config->sta.ssid));
    strlcpy((char *)wifi_config->sta.password, CONFIG_LK_EXAMPLE_WIFI_PASSWORD, sizeof(wifi_config->sta.password));
    wifi_config->sta.threshold.authmode =
        strlen(CONFIG_LK_EXAMPLE_WIFI_PASSWORD) == 0 ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;
}

static esp_err_t ensure_wifi_initialized(void)
{
    ESP_RETURN_ON_ERROR(init_common(), TAG, "Failed to initialize network dependencies");

    if (state.sta_netif == NULL) {
        state.sta_netif = esp_netif_create_default_wifi_sta();
    }

    if (!state.wifi_initialized) {
        wifi_init_config_t wifi_init_config = WIFI_INIT_CONFIG_DEFAULT();
        ESP_RETURN_ON_ERROR(esp_wifi_init(&wifi_init_config), TAG, "Failed to initialize Wi-Fi");
        state.wifi_initialized = true;
    }

    if (!state.handlers_registered) {
        ESP_RETURN_ON_ERROR(
            esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL),
            TAG,
            "Failed to register Wi-Fi event handler");
        ESP_RETURN_ON_ERROR(
            esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &ip_event_handler, NULL),
            TAG,
            "Failed to register IP event handler");
        state.handlers_registered = true;
    }

    return ESP_OK;
}

esp_err_t mitr_network_start(bool *provisioning_started)
{
    if (provisioning_started != NULL) {
        *provisioning_started = false;
    }

    ESP_RETURN_ON_ERROR(ensure_wifi_initialized(), TAG, "Failed to initialize Wi-Fi");
    xEventGroupClearBits(state.event_group, NETWORK_EVENT_CONNECTED | NETWORK_EVENT_FAILED);

    if (state.connected) {
        log_boot_elapsed("wifi_already_connected");
        xEventGroupSetBits(state.event_group, NETWORK_EVENT_CONNECTED);
        return ESP_OK;
    }

    const bool has_static_wifi = strlen(CONFIG_LK_EXAMPLE_WIFI_SSID) > 0;
    if (!has_static_wifi) {
        if (state.provisioning_started) {
            if (provisioning_started != NULL) {
                *provisioning_started = true;
            }
            return ESP_OK;
        }

        bool started = false;
        ESP_RETURN_ON_ERROR(mitr_provisioning_start_if_needed(&started), TAG, "Failed to start provisioning");
        if (provisioning_started != NULL) {
            *provisioning_started = started;
        }
        if (started) {
            state.provisioning_started = true;
            return ESP_OK;
        }
    }

    if (state.wifi_started && !state.connect_failed) {
        return ESP_OK;
    }

    state.started_ms = boot_now_ms();
    state.retry_attempt = 0;
    state.connect_failed = false;
    log_boot_state("wifi_start_enter");

    wifi_config_t wifi_config = {0};
    if (has_static_wifi) {
        fill_static_wifi_config(&wifi_config);
    } else {
        ESP_RETURN_ON_ERROR(esp_wifi_get_config(WIFI_IF_STA, &wifi_config), TAG, "Failed to read provisioned Wi-Fi config");
    }

    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_STA), TAG, "Failed to set Wi-Fi station mode");
    ESP_RETURN_ON_ERROR(esp_wifi_set_storage(WIFI_STORAGE_FLASH), TAG, "Failed to set Wi-Fi storage");
    ESP_RETURN_ON_ERROR(esp_wifi_set_ps(WIFI_PS_NONE), TAG, "Failed to disable Wi-Fi power save");
    ESP_RETURN_ON_ERROR(esp_wifi_set_config(WIFI_IF_STA, &wifi_config), TAG, "Failed to set Wi-Fi config");

    if (!state.wifi_started) {
        log_boot_state("wifi_start");
        ESP_RETURN_ON_ERROR(esp_wifi_start(), TAG, "Failed to start Wi-Fi");
        state.wifi_started = true;
    } else {
        log_boot_state("wifi_connect_retry");
        ESP_RETURN_ON_ERROR(esp_wifi_connect(), TAG, "Failed to connect Wi-Fi");
    }

    return ESP_OK;
}

bool mitr_network_wait_connected(TickType_t timeout)
{
    if (state.connected) {
        return true;
    }
    if (state.event_group == NULL) {
        return false;
    }

    EventBits_t bits = xEventGroupWaitBits(
        state.event_group,
        NETWORK_EVENT_CONNECTED | NETWORK_EVENT_FAILED,
        pdFALSE,
        pdFALSE,
        timeout);

    return (bits & NETWORK_EVENT_CONNECTED) != 0;
}

bool mitr_network_is_connected(void)
{
    return state.connected;
}
