
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "esp_capture.h"
#include "av_render.h"

#ifdef __cplusplus
extern "C" {
#endif

/// Initializes the capturer and renderer systems.
int media_init(void);

/// Returns the capturer handle.
///
/// Capturer handle used by the media pipeline.
///
/// How the capturer is configured is determined by the requirements of
/// your application and the hardware you are using.
///
esp_capture_handle_t media_get_capturer(void);

/// Returns the renderer handle.
///
/// Renderer handle used by the media pipeline.
///
/// How the renderer is configured is determined by the requirements of
/// your application and the hardware you are using.
///
av_render_handle_t media_get_renderer(void);

esp_err_t media_set_output_muted(bool muted);
bool media_is_output_muted(void);
int media_get_output_volume(void);

void media_set_mic_muted(bool muted);
bool media_is_mic_muted(void);

esp_err_t media_start_preconnect_capture(void);
void media_stop_preconnect_capture(void);
bool media_is_preconnect_capture_active(void);

/// Play `n_stereo_samples` of stereo 16-bit 16-kHz PCM directly to the speaker.
/// Opens, writes, then closes the playback codec device.
/// Blocks for approximately the audio duration plus I2S drain time.
/// Safe to call when streaming playback is not active.
void media_play_pcm(const int16_t *stereo_pcm, int n_stereo_samples);

/// Play PCM by copying from the source into a small internal-RAM scratch
/// buffer before each device write. Use this when the source asset lives in
/// flash and must not be accessed during cache-disabled codec operations.
void media_play_pcm_chunked(const int16_t *stereo_pcm,
                            int n_stereo_samples,
                            int chunk_stereo_samples,
                            int16_t *scratch_buf);

/// Streaming helper for the Pipecat gateway. Opens playback lazily
/// and writes mono 16-bit PCM by duplicating it to the stereo I2S output.
esp_err_t media_stream_playback_start(int sample_rate);
esp_err_t media_stream_write_mono_pcm16(const int16_t *mono_pcm, int n_samples);
void media_stream_playback_stop(void);

/// Debug helper: routes the selected microphone channel directly to speaker.
/// Intended for bench testing only; this function does not return.
void media_run_mic_loopback_probe(void);

#ifdef __cplusplus
}
#endif
