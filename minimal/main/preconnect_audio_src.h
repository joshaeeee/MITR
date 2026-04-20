#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_capture_audio_src_if.h"
#include "esp_codec_dev.h"
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_capture_audio_src_if_t *mitr_preconnect_audio_src_new(esp_codec_dev_handle_t record_handle);

esp_err_t mitr_preconnect_audio_src_start_prebuffer(void);
void mitr_preconnect_audio_src_stop_prebuffer(void);
bool mitr_preconnect_audio_src_is_prebuffering(void);
void mitr_preconnect_audio_src_reset_buffer(void);

void mitr_preconnect_audio_src_set_muted(bool muted);
bool mitr_preconnect_audio_src_is_muted(void);

typedef void (*mitr_preconnect_tap_cb_t)(const int16_t *mono_pcm,
                                         size_t sample_count,
                                         void *ctx);

esp_err_t mitr_preconnect_audio_src_register_tap(mitr_preconnect_tap_cb_t cb, void *ctx);
void mitr_preconnect_audio_src_unregister_tap(mitr_preconnect_tap_cb_t cb, void *ctx);

#ifdef __cplusplus
}
#endif
