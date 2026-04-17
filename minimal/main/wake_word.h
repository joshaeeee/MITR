#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
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

/**
 * Re-arm the detector after a wake event has been consumed by the caller.
 *
 * The task gates itself with `s_detection_pending_stop = true` on detection so
 * it does not re-fire while the agent is still handling the current turn.
 * When the turn ends, call this to resume detection. Flushes internal MFCC
 * state so residual audio from the completed turn is not re-detected.
 */
void wake_word_rearm(void);

int64_t wake_word_last_detected_at_ms(void);
int wake_word_last_start_point_samples(void);

typedef struct {
    const int16_t *pcm;
    size_t sample_count;
    size_t wake_start_sample_index;
    size_t detection_sample_index;
    int64_t detected_at_ms;
} wake_word_preroll_t;

bool wake_word_take_preroll(wake_word_preroll_t *out);

#ifdef __cplusplus
}
#endif
