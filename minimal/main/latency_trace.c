#include "latency_trace.h"

#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "mitr_latency";

static int64_t s_boot_epoch_ms = 0;
static int64_t s_wake_epoch_ms = -1;
static uint32_t s_wake_id = 0;

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

void mitr_latency_init(void)
{
    s_boot_epoch_ms = now_ms();
    s_wake_epoch_ms = -1;
    s_wake_id = 0;
}

int64_t mitr_latency_boot_ms(void)
{
    if (s_boot_epoch_ms == 0) {
        mitr_latency_init();
    }
    return now_ms() - s_boot_epoch_ms;
}

void mitr_latency_mark(const char *stage)
{
    ESP_LOGW(TAG, "[TIMING] boot_t=%lldms stage=%s",
             mitr_latency_boot_ms(),
             stage ? stage : "unknown");
}

void mitr_latency_begin_wake(const char *stage)
{
    s_wake_epoch_ms = now_ms();
    s_wake_id += 1;
    ESP_LOGW(TAG, "[TIMING] boot_t=%lldms wake_id=%u wake_t=0ms stage=%s",
             mitr_latency_boot_ms(),
             (unsigned)s_wake_id,
             stage ? stage : "wake_begin");
}

void mitr_latency_mark_wake(const char *stage)
{
    if (s_wake_epoch_ms < 0) {
        mitr_latency_mark(stage);
        return;
    }

    ESP_LOGW(TAG, "[TIMING] boot_t=%lldms wake_id=%u wake_t=%lldms stage=%s",
             mitr_latency_boot_ms(),
             (unsigned)s_wake_id,
             now_ms() - s_wake_epoch_ms,
             stage ? stage : "unknown");
}

void mitr_latency_end_wake(const char *reason)
{
    if (s_wake_epoch_ms < 0) {
        return;
    }

    ESP_LOGW(TAG, "[TIMING] boot_t=%lldms wake_id=%u wake_t=%lldms stage=wake_end reason=%s",
             mitr_latency_boot_ms(),
             (unsigned)s_wake_id,
             now_ms() - s_wake_epoch_ms,
             reason ? reason : "unknown");
    s_wake_epoch_ms = -1;
}
