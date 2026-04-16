#include <string.h>
#include <stdint.h>
#include "esp_check.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "codec_init.h"
#include "av_render_default.h"
#include "esp_audio_dec_default.h"
#include "esp_audio_enc_default.h"
#include "esp_capture_defaults.h"
#include "esp_capture_sink.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include <sdkconfig.h>

#include "media.h"

static const char *TAG = "media";

#define NULL_CHECK(pointer, message) \
    ESP_RETURN_ON_FALSE(pointer != NULL, -1, TAG, message)

typedef struct {
    esp_capture_sink_handle_t capturer_handle;
    esp_capture_audio_src_if_t *audio_source;
    esp_codec_dev_handle_t record_device;
    bool input_muted;
} capture_system_t;

typedef struct {
    esp_codec_dev_handle_t render_device;
    audio_render_handle_t audio_renderer;
    av_render_handle_t av_renderer_handle;
    bool output_muted;
    int output_volume;
} renderer_system_t;

static capture_system_t  capturer_system;
static renderer_system_t renderer_system;

// ---------------------------------------------------------------------------
// Capture system — plain device source (no AFE/AEC).
//
// The AEC source (esp_capture_new_audio_aec_src) was tried but internally
// initialises an AFE_TYPE_SR pipeline that includes its own WakeNet.  In SR
// mode the AFE suppresses audio output until it detects the wake word inside
// the pipeline, so LiveKit never receives mic audio from the agent session.
//
// The simple dev source passes raw I2S frames directly to the capture sink
// and to LiveKit — this is what worked before the AEC attempt.
// ---------------------------------------------------------------------------
static int build_capturer_system(void)
{
    esp_codec_dev_handle_t record_handle = get_record_handle();
    NULL_CHECK(record_handle, "Failed to get record handle");
    capturer_system.record_device = record_handle;

    esp_capture_audio_dev_src_cfg_t codec_cfg = {
        .record_handle = record_handle,
    };
    capturer_system.audio_source = esp_capture_new_audio_dev_src(&codec_cfg);
    NULL_CHECK(capturer_system.audio_source, "Failed to create audio source");
    ESP_LOGI(TAG, "Capture source: plain dev src (no AFE)");

    esp_capture_cfg_t cfg = {
        .sync_mode = ESP_CAPTURE_SYNC_MODE_AUDIO,
        .audio_src = capturer_system.audio_source
    };
    int ret = esp_capture_open(&cfg, &capturer_system.capturer_handle);
    ESP_RETURN_ON_FALSE(ret == 0, -1, TAG, "Failed to open capture system");
    NULL_CHECK(capturer_system.capturer_handle, "Failed to open capture system");
    return 0;
}

static int build_renderer_system(void)
{
    esp_codec_dev_handle_t render_device = get_playback_handle();
    NULL_CHECK(render_device, "Failed to get render device handle");
    renderer_system.render_device = render_device;

    i2s_render_cfg_t i2s_cfg = {
        .play_handle = render_device,
    };
    renderer_system.audio_renderer = av_render_alloc_i2s_render(&i2s_cfg);
    NULL_CHECK(renderer_system.audio_renderer, "Failed to create I2S renderer");

    // Set initial speaker volume
    esp_codec_dev_set_out_vol(i2s_cfg.play_handle, CONFIG_LK_EXAMPLE_SPEAKER_VOLUME);
    renderer_system.output_volume = CONFIG_LK_EXAMPLE_SPEAKER_VOLUME;
    renderer_system.output_muted = false;

    av_render_cfg_t render_cfg = {
        .audio_render = renderer_system.audio_renderer,
        .audio_raw_fifo_size = 8 * 4096,
        .audio_render_fifo_size = 100 * 1024,
        .allow_drop_data = false,
    };
    renderer_system.av_renderer_handle = av_render_open(&render_cfg);
    NULL_CHECK(renderer_system.av_renderer_handle, "Failed to create AV renderer");

    av_render_audio_frame_info_t frame_info = {
        .sample_rate = 16000,
        .channel = 2,
        .bits_per_sample = 16,
    };
    av_render_set_fixed_frame_info(renderer_system.av_renderer_handle, &frame_info);

    return 0;
}

int media_init(void)
{
    // Register default audio encoder and decoder
    esp_audio_enc_register_default();
    esp_audio_dec_register_default();

    // Build capturer and renderer systems
    ESP_RETURN_ON_FALSE(build_capturer_system() == 0, -1, TAG, "Capture init failed");
    ESP_RETURN_ON_FALSE(build_renderer_system() == 0, -1, TAG, "Renderer init failed");
    return 0;
}

esp_capture_handle_t media_get_capturer(void)
{
    return capturer_system.capturer_handle;
}

av_render_handle_t media_get_renderer(void)
{
    return renderer_system.av_renderer_handle;
}

esp_err_t media_set_input_muted(bool muted)
{
    NULL_CHECK(capturer_system.record_device, "Failed to get record handle");
    int ret = esp_codec_dev_set_in_mute(capturer_system.record_device, muted);
    ESP_RETURN_ON_FALSE(ret == 0, ESP_FAIL, TAG, "Failed to set input mute");
    capturer_system.input_muted = muted;
    return ESP_OK;
}

bool media_is_input_muted(void)
{
    return capturer_system.input_muted;
}

esp_err_t media_set_output_muted(bool muted)
{
    NULL_CHECK(renderer_system.render_device, "Failed to get playback handle");
    int ret = esp_codec_dev_set_out_mute(renderer_system.render_device, muted);
    ESP_RETURN_ON_FALSE(ret == 0, ESP_FAIL, TAG, "Failed to set output mute");
    renderer_system.output_muted = muted;
    return ESP_OK;
}

bool media_is_output_muted(void)
{
    return renderer_system.output_muted;
}

int media_get_output_volume(void)
{
    return renderer_system.output_volume;
}

// ---------------------------------------------------------------------------
// Reference PCM stub — kept for header compatibility, returns silence.
// Not needed without the AEC capture source.
// ---------------------------------------------------------------------------
void media_read_reference_pcm(int16_t *buf, int n_samples, int delay_samples)
{
    (void)delay_samples;
    memset(buf, 0, n_samples * sizeof(int16_t));
}

// ---------------------------------------------------------------------------
// Raw mic access (SLEEPING state — bypasses the LiveKit capture pipeline)
// ---------------------------------------------------------------------------

static bool s_raw_mic_open = false;

int media_start_raw_mic(void)
{
    if (s_raw_mic_open) return 0;
    NULL_CHECK(capturer_system.record_device, "record_device not initialised");
    esp_codec_dev_sample_info_t cfg = {
        .sample_rate     = 16000,
        .bits_per_sample = 16,
        .channel         = 2,  /* stereo I2S RX; ch0 = mic, ch1 = unused */
    };
    int ret = esp_codec_dev_open(capturer_system.record_device, &cfg);
    if (ret == 0) {
        s_raw_mic_open = true;
        ESP_LOGI(TAG, "[RAW-MIC] Opened for direct read (16kHz, 2ch, 16-bit)");
    } else {
        ESP_LOGE(TAG, "[RAW-MIC] esp_codec_dev_open failed: %d", ret);
    }
    return ret;
}

void media_stop_raw_mic(void)
{
    if (!s_raw_mic_open) return;
    esp_codec_dev_close(capturer_system.record_device);
    s_raw_mic_open = false;
    ESP_LOGI(TAG, "[RAW-MIC] Closed");
}

int media_read_mic_raw(int16_t *mono_buf, int n_samples)
{
    if (!s_raw_mic_open) return -1;
    int16_t stereo[n_samples * 2];
    int ret = esp_codec_dev_read(capturer_system.record_device,
                                 stereo, n_samples * 2 * (int)sizeof(int16_t));
    if (ret != 0) return ret;
    /* Extract ch0 (mic) */
    for (int i = 0; i < n_samples; i++) {
        mono_buf[i] = stereo[i * 2];
    }
    return 0;
}

// ---------------------------------------------------------------------------
// Direct PCM playback (for chime/beep — use only when LiveKit is not active)
// ---------------------------------------------------------------------------

void media_play_pcm(const int16_t *stereo_pcm, int n_stereo_samples)
{
    if (renderer_system.render_device == NULL) {
        ESP_LOGE(TAG, "render_device not initialised");
        return;
    }

    esp_codec_dev_sample_info_t cfg = {
        .sample_rate     = 16000,
        .bits_per_sample = 16,
        .channel         = 2,
    };
    int ret = esp_codec_dev_open(renderer_system.render_device, &cfg);
    if (ret != 0) {
        ESP_LOGE(TAG, "[PCM] Failed to open playback device: %d", ret);
        return;
    }

    int size = n_stereo_samples * 2 * (int)sizeof(int16_t);
    ret = esp_codec_dev_write(renderer_system.render_device, (void *)stereo_pcm, size);
    if (ret != 0) {
        ESP_LOGW(TAG, "[PCM] esp_codec_dev_write returned %d", ret);
    }

    /* Wait for I2S DMA to drain */
    int drain_ms = (n_stereo_samples * 1000) / 16000 + 50;
    vTaskDelay(pdMS_TO_TICKS(drain_ms));

    esp_codec_dev_close(renderer_system.render_device);
}

void media_play_pcm_chunked(const int16_t *stereo_pcm,
                            int n_stereo_samples,
                            int chunk_stereo_samples,
                            int16_t *scratch_buf)
{
    if (scratch_buf == NULL || chunk_stereo_samples <= 0) {
        media_play_pcm(stereo_pcm, n_stereo_samples);
        return;
    }
    if (renderer_system.render_device == NULL) {
        ESP_LOGE(TAG, "render_device not initialised");
        return;
    }

    esp_codec_dev_sample_info_t cfg = {
        .sample_rate     = 16000,
        .bits_per_sample = 16,
        .channel         = 2,
    };
    int ret = esp_codec_dev_open(renderer_system.render_device, &cfg);
    if (ret != 0) {
        ESP_LOGE(TAG, "[PCM] Failed to open playback device: %d", ret);
        return;
    }

    int remaining = n_stereo_samples;
    int offset = 0;
    while (remaining > 0) {
        int chunk_samples = remaining > chunk_stereo_samples ? chunk_stereo_samples : remaining;
        size_t chunk_bytes = (size_t)chunk_samples * 2 * sizeof(int16_t);
        memcpy(scratch_buf, stereo_pcm + (offset * 2), chunk_bytes);
        ret = esp_codec_dev_write(renderer_system.render_device, (void *)scratch_buf, (int)chunk_bytes);
        if (ret != 0) {
            ESP_LOGW(TAG, "[PCM] chunk write returned %d at offset=%d", ret, offset);
            break;
        }
        offset += chunk_samples;
        remaining -= chunk_samples;
    }

    int drain_ms = (n_stereo_samples * 1000) / 16000 + 50;
    vTaskDelay(pdMS_TO_TICKS(drain_ms));

    esp_codec_dev_close(renderer_system.render_device);
}

// ---------------------------------------------------------------------------
// Mic activity tracking (stub — kept for header compatibility)
// ---------------------------------------------------------------------------

static volatile int64_t s_last_mic_activity_ms = 0;

void media_notify_mic_activity(void)
{
    s_last_mic_activity_ms = esp_timer_get_time() / 1000;
}

int64_t media_get_last_mic_activity_ms(void)
{
    return s_last_mic_activity_ms;
}
