
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
/// This handle is provided to a LiveKit room when initialized to enable
/// publishing tracks from captured media (i.e. audio from a microphone and/or
/// video from a camera).
///
/// How the capturer is configured is determined by the requirements of
/// your application and the hardware you are using.
///
esp_capture_handle_t media_get_capturer(void);

/// Returns the renderer handle.
///
/// This handle is provided to a LiveKit room when initialized to enable
/// rendering media from subscribed tracks (i.e. playing audio through a
/// speaker and/or displaying video to a screen).
///
/// How the renderer is configured is determined by the requirements of
/// your application and the hardware you are using.
///
av_render_handle_t media_get_renderer(void);

esp_err_t media_set_input_muted(bool muted);
bool media_is_input_muted(void);
esp_err_t media_set_output_muted(bool muted);
bool media_is_output_muted(void);
int media_get_output_volume(void);

/// Reads `n_samples` of mono 16-kHz reference PCM from the playback ring
/// buffer, offset `delay_samples` behind the current write head.  Fills with
/// silence if the buffer does not yet have enough history.
///
/// Called by the AEC capture source to inject the speaker output as the AFE
/// reference channel so true acoustic echo cancellation can be performed.
void media_read_reference_pcm(int16_t *buf, int n_samples, int delay_samples);

esp_err_t media_start_preconnect_capture(void);
void media_stop_preconnect_capture(void);
bool media_is_preconnect_capture_active(void);

/// Play `n_stereo_samples` of stereo 16-bit 16-kHz PCM directly to the speaker.
/// Opens, writes, then closes the playback codec device.
/// Blocks for approximately the audio duration plus I2S drain time.
/// Safe to call only when LiveKit is NOT using the renderer (before join_room
/// or after leave_room).
void media_play_pcm(const int16_t *stereo_pcm, int n_stereo_samples);

/// Play PCM by copying from the source into a small internal-RAM scratch
/// buffer before each device write. Use this when the source asset lives in
/// flash and must not be accessed during cache-disabled codec operations.
void media_play_pcm_chunked(const int16_t *stereo_pcm,
                            int n_stereo_samples,
                            int chunk_stereo_samples,
                            int16_t *scratch_buf);

/// Called by the AEC feed path to signal mic voice activity. Kept for
/// backward compatibility with code paths that tracked last-mic-activity; in
/// the persistent warm-connection model the main loop uses the agent's
/// turn_ended signal instead.
void media_notify_mic_activity(void);

/// Returns the timestamp (ms since boot) of the last detected mic activity.
int64_t media_get_last_mic_activity_ms(void);

#ifdef __cplusplus
}
#endif
