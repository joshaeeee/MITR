#include "boot_feedback.h"

#include "sounds.h"

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
                sounds_play_ready();
                s_state.ready_announced = true;
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
