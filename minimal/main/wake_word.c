/*
 * Wake word detection — espressif/esp-sr WakeNet standalone.
 *
 * Single library. No TFLite Micro. No custom mel/FFT. No vendored components.
 * espressif/esp-sr handles all audio preprocessing internally.
 *
 * Library: espressif/esp-sr ^2.4.0
 * Target:  ESP32-S3, single mic, 16 kHz mono int16 PCM, no AEC.
 */

#include "wake_word.h"
#include "preconnect_audio_src.h"  /* tap into the shared LiveKit capture stream */

#include "esp_wn_iface.h"
#include "esp_wn_models.h"
#include "model_path.h"

#include <string.h>

#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "freertos/stream_buffer.h"

static const char *TAG = "wake_word";

#define PREROLL_SAMPLE_RATE             16000
#define PREROLL_RING_CAPACITY_SAMPLES   (PREROLL_SAMPLE_RATE * 2)
#define PREROLL_CONTEXT_LEAD_SAMPLES    3200

/* ---- Module state ---- */
static const esp_wn_iface_t *s_wakenet    = NULL;
static model_iface_data_t   *s_model      = NULL;
static int                   s_chunk      = 0;   /* samples per detect() call */

static TaskHandle_t       s_task       = NULL;
static volatile bool      s_stop       = false;
static EventGroupHandle_t s_eg         = NULL;
static EventBits_t        s_detect_bit = 0;
static int64_t            s_last_detected_at_ms = 0;
static int                s_last_start_point_samples = 0;
static size_t             s_post_detect_samples = 0;
static bool               s_detection_pending_stop = false;
static int16_t           *s_preroll_ring = NULL;
static int16_t           *s_preroll_snapshot = NULL;
static size_t             s_preroll_ring_head = 0;
static size_t             s_preroll_ring_count = 0;
static size_t             s_preroll_snapshot_start = 0;
static size_t             s_preroll_snapshot_count = 0;
static size_t             s_preroll_snapshot_wake_start = 0;
static size_t             s_preroll_snapshot_detection = 0;
static bool               s_preroll_snapshot_ready = false;

/* WakeNet9 lazily allocates its internal MFCC convolution queues on the first
 * detect() call.  Calling clean() on a freshly-created model (before any
 * detect() has run) dereferences those uninitialized NULL queue pointers and
 * panics.  Track whether detect() has ever been called so we can skip the
 * pre-loop clean() on the very first task run. */
static bool s_detect_initialized = false;

/* Stream buffer that shuttles PCM frames from the preconnect capture task
 * (producer, via the tap callback) to the wake-word detection task
 * (consumer). Sized for ~200 ms of headroom so brief detection stalls don't
 * drop audio. */
#define WAKE_WORD_STREAM_BUFFER_BYTES   (PREROLL_SAMPLE_RATE * 2 * 200 / 1000)
static StreamBufferHandle_t s_pcm_stream = NULL;

static void wake_word_tap_cb(const int16_t *mono_pcm, size_t sample_count, void *ctx)
{
    (void)ctx;
    if (s_pcm_stream == NULL || mono_pcm == NULL || sample_count == 0) {
        return;
    }
    /* Non-blocking send. If the stream buffer is full, drop — the consumer
     * will recover on the next frame. Dropping is vastly preferable to
     * blocking the capture task, which also feeds LiveKit. */
    xStreamBufferSend(s_pcm_stream, mono_pcm, sample_count * sizeof(int16_t), 0);
}

static bool ensure_preroll_buffers(void)
{
    if (s_preroll_ring != NULL && s_preroll_snapshot != NULL) {
        return true;
    }

    if (s_preroll_ring == NULL) {
        s_preroll_ring = heap_caps_malloc(
            PREROLL_RING_CAPACITY_SAMPLES * sizeof(int16_t),
            MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    }
    if (s_preroll_snapshot == NULL) {
        s_preroll_snapshot = heap_caps_malloc(
            PREROLL_RING_CAPACITY_SAMPLES * sizeof(int16_t),
            MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    }

    if (s_preroll_ring == NULL || s_preroll_snapshot == NULL) {
        ESP_LOGE(TAG, "Failed to allocate preroll buffers");
        return false;
    }
    return true;
}

static void reset_preroll_state(void)
{
    s_preroll_ring_head = 0;
    s_preroll_ring_count = 0;
    s_post_detect_samples = 0;
    s_detection_pending_stop = false;
    s_preroll_snapshot_start = 0;
    s_preroll_snapshot_count = 0;
    s_preroll_snapshot_wake_start = 0;
    s_preroll_snapshot_detection = 0;
    s_preroll_snapshot_ready = false;
}

static void preroll_ring_write(const int16_t *samples, size_t sample_count)
{
    if (s_preroll_ring == NULL || samples == NULL || sample_count == 0) {
        return;
    }

    if (sample_count >= PREROLL_RING_CAPACITY_SAMPLES) {
        samples += sample_count - PREROLL_RING_CAPACITY_SAMPLES;
        sample_count = PREROLL_RING_CAPACITY_SAMPLES;
        s_preroll_ring_head = 0;
        s_preroll_ring_count = 0;
    }

    for (size_t i = 0; i < sample_count; ++i) {
        s_preroll_ring[s_preroll_ring_head] = samples[i];
        s_preroll_ring_head = (s_preroll_ring_head + 1) % PREROLL_RING_CAPACITY_SAMPLES;
        if (s_preroll_ring_count < PREROLL_RING_CAPACITY_SAMPLES) {
            s_preroll_ring_count++;
        }
    }
}

static void finalize_preroll_snapshot(void)
{
    if (s_preroll_ring == NULL || s_preroll_snapshot == NULL || s_preroll_ring_count == 0) {
        s_preroll_snapshot_ready = false;
        return;
    }

    const size_t snapshot_samples = s_preroll_ring_count;
    const size_t ring_start =
        (s_preroll_ring_head + PREROLL_RING_CAPACITY_SAMPLES - s_preroll_ring_count) % PREROLL_RING_CAPACITY_SAMPLES;
    for (size_t i = 0; i < snapshot_samples; ++i) {
        s_preroll_snapshot[i] = s_preroll_ring[(ring_start + i) % PREROLL_RING_CAPACITY_SAMPLES];
    }

    size_t detection_index = 0;
    if (s_post_detect_samples < snapshot_samples) {
        detection_index = snapshot_samples - s_post_detect_samples;
    }

    size_t wake_start_index = 0;
    if ((size_t)s_last_start_point_samples < detection_index) {
        wake_start_index = detection_index - (size_t)s_last_start_point_samples;
    }

    size_t capture_start_index = 0;
    if (wake_start_index > PREROLL_CONTEXT_LEAD_SAMPLES) {
        capture_start_index = wake_start_index - PREROLL_CONTEXT_LEAD_SAMPLES;
    }

    s_preroll_snapshot_start = capture_start_index;
    s_preroll_snapshot_count = snapshot_samples - capture_start_index;
    s_preroll_snapshot_wake_start = wake_start_index - capture_start_index;
    s_preroll_snapshot_detection = detection_index - capture_start_index;
    s_preroll_snapshot_ready = s_preroll_snapshot_count > 0;

    ESP_LOGW(
        TAG,
        "[PREROLL] samples=%u wake_start=%u detected=%u post_detect=%u",
        (unsigned)s_preroll_snapshot_count,
        (unsigned)s_preroll_snapshot_wake_start,
        (unsigned)s_preroll_snapshot_detection,
        (unsigned)s_post_detect_samples);
}

/* ---- Detection task ---- */

static void wake_word_task(void *arg)
{
    ESP_LOGI(TAG, "Task started (chunk=%d samples, %d ms)", s_chunk, s_chunk / 16);

    if (!ensure_preroll_buffers()) {
        s_task = NULL;
        vTaskDelete(NULL);
        return;
    }

    if (s_pcm_stream == NULL) {
        s_pcm_stream = xStreamBufferCreate(WAKE_WORD_STREAM_BUFFER_BYTES,
                                           /* trigger level */ s_chunk * sizeof(int16_t));
        if (s_pcm_stream == NULL) {
            ESP_LOGE(TAG, "Failed to allocate PCM stream buffer");
            s_task = NULL;
            vTaskDelete(NULL);
            return;
        }
    } else {
        xStreamBufferReset(s_pcm_stream);
    }

    /* Register the tap now that the stream buffer is ready. The preconnect
     * capture task will start pushing frames as soon as LiveKit is running
     * (or immediately, if a persistent capture is already active). */
    if (mitr_preconnect_audio_src_register_tap(wake_word_tap_cb, NULL) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to register wake-word tap");
        s_task = NULL;
        vTaskDelete(NULL);
        return;
    }

    /* Allocate in internal RAM — faster than PSRAM for inference math. */
    int16_t *buf = heap_caps_malloc(s_chunk * sizeof(int16_t),
                                    MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!buf) {
        ESP_LOGE(TAG, "Audio buffer alloc failed");
        mitr_preconnect_audio_src_unregister_tap(wake_word_tap_cb, NULL);
        s_task = NULL;
        vTaskDelete(NULL);
        return;
    }

    /* Flush stale MFCC state from a previous detection cycle.
     * IMPORTANT: skip on the very first task run (s_detect_initialized == false)
     * because WakeNet9 allocates its internal convolution queues lazily on the
     * first detect() call — calling clean() before that dereferences NULL queue
     * pointers and panics with EXCVADDR=0x10. */
    if (s_detect_initialized) {
        s_wakenet->clean(s_model);
    }

    const size_t chunk_bytes = (size_t)s_chunk * sizeof(int16_t);

    while (!s_stop) {
        /* Read exactly s_chunk samples (blocking up to 100 ms so we can
         * periodically check s_stop). */
        size_t received = xStreamBufferReceive(s_pcm_stream, buf, chunk_bytes,
                                               pdMS_TO_TICKS(100));
        if (received != chunk_bytes) {
            /* Partial or timeout — either no audio is flowing yet (LiveKit
             * capture not started) or we were asked to stop. Zero out and
             * keep looping so s_stop is checked promptly. */
            continue;
        }

        preroll_ring_write(buf, (size_t)s_chunk);

        if (s_detection_pending_stop) {
            s_post_detect_samples += (size_t)s_chunk;
            continue;
        }

        s_detect_initialized = true;   /* queues now allocated; clean() safe from here */
        wakenet_state_t state = s_wakenet->detect(s_model, buf);

        if (state == WAKENET_DETECTED) {
            s_last_detected_at_ms = esp_timer_get_time() / 1000;
            s_last_start_point_samples = s_wakenet->get_start_point(s_model);
            s_detection_pending_stop = true;
            s_post_detect_samples = 0;
            ESP_LOGI(TAG, "*** WAKE WORD DETECTED *** start_point=%d samples",
                     s_last_start_point_samples);

            if (s_eg) {
                xEventGroupSetBits(s_eg, s_detect_bit);
            }
        }
        /* WAKENET_NO_DETECT: normal — keep looping */
    }

    finalize_preroll_snapshot();
    mitr_preconnect_audio_src_unregister_tap(wake_word_tap_cb, NULL);
    free(buf);
    ESP_LOGI(TAG, "Task exiting cleanly");
    s_task = NULL;
    vTaskDelete(NULL);
}

/* ---- Public API ---- */

int wake_word_init(void)
{
    if (!ensure_preroll_buffers()) {
        return -1;
    }

    /* Load model index from the "model" flash partition.
     * Model weights are flash-mmap'd on IDF v5+ — not copied to RAM. */
    srmodel_list_t *models = esp_srmodel_init("model");
    if (!models) {
        ESP_LOGE(TAG, "esp_srmodel_init failed — check:"
                 " (1) partition named \"model\" in partitions.csv,"
                 " (2) CONFIG_MODEL_IN_FLASH_EN=y,"
                 " (3) model binary flashed");
        return -1;
    }

    ESP_LOGI(TAG, "Found %d model(s) in flash:", models->num);
    for (int i = 0; i < models->num; i++) {
        ESP_LOGI(TAG, "  [%d] %s", i, models->model_name[i]);
    }

    /* Filter: case-insensitive substring match on ESP_WN_PREFIX ("wn") AND
     * CONFIG_MITR_WAKEWORD_MODEL (e.g. "hiesp" matches "wn9_hiesp").
     * esp_srmodel_filter returns NULL — never a fallback — when no match. */
    char *model_name = esp_srmodel_filter(models, ESP_WN_PREFIX,
                                          CONFIG_MITR_WAKEWORD_MODEL);
    if (!model_name) {
        ESP_LOGW(TAG, "No model matching \"%s\" found — falling back to first WakeNet model",
                 CONFIG_MITR_WAKEWORD_MODEL);
        model_name = esp_srmodel_filter(models, ESP_WN_PREFIX, NULL);
    }
    if (!model_name) {
        ESP_LOGE(TAG, "No WakeNet model found in flash partition");
        esp_srmodel_deinit(models);
        return -1;
    }

    ESP_LOGI(TAG, "Using model: %s  (wake word: %s)",
             model_name, esp_wn_wakeword_from_name(model_name));

    /* Get the vtable — parses the "wn9_" prefix to select the right prebuilt
     * implementation from libwakenet.a. Returns NULL if CONFIG_SR_WN_WN9_*
     * Kconfig doesn't match the model name. */
    s_wakenet = esp_wn_handle_from_name(model_name);
    if (!s_wakenet) {
        ESP_LOGE(TAG, "esp_wn_handle_from_name() returned NULL —"
                 " ensure CONFIG_SR_WN_WN9_* matches the model in flash");
        esp_srmodel_deinit(models);
        return -1;
    }

    /* Create model instance.
     * DET_MODE_95: ~95% recall, some false alarms — correct for a voice assistant.
     * libwakenet.a uses psram_first=true internally; PSRAM must be initialised. */
    s_model = s_wakenet->create(model_name, DET_MODE_95);
    if (!s_model) {
        ESP_LOGE(TAG, "wakenet->create() failed —"
                 " check PSRAM is enabled (CONFIG_SPIRAM=y) and initialised");
        esp_srmodel_deinit(models);
        return -1;
    }

    /* Always query chunk size at runtime — never hardcode 480 */
    s_chunk = s_wakenet->get_samp_chunksize(s_model);

    ESP_LOGI(TAG, "WakeNet init OK: chunk=%d samples (%d ms), rate=%d Hz, channels=%d",
             s_chunk, s_chunk / 16,
             s_wakenet->get_samp_rate(s_model),
             s_wakenet->get_channel_num(s_model));

    for (int i = 1; i <= s_wakenet->get_word_num(s_model); i++) {
        ESP_LOGI(TAG, "  word[%d]: \"%s\"  threshold=%.3f",
                 i,
                 s_wakenet->get_word_name(s_model, i),
                 s_wakenet->get_det_threshold(s_model, i));
    }

    /* Keep models alive — it owns the flash mmap handle.
     * Calling esp_srmodel_deinit() here would unmap the flash region the model
     * reads from during inference. */

    return 0;
}

void wake_word_start(EventGroupHandle_t eg, EventBits_t bit)
{
    if (!s_model) {
        ESP_LOGE(TAG, "wake_word_init() not called or failed");
        return;
    }
    if (s_task) {
        ESP_LOGW(TAG, "Detection task already running");
        return;
    }

    s_eg         = eg;
    s_detect_bit = bit;
    s_stop       = false;
    reset_preroll_state();

    BaseType_t ret = xTaskCreatePinnedToCore(
        wake_word_task, "wake_word",
        8192,           /* 8 KB — WakeNet9 detect() uses ~4 KB for MFCC computation */
        NULL,
        4,              /* priority */
        &s_task,
        tskNO_AFFINITY);

    if (ret != pdPASS) {
        ESP_LOGE(TAG, "xTaskCreatePinnedToCore failed");
        s_task = NULL;
    } else {
        ESP_LOGI(TAG, "Detection task started");
    }
}

void wake_word_stop(void)
{
    if (!s_task) return;

    s_stop = true;

    /* Wait up to 2 s for graceful exit */
    for (int i = 0; i < 200 && s_task != NULL; i++) {
        vTaskDelay(pdMS_TO_TICKS(10));
    }

    if (s_task) {
        ESP_LOGW(TAG, "Task did not exit in 2 s — force-deleting");
        vTaskDelete(s_task);
        s_task = NULL;
    }

    ESP_LOGI(TAG, "Detection task stopped");
}

void wake_word_rearm(void)
{
    if (!s_model) {
        return;
    }
    /* Flush MFCC history so we don't re-detect residual audio from the turn
     * that just ended. clean() is only safe once detect() has been called at
     * least once — s_detect_initialized gates that. */
    if (s_detect_initialized) {
        s_wakenet->clean(s_model);
    }
    s_post_detect_samples = 0;
    s_detection_pending_stop = false;
}

int64_t wake_word_last_detected_at_ms(void)
{
    return s_last_detected_at_ms;
}

int wake_word_last_start_point_samples(void)
{
    return s_last_start_point_samples;
}

bool wake_word_take_preroll(wake_word_preroll_t *out)
{
    if (out == NULL) {
        return false;
    }
    memset(out, 0, sizeof(*out));
    if (!s_preroll_snapshot_ready || s_preroll_snapshot == NULL) {
        return false;
    }

    out->pcm = s_preroll_snapshot + s_preroll_snapshot_start;
    out->sample_count = s_preroll_snapshot_count;
    out->wake_start_sample_index = s_preroll_snapshot_wake_start;
    out->detection_sample_index = s_preroll_snapshot_detection;
    out->detected_at_ms = s_last_detected_at_ms;
    return true;
}
