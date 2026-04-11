#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define MEL_NUM_BINS    40
#define MEL_HOP_SAMPLES 160   /* 10 ms @ 16 kHz */
#define MEL_WIN_SAMPLES 480   /* 30 ms window   */

/**
 * Pre-compute Hann window, FFT twiddle factors, and mel filterbank weights.
 * Must be called once before mel_features_compute().
 * Allocates from PSRAM.
 */
void mel_features_init(void);

/**
 * Accepts exactly MEL_HOP_SAMPLES (160) new 16-bit mono mic samples.
 * Slides the 480-sample window, applies Hann window, runs 512-pt FFT,
 * applies 40 triangular mel filters, takes log, and writes MEL_NUM_BINS
 * float values into `out`.
 *
 * Output range: approximately [-10, +6] (log10 of mel energy).
 * The caller (wake_word.cc) quantises to int8 using the model's input quant params.
 */
void mel_features_compute(const int16_t *new_samples, float *out);

#ifdef __cplusplus
}
#endif
