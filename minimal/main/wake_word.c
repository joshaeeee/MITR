#include "wake_word.h"
#include "latency_trace.h"
#include "preconnect_audio_src.h"

#include "esp_wn_iface.h"
#include "esp_wn_models.h"
#include "model_path.h"

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include <string.h>

static const char *TAG = "wake_word";
static const char *UNKNOWN_WAKE_WORD = "wake_detected";
static const size_t WAKE_WORD_STREAM_BUFFER_BYTES = 16000 * 2 * 200 / 1000;

static const esp_wn_iface_t *s_wakenet  = NULL;
static model_iface_data_t   *s_model    = NULL;
static int                   s_chunk    = 0;
static char                  s_model_name[64];
static char                  s_phrase[128];
static StreamBufferHandle_t  s_pcm_stream = NULL;

static TaskHandle_t       s_task       = NULL;
static volatile bool      s_stop       = false;
static EventGroupHandle_t s_eg         = NULL;
static EventBits_t        s_detect_bit = 0;
static bool               s_detection_pending_stop = false;
static volatile bool      s_rearm_requested = false;

static bool reset_wakenet_model(void)
{
    if (!s_wakenet) {
        return false;
    }

    if (s_model != NULL && s_wakenet->destroy != NULL) {
        s_wakenet->destroy(s_model);
        s_model = NULL;
    }

    const char *model_name = s_model_name[0] != '\0' ? s_model_name : NULL;
    s_model = s_wakenet->create(model_name, DET_MODE_95);
    if (s_model == NULL) {
        ESP_LOGE(TAG, "Failed to recreate WakeNet model");
        s_detection_pending_stop = true;
        return false;
    }

    s_chunk = s_wakenet->get_samp_chunksize(s_model);
    s_detection_pending_stop = false;
    return true;
}

static void apply_rearm_if_requested(void)
{
    if (!s_rearm_requested || !s_model) {
        return;
    }
    reset_wakenet_model();
    s_rearm_requested = false;
}

static void cache_loaded_wakeword_metadata(const char *model_name)
{
    strlcpy(s_model_name, model_name ? model_name : "", sizeof(s_model_name));
    s_phrase[0] = '\0';

    if (s_wakenet && s_model) {
        const int word_count = s_wakenet->get_word_num(s_model);
        for (int i = 1; i <= word_count; i++) {
            const char *word_name = s_wakenet->get_word_name(s_model, i);
            if (!word_name || word_name[0] == '\0') {
                continue;
            }
            if (s_phrase[0] != '\0') {
                strlcat(s_phrase, "; ", sizeof(s_phrase));
            }
            strlcat(s_phrase, word_name, sizeof(s_phrase));
        }
    }

    if (s_phrase[0] == '\0') {
        const char *fallback = model_name ? esp_wn_wakeword_from_name(model_name) : NULL;
        strlcpy(s_phrase, (fallback && fallback[0] != '\0') ? fallback : UNKNOWN_WAKE_WORD, sizeof(s_phrase));
    }
}

static void wake_word_tap_cb(const int16_t *mono_pcm, size_t sample_count, void *ctx)
{
    (void)ctx;
    if (s_pcm_stream == NULL || mono_pcm == NULL || sample_count == 0) {
        return;
    }
    xStreamBufferSend(s_pcm_stream, mono_pcm, sample_count * sizeof(int16_t), 0);
}

static void wake_word_task(void *arg)
{
    ESP_LOGI(TAG, "Wake word task started (chunk=%d samples, %d ms)",
             s_chunk, s_chunk / 16);
    mitr_latency_mark("wake_service_started");

    if (s_pcm_stream == NULL) {
        s_pcm_stream = xStreamBufferCreate(WAKE_WORD_STREAM_BUFFER_BYTES, s_chunk * sizeof(int16_t));
        if (s_pcm_stream == NULL) {
            ESP_LOGE(TAG, "Failed to allocate PCM stream buffer");
            s_task = NULL;
            vTaskDelete(NULL);
            return;
        }
    } else {
        xStreamBufferReset(s_pcm_stream);
    }

    if (mitr_preconnect_audio_src_register_tap(wake_word_tap_cb, NULL) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to register wake-word tap");
        s_task = NULL;
        vTaskDelete(NULL);
        return;
    }

    int16_t *buf = heap_caps_malloc((size_t)(s_chunk * (int)sizeof(int16_t)),
                                    MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!buf) {
        ESP_LOGE(TAG, "Audio buffer alloc failed");
        mitr_preconnect_audio_src_unregister_tap(wake_word_tap_cb, NULL);
        s_task = NULL;
        vTaskDelete(NULL);
        return;
    }

    const size_t chunk_bytes = (size_t)s_chunk * sizeof(int16_t);

    while (!s_stop) {
        size_t received = xStreamBufferReceive(s_pcm_stream, buf, chunk_bytes, pdMS_TO_TICKS(100));
        apply_rearm_if_requested();
        if (received != chunk_bytes) {
            continue;
        }

        if (s_detection_pending_stop) {
            continue;
        }

        wakenet_state_t state = s_wakenet->detect(s_model, buf);

        if (state == WAKENET_DETECTED) {
            ESP_LOGI(TAG, "*** WAKE WORD DETECTED *** start_point=%d",
                     s_wakenet->get_start_point(s_model));
            mitr_latency_mark("wake_detected");
            s_detection_pending_stop = true;

            if (s_eg) {
                xEventGroupSetBits(s_eg, s_detect_bit);
            }
        }
    }

    mitr_preconnect_audio_src_unregister_tap(wake_word_tap_cb, NULL);
    free(buf);
    ESP_LOGI(TAG, "Wake word task exiting cleanly");
    s_task = NULL;
    vTaskDelete(NULL);
}

int wake_word_init(void)
{
    srmodel_list_t *models = esp_srmodel_init("model");
    if (!models) {
        ESP_LOGE(TAG, "esp_srmodel_init failed — check partition table and CONFIG_MODEL_IN_FLASH_EN");
        return -1;
    }

    ESP_LOGI(TAG, "Found %d model(s) in flash:", models->num);
    for (int i = 0; i < models->num; i++) {
        ESP_LOGI(TAG, "  [%d] %s", i, models->model_name[i]);
    }

    char *model_name = esp_srmodel_filter(models, ESP_WN_PREFIX, CONFIG_MITR_WAKEWORD_MODEL);
    if (!model_name) {
        ESP_LOGW(TAG, "Model '%s' not found, using first available WakeNet model",
                 CONFIG_MITR_WAKEWORD_MODEL);
        model_name = esp_srmodel_filter(models, ESP_WN_PREFIX, NULL);
    }
    if (!model_name) {
        ESP_LOGE(TAG, "No WakeNet model found in flash partition");
        esp_srmodel_deinit(models);
        return -1;
    }

    ESP_LOGI(TAG, "Using model: %s  wake word: %s",
             model_name, esp_wn_wakeword_from_name(model_name));

    s_wakenet = esp_wn_handle_from_name(model_name);
    if (!s_wakenet) {
        ESP_LOGE(TAG, "esp_wn_handle_from_name() returned NULL — "
                 "does CONFIG_SR_WN_WN9_* match the model in flash?");
        esp_srmodel_deinit(models);
        return -1;
    }

    s_model = s_wakenet->create(model_name, DET_MODE_95);
    if (!s_model) {
        ESP_LOGE(TAG, "wakenet->create() failed — check PSRAM availability");
        esp_srmodel_deinit(models);
        return -1;
    }

    s_chunk = s_wakenet->get_samp_chunksize(s_model);
    cache_loaded_wakeword_metadata(model_name);

    ESP_LOGI(TAG, "WakeNet init OK: chunk=%d samples (%d ms), rate=%d Hz, channels=%d",
             s_chunk, s_chunk / 16,
             s_wakenet->get_samp_rate(s_model),
             s_wakenet->get_channel_num(s_model));

    for (int i = 1; i <= s_wakenet->get_word_num(s_model); i++) {
        ESP_LOGI(TAG, "  word[%d]: %s (threshold=%.3f)",
                 i,
                 s_wakenet->get_word_name(s_model, i),
                 s_wakenet->get_det_threshold(s_model, i));
    }

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
        4096, NULL,
        5, &s_task,
        tskNO_AFFINITY);

    if (ret != pdPASS) {
        ESP_LOGE(TAG, "Failed to create wake word task");
        s_task = NULL;
    }
}

void wake_word_stop(void)
{
    if (!s_task) {
        return;
    }
    s_stop = true;
    const TickType_t deadline = xTaskGetTickCount() + pdMS_TO_TICKS(2000);
    while (s_task && xTaskGetTickCount() < deadline) {
        vTaskDelay(pdMS_TO_TICKS(20));
    }
    if (s_task) {
        ESP_LOGW(TAG, "Wake word task did not exit in time; deleting forcibly");
        vTaskDelete(s_task);
        s_task = NULL;
        mitr_preconnect_audio_src_unregister_tap(wake_word_tap_cb, NULL);
    }
}

void wake_word_rearm(void)
{
    if (!s_model) {
        return;
    }
    if (s_task != NULL) {
        s_rearm_requested = true;
        return;
    }
    reset_wakenet_model();
}

const char *wake_word_model_name(void)
{
    return s_model_name[0] != '\0' ? s_model_name : NULL;
}

const char *wake_word_phrase(void)
{
    return s_phrase[0] != '\0' ? s_phrase : UNKNOWN_WAKE_WORD;
}
