#pragma once
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Initialise WakeNet from the "model" flash partition.
 * Call once after PSRAM and media (I2S) are initialised.
 *
 * @return 0 on success, -1 on failure.
 */
int wake_word_init(void);

/**
 * Start the detection FreeRTOS task.
 * On detection, sets bit `bit` on event group `eg`.
 * The task then parks until wake_word_stop() is called.
 *
 * @param eg   FreeRTOS event group to signal on detection.
 * @param bit  Bit to set in `eg`.
 */
void wake_word_start(EventGroupHandle_t eg, EventBits_t bit);

/**
 * Stop the detection task. Blocks until the task exits (up to 2 s).
 */
void wake_word_stop(void);

#ifdef __cplusplus
}
#endif
