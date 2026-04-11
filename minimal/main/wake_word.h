#pragma once
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Initialise the TFLite interpreter and mel feature extractor.
 * Must be called once after media_init().
 *
 * @return 0 on success, -1 on failure.
 */
int wake_word_init(void);

/**
 * Start the wake word detection FreeRTOS task.
 * The task continuously reads 160-sample (10 ms) chunks from the microphone,
 * computes 40-bin log-mel features, and runs TFLite inference.
 *
 * When the wake word is detected (score >= threshold for >= 3 consecutive
 * frames), the bit `bit` is set on the event group `eg`.
 *
 * @param eg   FreeRTOS event group to signal on detection.
 * @param bit  Bit to set in `eg`.
 */
void wake_word_start(EventGroupHandle_t eg, EventBits_t bit);

/**
 * Stop the wake word task and reset inference state.
 * Blocks until the task has exited.
 */
void wake_word_stop(void);

#ifdef __cplusplus
}
#endif
