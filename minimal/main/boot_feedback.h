#pragma once

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    MITR_BOOT_STATE_POWER_ON = 0,
    MITR_BOOT_STATE_WIFI_CONNECTING,
    MITR_BOOT_STATE_PROVISIONING_WAIT,
    MITR_BOOT_STATE_BACKEND_BOOTSTRAP,
    MITR_BOOT_STATE_READY_CONNECTED,
    MITR_BOOT_STATE_RETRYING,
    MITR_BOOT_STATE_ACTIVE_SESSION,
} mitr_boot_state_t;

void mitr_boot_feedback_init(void);
void mitr_boot_feedback_set_state(mitr_boot_state_t state);
bool mitr_boot_feedback_is_ready_announced(void);
void mitr_boot_feedback_reset_ready_announcement(void);

#ifdef __cplusplus
}
#endif
