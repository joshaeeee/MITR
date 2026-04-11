#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* One frontend step: 160 samples = 10 ms @ 16 kHz */
#define AUDIO_HOP_SAMPLES  160
/* mel channels — must match model training config */
#define AUDIO_NUM_FEATURES  40

/**
 * Initialise the TFLM microfrontend with the exact parameters used during
 * microWakeWord training (ESPHome/kahrendt compatible).
 * Call once before audio_preprocessor_compute().
 */
void audio_preprocessor_init(void);

/**
 * Feed exactly AUDIO_HOP_SAMPLES (160) mono int16 samples.
 * Runs the microfrontend (PCAN gain control + noise reduction + log-mel)
 * and writes AUDIO_NUM_FEATURES (40) quantised int8 values into `out`.
 *
 * Returns 1 if features were produced, 0 if the frontend needs more samples
 * to fill its window (first call only — subsequent calls always return 1).
 */
int audio_preprocessor_compute(const int16_t *pcm, int8_t *out);

#ifdef __cplusplus
}
#endif
