#include <string.h>
#include <stdint.h>

#include "esp_check.h"
#include "esp_heap_caps.h"
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

#include "media.h"
#include "preconnect_audio_src.h"

static const char *TAG = "media";

#define NULL_CHECK(pointer, message) \
    ESP_RETURN_ON_FALSE(pointer != NULL, -1, TAG, message)

#define MIC_LOOPBACK_FRAME_SAMPLES 160

#ifndef CONFIG_MITR_MIC_LOOPBACK_CHANNEL
#define CONFIG_MITR_MIC_LOOPBACK_CHANNEL 0
#endif

#ifndef CONFIG_MITR_MIC_LOOPBACK_VOLUME
#define CONFIG_MITR_MIC_LOOPBACK_VOLUME 55
#endif

#ifndef CONFIG_MITR_MIC_LOOPBACK_BITS
#define CONFIG_MITR_MIC_LOOPBACK_BITS 16
#endif

#ifndef CONFIG_MITR_MIC_LOOPBACK_SHIFT
#define CONFIG_MITR_MIC_LOOPBACK_SHIFT 16
#endif

typedef struct {
    esp_capture_sink_handle_t capturer_handle;
    esp_capture_audio_src_if_t *audio_source;
    esp_codec_dev_handle_t record_device;
} capture_system_t;

typedef struct {
    esp_codec_dev_handle_t render_device;
    audio_render_handle_t audio_renderer;
    av_render_handle_t av_renderer_handle;
    bool output_muted;
    int output_volume;
} renderer_system_t;

static capture_system_t capturer_system;
static renderer_system_t renderer_system;
static volatile int64_t s_last_mic_activity_ms = 0;

static uint32_t isqrt_u64(uint64_t value)
{
    uint64_t bit = (uint64_t)1 << 62;
    uint64_t root = 0;

    while (bit > value) {
        bit >>= 2;
    }
    while (bit != 0) {
        if (value >= root + bit) {
            value -= root + bit;
            root = (root >> 1) + bit;
        } else {
            root >>= 1;
        }
        bit >>= 2;
    }

    return (uint32_t)root;
}

static int build_capturer_system(void)
{
    esp_codec_dev_handle_t record_handle = get_record_handle();
    NULL_CHECK(record_handle, "Failed to get record handle");
    capturer_system.record_device = record_handle;

    capturer_system.audio_source = mitr_preconnect_audio_src_new(record_handle);
    NULL_CHECK(capturer_system.audio_source, "Failed to create audio source");
    ESP_LOGI(TAG, "Capture source: preconnect-capable dev src (no AFE)");

    esp_capture_cfg_t cfg = {
        .sync_mode = ESP_CAPTURE_SYNC_MODE_AUDIO,
        .audio_src = capturer_system.audio_source,
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
    esp_audio_enc_register_default();
    esp_audio_dec_register_default();

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

void media_set_mic_muted(bool muted)
{
    mitr_preconnect_audio_src_set_muted(muted);
}

bool media_is_mic_muted(void)
{
    return mitr_preconnect_audio_src_is_muted();
}

void media_read_reference_pcm(int16_t *buf, int n_samples, int delay_samples)
{
    (void)delay_samples;
    memset(buf, 0, (size_t)n_samples * sizeof(int16_t));
}

esp_err_t media_start_preconnect_capture(void)
{
    esp_err_t err = mitr_preconnect_audio_src_start_prebuffer();
    if (err != ESP_OK) {
        mitr_preconnect_audio_src_reset_buffer();
        ESP_LOGW(TAG, "[PRECONNECT] Failed to start prebuffer: %s", esp_err_to_name(err));
        return err;
    }
    ESP_LOGI(TAG, "[PRECONNECT] Capture started");
    return ESP_OK;
}

void media_stop_preconnect_capture(void)
{
    mitr_preconnect_audio_src_stop_prebuffer();
    mitr_preconnect_audio_src_reset_buffer();
    ESP_LOGI(TAG, "[PRECONNECT] Capture stopped");
}

bool media_is_preconnect_capture_active(void)
{
    return mitr_preconnect_audio_src_is_prebuffering();
}

void media_play_pcm(const int16_t *stereo_pcm, int n_stereo_samples)
{
    if (renderer_system.render_device == NULL) {
        ESP_LOGE(TAG, "render_device not initialised");
        return;
    }

    esp_codec_dev_sample_info_t cfg = {
        .sample_rate = 16000,
        .bits_per_sample = 16,
        .channel = 2,
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

    vTaskDelay(pdMS_TO_TICKS((n_stereo_samples * 1000) / 16000 + 50));
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
        .sample_rate = 16000,
        .bits_per_sample = 16,
        .channel = 2,
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

    vTaskDelay(pdMS_TO_TICKS((n_stereo_samples * 1000) / 16000 + 50));
    esp_codec_dev_close(renderer_system.render_device);
}

void media_run_mic_loopback_probe(void)
{
    if (capturer_system.record_device == NULL || renderer_system.render_device == NULL) {
        ESP_LOGE(TAG, "[MIC_PROBE] media_init() has not completed");
        vTaskDelay(portMAX_DELAY);
    }

    const int channel = CONFIG_MITR_MIC_LOOPBACK_CHANNEL;
    const int input_bits = CONFIG_MITR_MIC_LOOPBACK_BITS;
    const int input_shift = CONFIG_MITR_MIC_LOOPBACK_SHIFT;
    const bool stereo_mode = channel == 2;
    const size_t input_channels = stereo_mode ? 2 : 1;
    const size_t input_samples = MIC_LOOPBACK_FRAME_SAMPLES * input_channels;
    const size_t input_sample_bytes = input_bits == 32 ? sizeof(int32_t) : sizeof(int16_t);
    const size_t input_bytes = input_samples * input_sample_bytes;
    void *input = heap_caps_malloc(input_bytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    int16_t *output = heap_caps_malloc(MIC_LOOPBACK_FRAME_SAMPLES * 2 * sizeof(int16_t),
                                       MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (input == NULL || output == NULL) {
        ESP_LOGE(TAG, "[MIC_PROBE] Failed to allocate loopback buffers");
        free(input);
        free(output);
        vTaskDelay(portMAX_DELAY);
    }

    esp_codec_dev_sample_info_t in_cfg = {
        .sample_rate = 16000,
        .bits_per_sample = input_bits,
        .channel = 2,
        .channel_mask = stereo_mode ? 0x3 : ESP_CODEC_DEV_MAKE_CHANNEL_MASK(channel),
    };
    esp_codec_dev_sample_info_t out_cfg = {
        .sample_rate = 16000,
        .bits_per_sample = 16,
        .channel = 2,
    };

    ESP_LOGW(TAG,
             "[MIC_PROBE] Starting loopback: channel=%d (%s), volume=%d. "
             "input_bits=%d shift=%d. Keep speaker away from mic to avoid feedback.",
             channel,
             channel == 0 ? "left" : (channel == 1 ? "right" : "stereo"),
             CONFIG_MITR_MIC_LOOPBACK_VOLUME,
             input_bits,
             input_shift);

    int ret = esp_codec_dev_open(capturer_system.record_device, &in_cfg);
    if (ret != 0) {
        ESP_LOGE(TAG, "[MIC_PROBE] Failed to open record device: %d", ret);
        vTaskDelay(portMAX_DELAY);
    }
    ret = esp_codec_dev_open(renderer_system.render_device, &out_cfg);
    if (ret != 0) {
        ESP_LOGE(TAG, "[MIC_PROBE] Failed to open playback device: %d", ret);
        esp_codec_dev_close(capturer_system.record_device);
        vTaskDelay(portMAX_DELAY);
    }
    esp_codec_dev_set_out_vol(renderer_system.render_device, CONFIG_MITR_MIC_LOOPBACK_VOLUME);

    uint32_t frames = 0;
    while (true) {
        ret = esp_codec_dev_read(capturer_system.record_device, input, (int)input_bytes);
        if (ret != 0) {
            ESP_LOGW(TAG, "[MIC_PROBE] read returned %d", ret);
            vTaskDelay(pdMS_TO_TICKS(5));
            continue;
        }

        int16_t min_sample = INT16_MAX;
        int16_t max_sample = INT16_MIN;
        int64_t sum = 0;
        uint64_t square_sum = 0;
        for (int i = 0; i < MIC_LOOPBACK_FRAME_SAMPLES; ++i) {
            int16_t sample;
            if (stereo_mode) {
                int16_t left;
                int16_t right;
                if (input_bits == 32) {
                    const int32_t *samples = (const int32_t *)input;
                    left = (int16_t)(samples[i * 2] >> input_shift);
                    right = (int16_t)(samples[i * 2 + 1] >> input_shift);
                } else {
                    const int16_t *samples = (const int16_t *)input;
                    left = samples[i * 2];
                    right = samples[i * 2 + 1];
                }
                output[i * 2] = left;
                output[i * 2 + 1] = right;
                sample = left;
            } else {
                if (input_bits == 32) {
                    const int32_t *samples = (const int32_t *)input;
                    sample = (int16_t)(samples[i] >> input_shift);
                } else {
                    const int16_t *samples = (const int16_t *)input;
                    sample = samples[i];
                }
                output[i * 2] = sample;
                output[i * 2 + 1] = sample;
            }
            if (sample < min_sample) min_sample = sample;
            if (sample > max_sample) max_sample = sample;
            sum += sample;
            square_sum += (uint64_t)((int32_t)sample * (int32_t)sample);
        }

        ret = esp_codec_dev_write(renderer_system.render_device,
                                  output,
                                  MIC_LOOPBACK_FRAME_SAMPLES * 2 * (int)sizeof(int16_t));
        if (ret != 0) {
            ESP_LOGW(TAG, "[MIC_PROBE] write returned %d", ret);
        }

        frames++;
        if ((frames % 100) == 0) {
            ESP_LOGI(TAG,
                     "[MIC_PROBE] channel=%d rms=%u dc=%d min=%d max=%d",
                     channel,
                     (unsigned)isqrt_u64(square_sum / MIC_LOOPBACK_FRAME_SAMPLES),
                     (int)(sum / MIC_LOOPBACK_FRAME_SAMPLES),
                     (int)min_sample,
                     (int)max_sample);
        }
    }
}

void media_notify_mic_activity(void)
{
    s_last_mic_activity_ms = esp_timer_get_time() / 1000;
}
