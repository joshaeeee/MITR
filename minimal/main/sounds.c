#include "sounds.h"
#include "media.h"
#include <math.h>
#include <stdint.h>
#include <string.h>
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"

static const char *TAG = "sounds";

/* ---------------------------------------------------------------------------
 * Tone parameters
 * ---------------------------------------------------------------------------
 * Stereo 16-bit 16 kHz PCM to match the I2S renderer configuration.
 * Both channels carry the same mono signal.
 * --------------------------------------------------------------------------- */
#define SAMPLE_RATE     16000
#define CHIME_MS        200
#define BEEP_MS         150
#define PROV_TONE_MS    90
#define PROV_GAP_MS     50
#define CHIME_SAMPLES   (SAMPLE_RATE * CHIME_MS / 1000)  /* 3200 stereo samples */
#define BEEP_SAMPLES    (SAMPLE_RATE * BEEP_MS  / 1000)  /* 2400 stereo samples */
#define PROV_SAMPLES    (SAMPLE_RATE * PROV_TONE_MS / 1000)
#define READY_STREAM_CHUNK_SAMPLES 512

extern const uint8_t voice_connected_raw_start[] asm("_binary_voice_connected_raw_start");
extern const uint8_t voice_connected_raw_end[] asm("_binary_voice_connected_raw_end");
extern const uint8_t voice_disconnected_raw_start[] asm("_binary_voice_disconnected_raw_start");
extern const uint8_t voice_disconnected_raw_end[] asm("_binary_voice_disconnected_raw_end");

static int16_t *s_chime_buf = NULL;  /* [CHIME_SAMPLES * 2] stereo */
static int16_t *s_beep_buf  = NULL;  /* [BEEP_SAMPLES  * 2] stereo */
static int16_t *s_prov_buf  = NULL;  /* [PROV_SAMPLES * 2] stereo */
static int16_t *s_ready_chunk_buf = NULL;  /* small internal-RAM stream buffer */
static SemaphoreHandle_t s_sound_mutex = NULL;
static int s_connected_samples = 0;
static int s_disconnected_samples = 0;

/* Generate a linear-frequency-sweep (chirp) into a stereo buffer.
 * f_start, f_end: start and end frequency in Hz.
 * amplitude: peak amplitude (0–32000).
 * fade_ms: fade-in and fade-out duration in ms.                             */
static void gen_chirp(int16_t *buf, int n_samples, float f_start, float f_end,
                      float amplitude, int fade_ms)
{
    int fade_n = (SAMPLE_RATE * fade_ms) / 1000;
    float duration = (float)n_samples / SAMPLE_RATE;
    float phase = 0.0f;
    for (int i = 0; i < n_samples; i++) {
        float t    = (float)i / SAMPLE_RATE;
        float freq = f_start + (f_end - f_start) * t / duration;
        /* Instantaneous phase integral of a linear chirp */
        phase += 2.0f * (float)M_PI * freq / SAMPLE_RATE;
        float env = 1.0f;
        if (i < fade_n && fade_n > 0) {
            env = (float)i / fade_n;
        } else if (i >= n_samples - fade_n && fade_n > 0) {
            env = (float)(n_samples - 1 - i) / fade_n;
        }
        int16_t sample = (int16_t)(amplitude * env * sinf(phase));
        buf[i * 2]     = sample;  /* L */
        buf[i * 2 + 1] = sample;  /* R */
    }
}

void sounds_init(void)
{
    size_t connected_bytes = (size_t)(voice_connected_raw_end - voice_connected_raw_start);
    size_t disconnected_bytes = (size_t)(voice_disconnected_raw_end - voice_disconnected_raw_start);
    if (s_sound_mutex == NULL) {
        s_sound_mutex = xSemaphoreCreateMutex();
    }
    s_chime_buf = heap_caps_malloc(CHIME_SAMPLES * 2 * sizeof(int16_t),
                                   MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    s_beep_buf  = heap_caps_malloc(BEEP_SAMPLES  * 2 * sizeof(int16_t),
                                   MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    s_prov_buf  = heap_caps_malloc(PROV_SAMPLES * 2 * sizeof(int16_t),
                                   MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    s_ready_chunk_buf = heap_caps_malloc(
        READY_STREAM_CHUNK_SAMPLES * 2 * sizeof(int16_t),
        MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (connected_bytes > 0 && (connected_bytes % (2 * sizeof(int16_t))) == 0) {
        s_connected_samples = (int)(connected_bytes / (2 * sizeof(int16_t)));
    }
    if (disconnected_bytes > 0 && (disconnected_bytes % (2 * sizeof(int16_t))) == 0) {
        s_disconnected_samples = (int)(disconnected_bytes / (2 * sizeof(int16_t)));
    }
    if (!s_chime_buf || !s_beep_buf || !s_prov_buf) {
        ESP_LOGE(TAG, "PSRAM alloc failed for sound buffers");
        return;
    }
    if (!s_sound_mutex) {
        ESP_LOGW(TAG, "Sound mutex alloc failed; cues may overlap");
    }
    if (!s_ready_chunk_buf) {
        ESP_LOGW(TAG, "PCM stream buffer alloc failed; embedded cues disabled");
    }
    if (connected_bytes == 0 || (connected_bytes % (2 * sizeof(int16_t))) != 0) {
        ESP_LOGW(TAG, "Connected PCM asset is missing or malformed");
    }
    if (disconnected_bytes == 0 || (disconnected_bytes % (2 * sizeof(int16_t))) != 0) {
        ESP_LOGW(TAG, "Disconnected PCM asset is missing or malformed");
    }

    /* Rising chirp: 440 Hz → 880 Hz, 200 ms, 30 ms fade */
    gen_chirp(s_chime_buf, CHIME_SAMPLES, 440.0f, 880.0f, 28000.0f, 30);

    /* Falling chirp: 880 Hz → 440 Hz, 150 ms, 20 ms fade */
    gen_chirp(s_beep_buf, BEEP_SAMPLES, 880.0f, 440.0f, 22000.0f, 20);

    /* Provisioning cue: soft tone repeated twice by sounds_play_provisioning_wait() */
    gen_chirp(s_prov_buf, PROV_SAMPLES, 660.0f, 520.0f, 16000.0f, 15);

    ESP_LOGI(
        TAG,
        "Sounds init OK: chime=%d beep=%d provision=%d connected=%d disconnected=%d samples",
        CHIME_SAMPLES,
        BEEP_SAMPLES,
        PROV_SAMPLES,
        s_connected_samples,
        s_disconnected_samples);
}

static void lock_sound_output(void)
{
    if (s_sound_mutex != NULL) {
        (void)xSemaphoreTake(s_sound_mutex, portMAX_DELAY);
    }
}

static void unlock_sound_output(void)
{
    if (s_sound_mutex != NULL) {
        (void)xSemaphoreGive(s_sound_mutex);
    }
}

void sounds_play_chime(void)
{
    if (!s_chime_buf) {
        ESP_LOGW(TAG, "Chime buffer not initialized");
        return;
    }
    ESP_LOGI(TAG, "[SOUND] Playing wake chime");
    lock_sound_output();
    media_play_pcm(s_chime_buf, CHIME_SAMPLES);
    unlock_sound_output();
    /* Add a small silence gap so the gateway capture doesn't step on the tail. */
    vTaskDelay(pdMS_TO_TICKS(50));
}

void sounds_play_beep(void)
{
    if (!s_beep_buf) {
        ESP_LOGW(TAG, "Beep buffer not initialized");
        return;
    }
    ESP_LOGI(TAG, "[SOUND] Playing disconnect beep");
    lock_sound_output();
    media_play_pcm(s_beep_buf, BEEP_SAMPLES);
    unlock_sound_output();
    vTaskDelay(pdMS_TO_TICKS(50));
}

void sounds_play_ready(void)
{
    sounds_play_connected();
}

static void play_embedded_pcm_cue(const char *name, const uint8_t *start, int samples)
{
    if (!s_ready_chunk_buf || samples <= 0) {
        ESP_LOGW(TAG, "%s PCM cue unavailable", name);
        return;
    }
    ESP_LOGI(TAG, "[SOUND] Playing %s cue (%d stereo samples streamed)", name, samples);
    lock_sound_output();
    media_play_pcm_chunked((const int16_t *)start,
                           samples,
                           READY_STREAM_CHUNK_SAMPLES,
                           s_ready_chunk_buf);
    unlock_sound_output();
    vTaskDelay(pdMS_TO_TICKS(30));
}

void sounds_play_connected(void)
{
    play_embedded_pcm_cue("connected", voice_connected_raw_start, s_connected_samples);
}

void sounds_play_disconnected(void)
{
    play_embedded_pcm_cue("disconnected", voice_disconnected_raw_start, s_disconnected_samples);
}

void sounds_play_provisioning_wait(void)
{
    if (!s_prov_buf) {
        ESP_LOGW(TAG, "Provisioning buffer not initialized");
        return;
    }
    ESP_LOGI(TAG, "[SOUND] Playing provisioning cue");
    lock_sound_output();
    media_play_pcm(s_prov_buf, PROV_SAMPLES);
    vTaskDelay(pdMS_TO_TICKS(PROV_GAP_MS));
    media_play_pcm(s_prov_buf, PROV_SAMPLES);
    unlock_sound_output();
    vTaskDelay(pdMS_TO_TICKS(30));
}
