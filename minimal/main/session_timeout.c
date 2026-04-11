#include "session_timeout.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/timers.h"

static const char *TAG = "sess_timeout";

static TimerHandle_t    s_timer    = NULL;
static EventGroupHandle_t s_eg     = NULL;
static EventBits_t      s_bit      = 0;
static int              s_timeout_sec = 20;
static volatile int64_t s_last_activity_ms = 0;

static void timeout_cb(TimerHandle_t t)
{
    int64_t now    = esp_timer_get_time() / 1000;
    int64_t silent = now - s_last_activity_ms;
    ESP_LOGW(TAG, "[TIMEOUT] %lld ms since last activity — triggering session end",
             (long long)silent);
    if (s_eg) {
        xEventGroupSetBits(s_eg, s_bit);
    }
}

void session_timeout_start(int timeout_sec, EventGroupHandle_t eg, EventBits_t bit)
{
    session_timeout_stop();  // idempotent

    s_eg          = eg;
    s_bit         = bit;
    s_timeout_sec = timeout_sec;
    s_last_activity_ms = esp_timer_get_time() / 1000;

    s_timer = xTimerCreate(
        "sess_timeout",
        pdMS_TO_TICKS(timeout_sec * 1000),
        pdFALSE,  /* one-shot */
        NULL,
        timeout_cb);

    if (s_timer == NULL) {
        ESP_LOGE(TAG, "Failed to create timeout timer");
        return;
    }

    xTimerStart(s_timer, portMAX_DELAY);
    ESP_LOGI(TAG, "[TIMEOUT] Started: will fire in %d s with no activity", timeout_sec);
}

void session_timeout_stop(void)
{
    if (s_timer == NULL) return;
    xTimerStop(s_timer, portMAX_DELAY);
    xTimerDelete(s_timer, portMAX_DELAY);
    s_timer = NULL;
    s_eg    = NULL;
    ESP_LOGI(TAG, "[TIMEOUT] Stopped");
}

void session_timeout_notify_activity(void)
{
    if (s_timer == NULL) return;
    s_last_activity_ms = esp_timer_get_time() / 1000;
    xTimerReset(s_timer, portMAX_DELAY);
    ESP_LOGD(TAG, "[TIMEOUT] Activity detected — timer reset");
}
