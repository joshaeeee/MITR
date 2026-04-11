/*
 * Audio preprocessor for wake word detection.
 * Uses the TFLM microfrontend — same pipeline as microWakeWord training.
 * ESPHome-compatible parameters (kahrendt/microwakeword).
 */

#include "audio_preprocessor.h"
#include "tensorflow/lite/experimental/microfrontend/lib/frontend.h"
#include "tensorflow/lite/experimental/microfrontend/lib/frontend_util.h"
#include "esp_log.h"

static const char *TAG = "audio_pre";
static struct FrontendState s_frontend;

void audio_preprocessor_init(void)
{
    struct FrontendConfig config;
    FrontendFillConfigWithDefaults(&config);

    config.window.size_ms                         = 30;
    config.window.step_size_ms                    = 10;

    config.filterbank.num_channels                = AUDIO_NUM_FEATURES;
    config.filterbank.lower_band_limit            = 125.0f;
    config.filterbank.upper_band_limit            = 7500.0f;

    config.pcan_gain_control.enable_pcan          = 1;
    config.pcan_gain_control.strength             = 0.95f;
    config.pcan_gain_control.offset               = 80.0f;
    config.pcan_gain_control.gain_bits            = 21;

    config.noise_reduction.smoothing_bits         = 10;
    config.noise_reduction.even_smoothing         = 0.025f;
    config.noise_reduction.odd_smoothing          = 0.06f;
    config.noise_reduction.min_signal_remaining   = 0.05f;

    config.log_scale.enable_log                   = 1;
    config.log_scale.scale_shift                  = 6;

    if (!FrontendPopulateState(&config, &s_frontend, 16000)) {
        ESP_LOGE(TAG, "FrontendPopulateState failed");
        return;
    }
    ESP_LOGI(TAG, "Audio preprocessor init OK (PCAN+NR, 40 mel bins, 16kHz)");
}

int audio_preprocessor_compute(const int16_t *pcm, int8_t *out)
{
    size_t num_remaining = AUDIO_HOP_SAMPLES;
    struct FrontendOutput result = FrontendProcessSamples(
        &s_frontend, pcm, (size_t)AUDIO_HOP_SAMPLES, &num_remaining);

    if (result.size == 0) return 0;

    /*
     * Quantise frontend uint16 output (0–670 range) → int8.
     * ESPHome formula: ((val * 256) + 333) / 666 - 128
     */
    for (int i = 0; i < (int)result.size; i++) {
        int32_t v = (((int32_t)result.values[i] * 256) + 333) / 666 - 128;
        if (v < -128) v = -128;
        if (v >  127) v =  127;
        out[i] = (int8_t)v;
    }
    return 1;
}
