#include "wake_word.h"
#include "media.h"

#include "esp_wn_iface.h"
#include "esp_wn_models.h"
#include "model_path.h"

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "sdkconfig.h"

static const char *TAG = "wake_word";

static const esp_wn_iface_t *s_wakenet  = NULL;
static model_iface_data_t   *s_model    = NULL;
static int                   s_chunk    = 0;

static TaskHandle_t       s_task       = NULL;
static volatile bool      s_stop       = false;
static EventGroupHandle_t s_eg         = NULL;
static EventBits_t        s_detect_bit = 0;

static void wake_word_task(void *arg)
{
    ESP_LOGI(TAG, "Wake word task started (chunk=%d samples, %d ms)",
             s_chunk, s_chunk / 16);

    if (media_start_raw_mic() != 0) {
        ESP_LOGE(TAG, "Failed to open mic tap");
        s_task = NULL;
        vTaskDelete(NULL);
        return;
    }

    int16_t *buf = heap_caps_malloc((size_t)(s_chunk * (int)sizeof(int16_t)),
                                    MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!buf) {
        ESP_LOGE(TAG, "Audio buffer alloc failed");
        media_stop_raw_mic();
        s_task = NULL;
        vTaskDelete(NULL);
        return;
    }

    while (!s_stop) {
        if (media_read_mic_raw(buf, s_chunk) != 0) {
            vTaskDelay(pdMS_TO_TICKS(5));
            continue;
        }

        wakenet_state_t state = s_wakenet->detect(s_model, buf);

        if (state == WAKENET_DETECTED) {
            ESP_LOGI(TAG, "*** WAKE WORD DETECTED *** start_point=%d",
                     s_wakenet->get_start_point(s_model));

            media_stop_raw_mic();

            if (s_eg) {
                xEventGroupSetBits(s_eg, s_detect_bit);
            }

            free(buf);
            s_task = NULL;
            vTaskDelete(NULL);
            return;
        }
    }

    media_stop_raw_mic();
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
        media_stop_raw_mic();
    }
}

void wake_word_rearm(void)
{
    if (!s_model) {
        return;
    }
    wake_word_stop();
    s_wakenet->clean(s_model);
    wake_word_start(s_eg, s_detect_bit);
}
