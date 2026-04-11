#pragma once
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Start the inactivity timer.
 *
 * @param timeout_sec   Seconds of silence before triggering session end.
 * @param eg            Event group to signal when timeout fires.
 * @param bit           Bit to set in `eg` on timeout.
 */
void session_timeout_start(int timeout_sec, EventGroupHandle_t eg, EventBits_t bit);

/** Stop and delete the timer (safe to call when not running). */
void session_timeout_stop(void);

/**
 * Reset the inactivity timer to zero.
 * Call this on any voice or agent activity to prevent premature disconnect.
 */
void session_timeout_notify_activity(void);

#ifdef __cplusplus
}
#endif
