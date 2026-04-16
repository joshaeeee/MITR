#pragma once

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Pre-generate chime and beep PCM tone buffers.
 * Must be called once after media_init().
 */
void sounds_init(void);

/**
 * Play a short rising-chirp chime (~200 ms) to signal wake-word detection.
 * Blocks until playback is complete.
 */
void sounds_play_chime(void);

/**
 * Play a short falling-chirp beep (~150 ms) to signal session end.
 * Blocks until playback is complete.
 */
void sounds_play_beep(void);

/**
 * Play a short positive cue when boot has reached the first true listening state.
 */
void sounds_play_ready(void);

/**
 * Play a short double-tone when the device enters BLE provisioning mode.
 */
void sounds_play_provisioning_wait(void);

#ifdef __cplusplus
}
#endif
