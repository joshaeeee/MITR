
#pragma once

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

#ifdef __cplusplus
}
#endif
