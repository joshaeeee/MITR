#include "boot_feedback.h"

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "sounds.h"

static const char *TAG = "mitr_boot_feedback";

typedef struct {
    bool initialized;
    bool ready_announced;
    mitr_boot_state_t last_state;
} boot_feedback_state_t;

static boot_feedback_state_t s_state = {
    .initialized = false,
    .ready_announced = false,
    .last_state = MITR_BOOT_STATE_POWER_ON,
};

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

static void ready_feedback_task(void *arg)
{
    (void)arg;

    const int64_t ready_feedback_started_ms = now_ms();
    ESP_LOGW(TAG, "[BOOT] t=%lldms state=ready_feedback_start",
             (long long)ready_feedback_started_ms);
    sounds_play_ready();
    const int64_t ready_feedback_done_ms = now_ms();
    ESP_LOGW(TAG, "[BOOT] t=%lldms state=ready_feedback_done elapsed=%lldms",
             (long long)ready_feedback_done_ms,
             (long long)(ready_feedback_done_ms - ready_feedback_started_ms));
    vTaskDelete(NULL);
}

void mitr_boot_feedback_init(void)
{
    s_state.initialized = true;
    s_state.ready_announced = false;
    s_state.last_state = MITR_BOOT_STATE_POWER_ON;
}

void mitr_boot_feedback_set_state(mitr_boot_state_t state)
{
    if (!s_state.initialized || s_state.last_state == state) {
        return;
    }

    s_state.last_state = state;

    switch (state) {
        case MITR_BOOT_STATE_PROVISIONING_WAIT:
            sounds_play_provisioning_wait();
            break;
        case MITR_BOOT_STATE_READY_LISTENING:
        case MITR_BOOT_STATE_READY_CONNECTED:
            if (!s_state.ready_announced) {
                s_state.ready_announced = true;
                BaseType_t task_created = xTaskCreatePinnedToCore(
                    ready_feedback_task,
                    "mitr_ready_cue",
                    4096,
                    NULL,
                    4,
                    NULL,
                    tskNO_AFFINITY);
                if (task_created != pdPASS) {
                    ESP_LOGW(TAG, "Unable to start ready feedback task");
                }
            }
            break;
        default:
            break;
    }
}

bool mitr_boot_feedback_is_ready_announced(void)
{
    return s_state.ready_announced;
}

void mitr_boot_feedback_reset_ready_announcement(void)
{
    s_state.ready_announced = false;
}
