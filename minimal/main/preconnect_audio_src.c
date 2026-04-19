#include "preconnect_audio_src.h"

#include <stdlib.h>
#include <string.h>

#include "esp_capture_types.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "preconnect_audio";

#define PREBUFFER_SAMPLE_RATE         16000
#define PREBUFFER_CHANNELS_MONO       1
#define PREBUFFER_BITS_PER_SAMPLE     16
#define PREBUFFER_RING_CAPACITY_BYTES (PREBUFFER_SAMPLE_RATE * 2 * 8)
#define PREBUFFER_CAPTURE_SAMPLES     160
#define MITR_PRECONNECT_MAX_TAPS      4

typedef struct {
    mitr_preconnect_tap_cb_t cb;
    void *ctx;
} mitr_preconnect_tap_slot_t;

static mitr_preconnect_tap_slot_t s_taps[MITR_PRECONNECT_MAX_TAPS];
static SemaphoreHandle_t s_taps_lock = NULL;

typedef struct {
    esp_capture_audio_src_if_t base;
    esp_codec_dev_handle_t record_handle;
    esp_capture_audio_info_t info;
    SemaphoreHandle_t lock;
    TaskHandle_t task;
    uint8_t *ring;
    size_t ring_capacity;
    size_t ring_head;
    size_t ring_tail;
    size_t ring_size;
    size_t dropped_bytes;
    uint32_t frame_num;
    bool overflow_logged;
    bool has_primed_preroll;
    bool use_fixed_caps;
    bool open;
    bool consumer_started;
    bool prebuffering;
    bool capture_running;
    bool stop_requested;
} mitr_preconnect_audio_src_t;

static mitr_preconnect_audio_src_t *s_src = NULL;

static void reset_ring_locked(mitr_preconnect_audio_src_t *src)
{
    src->ring_head = 0;
    src->ring_tail = 0;
    src->ring_size = 0;
    src->dropped_bytes = 0;
    src->frame_num = 0;
    src->overflow_logged = false;
    src->has_primed_preroll = false;
}

static size_t ring_write_locked(mitr_preconnect_audio_src_t *src, const uint8_t *data, size_t bytes)
{
    if (bytes >= src->ring_capacity) {
        data += (bytes - src->ring_capacity);
        bytes = src->ring_capacity;
        reset_ring_locked(src);
    } else {
        while ((src->ring_capacity - src->ring_size) < bytes) {
            src->ring_tail = (src->ring_tail + 1) % src->ring_capacity;
            src->ring_size--;
            src->dropped_bytes++;
        }
    }

    for (size_t i = 0; i < bytes; ++i) {
        src->ring[src->ring_head] = data[i];
        src->ring_head = (src->ring_head + 1) % src->ring_capacity;
    }
    src->ring_size += bytes;
    if (src->dropped_bytes > 0 && !src->overflow_logged) {
        src->overflow_logged = true;
        ESP_LOGW(TAG, "[PREROLL] preconnect_ring_overflow_dropped=%u",
                 (unsigned)(src->dropped_bytes / sizeof(int16_t)));
    }
    return bytes;
}

static size_t ring_read_locked(mitr_preconnect_audio_src_t *src, uint8_t *data, size_t bytes)
{
    size_t to_read = bytes < src->ring_size ? bytes : src->ring_size;
    for (size_t i = 0; i < to_read; ++i) {
        data[i] = src->ring[src->ring_tail];
        src->ring_tail = (src->ring_tail + 1) % src->ring_capacity;
    }
    src->ring_size -= to_read;
    return to_read;
}

static void preconnect_capture_task(void *arg)
{
    mitr_preconnect_audio_src_t *src = (mitr_preconnect_audio_src_t *)arg;
    const size_t stereo_samples = PREBUFFER_CAPTURE_SAMPLES * 2;
    int16_t *stereo = heap_caps_malloc(stereo_samples * sizeof(int16_t), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    int16_t *mono = heap_caps_malloc(PREBUFFER_CAPTURE_SAMPLES * sizeof(int16_t), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (stereo == NULL || mono == NULL) {
        ESP_LOGE(TAG, "Failed to allocate capture buffers");
        free(stereo);
        free(mono);
        xSemaphoreTake(src->lock, portMAX_DELAY);
        src->capture_running = false;
        src->stop_requested = false;
        xSemaphoreGive(src->lock);
        vTaskDelete(NULL);
        return;
    }

    while (true) {
        xSemaphoreTake(src->lock, portMAX_DELAY);
        const bool should_stop = src->stop_requested;
        xSemaphoreGive(src->lock);
        if (should_stop) {
            break;
        }

        int ret = esp_codec_dev_read(src->record_handle, stereo, stereo_samples * (int)sizeof(int16_t));
        if (ret != 0) {
            vTaskDelay(pdMS_TO_TICKS(5));
            continue;
        }

        for (int i = 0; i < PREBUFFER_CAPTURE_SAMPLES; ++i) {
            mono[i] = stereo[i * 2];
        }

        xSemaphoreTake(src->lock, portMAX_DELAY);
        ring_write_locked(src, (const uint8_t *)mono, PREBUFFER_CAPTURE_SAMPLES * sizeof(int16_t));
        xSemaphoreGive(src->lock);

        mitr_preconnect_tap_slot_t local_taps[MITR_PRECONNECT_MAX_TAPS];
        if (s_taps_lock != NULL) {
            xSemaphoreTake(s_taps_lock, portMAX_DELAY);
            memcpy(local_taps, s_taps, sizeof(local_taps));
            xSemaphoreGive(s_taps_lock);
            for (int i = 0; i < MITR_PRECONNECT_MAX_TAPS; ++i) {
                if (local_taps[i].cb != NULL) {
                    local_taps[i].cb(mono, PREBUFFER_CAPTURE_SAMPLES, local_taps[i].ctx);
                }
            }
        }
    }

    esp_codec_dev_close(src->record_handle);
    free(stereo);
    free(mono);

    xSemaphoreTake(src->lock, portMAX_DELAY);
    src->capture_running = false;
    src->stop_requested = false;
    xSemaphoreGive(src->lock);
    vTaskDelete(NULL);
}

static esp_err_t ensure_capture_running_locked(mitr_preconnect_audio_src_t *src, bool reset_buffer)
{
    if (reset_buffer) {
        reset_ring_locked(src);
    }
    if (src->capture_running) {
        return ESP_OK;
    }

    esp_codec_dev_sample_info_t cfg = {
        .sample_rate = PREBUFFER_SAMPLE_RATE,
        .bits_per_sample = PREBUFFER_BITS_PER_SAMPLE,
        .channel = 2,
    };
    int ret = esp_codec_dev_open(src->record_handle, &cfg);
    if (ret != 0) {
        ESP_LOGE(TAG, "Failed to open preconnect record device: %d", ret);
        return ESP_FAIL;
    }

    src->stop_requested = false;
    BaseType_t created = xTaskCreatePinnedToCore(
        preconnect_capture_task,
        "preconnect_audio",
        6144,
        src,
        5,
        &src->task,
        tskNO_AFFINITY);
    if (created != pdPASS) {
        ESP_LOGE(TAG, "Failed to create preconnect capture task");
        esp_codec_dev_close(src->record_handle);
        src->task = NULL;
        return ESP_FAIL;
    }

    src->capture_running = true;
    return ESP_OK;
}

static void stop_capture_task_locked(mitr_preconnect_audio_src_t *src)
{
    if (!src->capture_running) {
        src->task = NULL;
        reset_ring_locked(src);
        return;
    }

    src->stop_requested = true;
    TaskHandle_t task = src->task;
    xSemaphoreGive(src->lock);
    bool lock_held = false;
    for (int i = 0; i < 100; ++i) {
        vTaskDelay(pdMS_TO_TICKS(10));
        xSemaphoreTake(src->lock, portMAX_DELAY);
        lock_held = true;
        if (!src->capture_running) {
            break;
        }
        xSemaphoreGive(src->lock);
        lock_held = false;
    }
    if (!lock_held) {
        xSemaphoreTake(src->lock, portMAX_DELAY);
    }
    if (src->capture_running && task != NULL) {
        ESP_LOGW(TAG, "Preconnect capture task did not exit cleanly; force deleting");
        vTaskDelete(task);
        esp_codec_dev_close(src->record_handle);
        src->capture_running = false;
        src->stop_requested = false;
    }
    src->task = NULL;
    reset_ring_locked(src);
}

static esp_capture_err_t src_open(esp_capture_audio_src_if_t *h)
{
    mitr_preconnect_audio_src_t *src = (mitr_preconnect_audio_src_t *)h;
    src->open = true;
    return ESP_CAPTURE_ERR_OK;
}

static esp_capture_err_t src_get_support_codecs(esp_capture_audio_src_if_t *h,
                                                const esp_capture_format_id_t **codecs,
                                                uint8_t *num)
{
    static esp_capture_format_id_t supported[] = {ESP_CAPTURE_FMT_ID_PCM};
    (void)h;
    *codecs = supported;
    *num = 1;
    return ESP_CAPTURE_ERR_OK;
}

static esp_capture_err_t src_set_fixed_caps(esp_capture_audio_src_if_t *h, const esp_capture_audio_info_t *fixed_caps)
{
    mitr_preconnect_audio_src_t *src = (mitr_preconnect_audio_src_t *)h;
    if (fixed_caps == NULL || fixed_caps->format_id != ESP_CAPTURE_FMT_ID_PCM) {
        return ESP_CAPTURE_ERR_INVALID_ARG;
    }
    src->info = *fixed_caps;
    src->use_fixed_caps = true;
    return ESP_CAPTURE_ERR_OK;
}

static esp_capture_err_t src_negotiate_caps(esp_capture_audio_src_if_t *h,
                                            esp_capture_audio_info_t *in_caps,
                                            esp_capture_audio_info_t *out_caps)
{
    mitr_preconnect_audio_src_t *src = (mitr_preconnect_audio_src_t *)h;
    if (src->use_fixed_caps) {
        if (in_caps->format_id != src->info.format_id) {
            return ESP_CAPTURE_ERR_NOT_SUPPORTED;
        }
        *out_caps = src->info;
        return ESP_CAPTURE_ERR_OK;
    }
    if (in_caps->format_id != ESP_CAPTURE_FMT_ID_PCM) {
        return ESP_CAPTURE_ERR_NOT_SUPPORTED;
    }
    *out_caps = src->info;
    src->info = *out_caps;
    return ESP_CAPTURE_ERR_OK;
}

static esp_capture_err_t src_start(esp_capture_audio_src_if_t *h)
{
    mitr_preconnect_audio_src_t *src = (mitr_preconnect_audio_src_t *)h;
    xSemaphoreTake(src->lock, portMAX_DELAY);
    src->consumer_started = true;
    esp_err_t err = ensure_capture_running_locked(src, false);
    xSemaphoreGive(src->lock);
    return err == ESP_OK ? ESP_CAPTURE_ERR_OK : ESP_CAPTURE_ERR_INTERNAL;
}

static esp_capture_err_t src_read_frame(esp_capture_audio_src_if_t *h, esp_capture_stream_frame_t *frame)
{
    mitr_preconnect_audio_src_t *src = (mitr_preconnect_audio_src_t *)h;
    if (frame == NULL || frame->data == NULL || frame->size <= 0) {
        return ESP_CAPTURE_ERR_INVALID_ARG;
    }

    size_t copied = 0;
    while (copied < (size_t)frame->size) {
        xSemaphoreTake(src->lock, portMAX_DELAY);
        if (!src->capture_running && src->ring_size == 0) {
            xSemaphoreGive(src->lock);
            return ESP_CAPTURE_ERR_INVALID_STATE;
        }
        copied += ring_read_locked(src, ((uint8_t *)frame->data) + copied, (size_t)frame->size - copied);
        xSemaphoreGive(src->lock);
        if (copied < (size_t)frame->size) {
            vTaskDelay(pdMS_TO_TICKS(2));
        }
    }

    const int samples = frame->size / (PREBUFFER_BITS_PER_SAMPLE / 8 * PREBUFFER_CHANNELS_MONO);
    frame->pts = src->frame_num * samples * 1000 / PREBUFFER_SAMPLE_RATE;
    src->frame_num++;
    return ESP_CAPTURE_ERR_OK;
}

static esp_capture_err_t src_stop(esp_capture_audio_src_if_t *h)
{
    mitr_preconnect_audio_src_t *src = (mitr_preconnect_audio_src_t *)h;
    xSemaphoreTake(src->lock, portMAX_DELAY);
    src->consumer_started = false;
    if (!src->prebuffering) {
        stop_capture_task_locked(src);
    }
    xSemaphoreGive(src->lock);
    return ESP_CAPTURE_ERR_OK;
}

static esp_capture_err_t src_close(esp_capture_audio_src_if_t *h)
{
    mitr_preconnect_audio_src_t *src = (mitr_preconnect_audio_src_t *)h;
    src->open = false;
    return ESP_CAPTURE_ERR_OK;
}

esp_capture_audio_src_if_t *mitr_preconnect_audio_src_new(esp_codec_dev_handle_t record_handle)
{
    if (record_handle == NULL) {
        return NULL;
    }
    mitr_preconnect_audio_src_t *src = calloc(1, sizeof(*src));
    if (src == NULL) {
        return NULL;
    }

    src->lock = xSemaphoreCreateMutex();
    src->ring = heap_caps_malloc(PREBUFFER_RING_CAPACITY_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (src->lock == NULL || src->ring == NULL) {
        if (src->lock != NULL) {
            vSemaphoreDelete(src->lock);
        }
        free(src->ring);
        free(src);
        return NULL;
    }

    if (s_taps_lock == NULL) {
        s_taps_lock = xSemaphoreCreateMutex();
        memset(s_taps, 0, sizeof(s_taps));
    }

    src->base.open = src_open;
    src->base.get_support_codecs = src_get_support_codecs;
    src->base.set_fixed_caps = src_set_fixed_caps;
    src->base.negotiate_caps = src_negotiate_caps;
    src->base.start = src_start;
    src->base.read_frame = src_read_frame;
    src->base.stop = src_stop;
    src->base.close = src_close;
    src->record_handle = record_handle;
    src->ring_capacity = PREBUFFER_RING_CAPACITY_BYTES;
    src->info = (esp_capture_audio_info_t){
        .format_id = ESP_CAPTURE_FMT_ID_PCM,
        .sample_rate = PREBUFFER_SAMPLE_RATE,
        .channel = PREBUFFER_CHANNELS_MONO,
        .bits_per_sample = PREBUFFER_BITS_PER_SAMPLE,
    };
    src->use_fixed_caps = true;
    s_src = src;
    return &src->base;
}

esp_err_t mitr_preconnect_audio_src_start_prebuffer(void)
{
    if (s_src == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    xSemaphoreTake(s_src->lock, portMAX_DELAY);
    s_src->prebuffering = true;
    const bool preserve_primed_preroll = s_src->has_primed_preroll;
    esp_err_t err = ensure_capture_running_locked(s_src, !preserve_primed_preroll);
    s_src->has_primed_preroll = false;
    xSemaphoreGive(s_src->lock);
    return err;
}

void mitr_preconnect_audio_src_stop_prebuffer(void)
{
    if (s_src == NULL) {
        return;
    }
    xSemaphoreTake(s_src->lock, portMAX_DELAY);
    s_src->prebuffering = false;
    if (!s_src->consumer_started) {
        stop_capture_task_locked(s_src);
    }
    xSemaphoreGive(s_src->lock);
}

bool mitr_preconnect_audio_src_is_prebuffering(void)
{
    if (s_src == NULL) {
        return false;
    }
    bool active = false;
    xSemaphoreTake(s_src->lock, portMAX_DELAY);
    active = s_src->prebuffering;
    xSemaphoreGive(s_src->lock);
    return active;
}

void mitr_preconnect_audio_src_reset_buffer(void)
{
    if (s_src == NULL) {
        return;
    }
    xSemaphoreTake(s_src->lock, portMAX_DELAY);
    reset_ring_locked(s_src);
    xSemaphoreGive(s_src->lock);
}

esp_err_t mitr_preconnect_audio_src_prime_preroll(const int16_t *mono_pcm, size_t sample_count)
{
    if (s_src == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    if (mono_pcm == NULL || sample_count == 0) {
        return ESP_OK;
    }

    xSemaphoreTake(s_src->lock, portMAX_DELAY);
    if (s_src->consumer_started || s_src->capture_running || s_src->prebuffering) {
        xSemaphoreGive(s_src->lock);
        return ESP_ERR_INVALID_STATE;
    }

    reset_ring_locked(s_src);
    ring_write_locked(s_src, (const uint8_t *)mono_pcm, sample_count * sizeof(int16_t));
    s_src->has_primed_preroll = true;
    xSemaphoreGive(s_src->lock);

    ESP_LOGW(TAG, "[PREROLL] primed_samples=%u", (unsigned)sample_count);
    return ESP_OK;
}

esp_err_t mitr_preconnect_audio_src_register_tap(mitr_preconnect_tap_cb_t cb, void *ctx)
{
    if (cb == NULL || s_taps_lock == NULL) {
        return ESP_ERR_INVALID_ARG;
    }

    esp_err_t err = ESP_ERR_NO_MEM;
    xSemaphoreTake(s_taps_lock, portMAX_DELAY);
    for (int i = 0; i < MITR_PRECONNECT_MAX_TAPS; ++i) {
        if (s_taps[i].cb == cb && s_taps[i].ctx == ctx) {
            err = ESP_OK;
            break;
        }
        if (s_taps[i].cb == NULL) {
            s_taps[i].cb = cb;
            s_taps[i].ctx = ctx;
            err = ESP_OK;
            break;
        }
    }
    xSemaphoreGive(s_taps_lock);
    return err;
}

void mitr_preconnect_audio_src_unregister_tap(mitr_preconnect_tap_cb_t cb, void *ctx)
{
    if (cb == NULL || s_taps_lock == NULL) {
        return;
    }
    xSemaphoreTake(s_taps_lock, portMAX_DELAY);
    for (int i = 0; i < MITR_PRECONNECT_MAX_TAPS; ++i) {
        if (s_taps[i].cb == cb && s_taps[i].ctx == ctx) {
            s_taps[i].cb = NULL;
            s_taps[i].ctx = NULL;
            break;
        }
    }
    xSemaphoreGive(s_taps_lock);
}
