/*
 * Wake word detection using the microWakeWord streaming quantized TFLite model.
 *
 * Audio preprocessing uses the TFLM microfrontend (PCAN + noise reduction +
 * log-mel) — the same pipeline used during model training.  Do NOT replace
 * with a custom mel implementation.
 *
 * Inference runs every 30 ms (3 × 10 ms frames, stride=3 matches training).
 * Detection is signalled via a FreeRTOS event group bit.
 *
 * Reference: ESPHome micro_wake_word component, kahrendt/microwakeword
 */

#include "wake_word.h"
#include "audio_preprocessor.h"
#include "wake_model_data.h"
#include "media.h"

#include "esp_log.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"

#include <string.h>

/* TFLite Micro */
#include "tensorflow/lite/micro/micro_interpreter.h"
#include "tensorflow/lite/micro/micro_mutable_op_resolver.h"
#include "tensorflow/lite/micro/micro_allocator.h"
#include "tensorflow/lite/micro/micro_resource_variable.h"
#include "tensorflow/lite/schema/schema_generated.h"

static const char *TAG = "wake_word";

/* ---- Detection tuning ---- */
/* Probability threshold (0–255). 200 ≈ 78%.  Lower if you miss detections,
 * raise if you get false positives. */
#define WAKE_PROB_THRESHOLD  200

/* Number of warmup frames to skip at startup so the streaming state
 * stabilises (100 × 10 ms = 1 second). */
#define WAKE_WARMUP_FRAMES   100

/* ---- TFLite Micro arena ---- */
/* 200 KB in PSRAM — generous for the 60 KB streaming model */
#define ARENA_SIZE (200 * 1024)
static uint8_t *s_arena = nullptr;

/* ---- TFLite objects ---- */
static const tflite::Model      *s_model       = nullptr;
static tflite::MicroInterpreter *s_interpreter = nullptr;
static TfLiteTensor             *s_input       = nullptr;
static TfLiteTensor             *s_output      = nullptr;

/* ---- Task state ---- */
static TaskHandle_t       s_task       = nullptr;
static volatile bool      s_stop       = false;
static EventGroupHandle_t s_eg         = nullptr;
static EventBits_t        s_detect_bit = 0;

/* ---- Op resolver — exact ops for stream_state_internal_quant.tflite ----
 * Determined by parsing the model flatbuffer (13 ops).
 */
static tflite::MicroMutableOpResolver<13> s_resolver;
static bool s_ops_registered = false;

static void register_ops(void)
{
    if (s_ops_registered) return;
    s_resolver.AddCallOnce();
    s_resolver.AddVarHandle();
    s_resolver.AddReshape();
    s_resolver.AddReadVariable();
    s_resolver.AddConcatenation();
    s_resolver.AddStridedSlice();
    s_resolver.AddAssignVariable();
    s_resolver.AddConv2D();
    s_resolver.AddDepthwiseConv2D();
    s_resolver.AddSplitV();
    s_resolver.AddFullyConnected();
    s_resolver.AddLogistic();
    s_resolver.AddQuantize();
    s_ops_registered = true;
}

/* ---- Detection task ---- */

static void wake_word_task(void *arg)
{
    ESP_LOGI(TAG, "[WWD] Task started — listening for wake word");

    if (media_start_raw_mic() != 0) {
        ESP_LOGE(TAG, "[WWD] Failed to open raw mic; task exiting");
        s_task = nullptr;
        vTaskDelete(nullptr);
        return;
    }

    int16_t pcm[AUDIO_HOP_SAMPLES];
    int8_t  features[AUDIO_NUM_FEATURES];

    /* stride_step: counts 0, 1, 2 — only invoke after 3 frames */
    int stride_step = 0;

    /* Warmup: skip first WAKE_WARMUP_FRAMES frontend outputs so the
     * streaming model's ring-buffer state settles */
    int warmup = 0;

    bool     detected  = false;
    uint32_t n_invokes = 0;

    /* Input tensor dims: [1, 3, 40] = 120 bytes int8.
     * We fill it slice by slice: offset 0, 40, 80. */
    int stride = s_input->dims->data[1];  /* should be 3 */
    ESP_LOGI(TAG, "[WWD] Input stride=%d (expecting 3)", stride);

    while (!s_stop) {
        /* 1. Read 160 mono samples (10 ms) */
        if (media_read_mic_raw(pcm, AUDIO_HOP_SAMPLES) != 0) {
            ESP_LOGW(TAG, "[WWD] Mic read error; retrying");
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }

        /* 2. Run microfrontend → 40 int8 features */
        if (!audio_preprocessor_compute(pcm, features)) {
            continue;  /* frontend buffering (only on very first call) */
        }

        /* 3. Warmup: let streaming state stabilise */
        if (warmup < WAKE_WARMUP_FRAMES) {
            warmup++;
            continue;
        }

        /* 4. Copy 40-feature slice into input tensor at current stride slot */
        int8_t *dst = s_input->data.int8 + stride_step * AUDIO_NUM_FEATURES;
        memcpy(dst, features, AUDIO_NUM_FEATURES * sizeof(int8_t));
        stride_step++;

        /* 5. Only invoke after all 3 stride slots are filled (every 30 ms) */
        if (stride_step < stride) {
            continue;
        }
        stride_step = 0;

        /* 6. Run inference */
        TfLiteStatus status = s_interpreter->Invoke();
        if (status != kTfLiteOk) {
            ESP_LOGW(TAG, "[WWD] Invoke() failed");
            continue;
        }

        /* 7. Read output — single uint8 value (0=silence, 255=wake word) */
        uint8_t prob = s_output->data.uint8[0];
        n_invokes++;

        /* Periodic log every ~5 s (5000 ms / 30 ms per invoke ≈ 167) */
        if (n_invokes % 167 == 0) {
            ESP_LOGI(TAG, "[WWD] prob=%u/255  threshold=%u  invokes=%lu",
                     (unsigned)prob, (unsigned)WAKE_PROB_THRESHOLD,
                     (unsigned long)n_invokes);
        }

        /* 8. Detection */
        if (!detected && prob >= WAKE_PROB_THRESHOLD) {
            detected = true;
            ESP_LOGI(TAG, "[WWD] *** WAKE WORD DETECTED *** prob=%u/255", (unsigned)prob);
            media_stop_raw_mic();
            if (s_eg) {
                xEventGroupSetBits(s_eg, s_detect_bit);
            }
            /* Park here until wake_word_stop() is called by the state machine */
            while (!s_stop) {
                vTaskDelay(pdMS_TO_TICKS(50));
            }
            break;
        }
    }

    if (!detected) {
        media_stop_raw_mic();
    }

    ESP_LOGI(TAG, "[WWD] Task exiting");
    s_task = nullptr;
    vTaskDelete(nullptr);
}

/* ---- Public API ---- */

extern "C" int wake_word_init(void)
{
    /* Allocate tensor arena in PSRAM */
    s_arena = (uint8_t *)heap_caps_malloc(ARENA_SIZE,
                                          MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_arena) {
        ESP_LOGE(TAG, "Failed to allocate %d-byte TFLite arena in PSRAM", ARENA_SIZE);
        return -1;
    }

    /* Load model */
    s_model = tflite::GetModel(stream_state_internal_quant_tflite);
    if (s_model->version() != TFLITE_SCHEMA_VERSION) {
        ESP_LOGE(TAG, "TFLite schema mismatch: model=%lu expected=%d",
                 (unsigned long)s_model->version(), TFLITE_SCHEMA_VERSION);
        return -1;
    }

    register_ops();

    /* Create allocator + resource variables.
     * Resource variables are required for the streaming model's stateful ops
     * (VarHandle / AssignVariable / ReadVariable) that hold ring-buffer state. */
    tflite::MicroAllocator *allocator =
        tflite::MicroAllocator::Create(s_arena, ARENA_SIZE);
    if (!allocator) {
        ESP_LOGE(TAG, "MicroAllocator::Create() failed");
        return -1;
    }

    tflite::MicroResourceVariables *resource_vars =
        tflite::MicroResourceVariables::Create(allocator, 20);
    if (!resource_vars) {
        ESP_LOGE(TAG, "MicroResourceVariables::Create() failed");
        return -1;
    }

    s_interpreter = new tflite::MicroInterpreter(
        s_model, s_resolver, allocator, resource_vars);

    if (s_interpreter->AllocateTensors() != kTfLiteOk) {
        ESP_LOGE(TAG, "AllocateTensors() failed");
        return -1;
    }

    s_input  = s_interpreter->input(0);
    s_output = s_interpreter->output(0);

    ESP_LOGI(TAG, "[WWD] Model loaded OK: input[%u bytes dims=%d×%d×%d type=%d] output[%u bytes type=%d]",
             (unsigned)s_input->bytes,
             s_input->dims->data[0], s_input->dims->data[1], s_input->dims->data[2],
             (int)s_input->type,
             (unsigned)s_output->bytes, (int)s_output->type);

    /* Initialise TFLM microfrontend */
    audio_preprocessor_init();

    return 0;
}

extern "C" void wake_word_start(EventGroupHandle_t eg, EventBits_t bit)
{
    if (s_input == nullptr) {
        ESP_LOGE(TAG, "wake_word_init() failed or not called — skipping");
        return;
    }

    s_eg         = eg;
    s_detect_bit = bit;
    s_stop       = false;

    BaseType_t ret = xTaskCreatePinnedToCore(
        wake_word_task,
        "wake_word",
        8192,
        nullptr,
        4,
        &s_task,
        tskNO_AFFINITY);

    if (ret != pdPASS) {
        ESP_LOGE(TAG, "Failed to create wake_word task");
        s_task = nullptr;
    } else {
        ESP_LOGI(TAG, "[WWD] Detection task started (threshold=%u/255, warmup=%d frames)",
                 (unsigned)WAKE_PROB_THRESHOLD, WAKE_WARMUP_FRAMES);
    }
}

extern "C" void wake_word_stop(void)
{
    if (s_task == nullptr) return;
    s_stop = true;
    for (int i = 0; i < 200 && s_task != nullptr; i++) {
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    if (s_task != nullptr) {
        ESP_LOGW(TAG, "[WWD] Task did not exit in time — force-deleting");
        vTaskDelete(s_task);
        s_task = nullptr;
    }
    ESP_LOGI(TAG, "[WWD] Detection task stopped");
}
