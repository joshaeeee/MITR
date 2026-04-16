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
#include "media.h"       /* media_start_raw_mic(), media_read_mic_raw(), media_stop_raw_mic() */

#include "esp_wn_iface.h"
#include "esp_wn_models.h"
#include "model_path.h"

#include "esp_log.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"

static const char *TAG = "wake_word";

/* ---- Module state ---- */
static const esp_wn_iface_t *s_wakenet    = NULL;
static model_iface_data_t   *s_model      = NULL;
static int                   s_chunk      = 0;   /* samples per detect() call */

static TaskHandle_t       s_task       = NULL;
static volatile bool      s_stop       = false;
static EventGroupHandle_t s_eg         = NULL;
static EventBits_t        s_detect_bit = 0;

/* WakeNet9 lazily allocates its internal MFCC convolution queues on the first
 * detect() call.  Calling clean() on a freshly-created model (before any
 * detect() has run) dereferences those uninitialized NULL queue pointers and
 * panics.  Track whether detect() has ever been called so we can skip the
 * pre-loop clean() on the very first task run. */
static bool s_detect_initialized = false;

/* ---- Detection task ---- */

static void wake_word_task(void *arg)
{
    ESP_LOGI(TAG, "Task started (chunk=%d samples, %d ms)", s_chunk, s_chunk / 16);

    if (media_start_raw_mic() != 0) {
        ESP_LOGE(TAG, "Failed to open mic");
        s_task = NULL;
        vTaskDelete(NULL);
        return;
    }

    /* Allocate in internal RAM — faster than PSRAM for DMA-backed reads */
    int16_t *buf = heap_caps_malloc(s_chunk * sizeof(int16_t),
                                    MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!buf) {
        ESP_LOGE(TAG, "Audio buffer alloc failed");
        media_stop_raw_mic();
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

    while (!s_stop) {
        /* Read exactly s_chunk samples of 16 kHz mono int16 PCM */
        if (media_read_mic_raw(buf, s_chunk) != 0) {
            vTaskDelay(pdMS_TO_TICKS(5));
            continue;
        }

        s_detect_initialized = true;   /* queues now allocated; clean() safe from here */
        wakenet_state_t state = s_wakenet->detect(s_model, buf);

        if (state == WAKENET_DETECTED) {
            ESP_LOGI(TAG, "*** WAKE WORD DETECTED *** start_point=%d samples",
                     s_wakenet->get_start_point(s_model));

            media_stop_raw_mic();
            free(buf);

            if (s_eg) {
                xEventGroupSetBits(s_eg, s_detect_bit);
            }

            /* Park here until wake_word_stop() is called by the state machine */
            while (!s_stop) {
                vTaskDelay(pdMS_TO_TICKS(50));
            }

            s_task = NULL;
            vTaskDelete(NULL);
            return;
        }
        /* WAKENET_NO_DETECT: normal — keep looping */
    }

    media_stop_raw_mic();
    free(buf);
    ESP_LOGI(TAG, "Task exiting cleanly");
    s_task = NULL;
    vTaskDelete(NULL);
}

/* ---- Public API ---- */

int wake_word_init(void)
{
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
