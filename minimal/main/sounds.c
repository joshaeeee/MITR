#include "sounds.h"
#include "media.h"
#include <math.h>
#include <string.h>
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
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
#define CHIME_SAMPLES   (SAMPLE_RATE * CHIME_MS / 1000)  /* 3200 stereo samples */
#define BEEP_SAMPLES    (SAMPLE_RATE * BEEP_MS  / 1000)  /* 2400 stereo samples */

static int16_t *s_chime_buf = NULL;  /* [CHIME_SAMPLES * 2] stereo */
static int16_t *s_beep_buf  = NULL;  /* [BEEP_SAMPLES  * 2] stereo */

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
    s_chime_buf = heap_caps_malloc(CHIME_SAMPLES * 2 * sizeof(int16_t),
                                   MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    s_beep_buf  = heap_caps_malloc(BEEP_SAMPLES  * 2 * sizeof(int16_t),
                                   MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_chime_buf || !s_beep_buf) {
        ESP_LOGE(TAG, "PSRAM alloc failed for sound buffers");
        return;
    }

    /* Rising chirp: 440 Hz → 880 Hz, 200 ms, 30 ms fade */
    gen_chirp(s_chime_buf, CHIME_SAMPLES, 440.0f, 880.0f, 28000.0f, 30);

    /* Falling chirp: 880 Hz → 440 Hz, 150 ms, 20 ms fade */
    gen_chirp(s_beep_buf, BEEP_SAMPLES, 880.0f, 440.0f, 22000.0f, 20);

    ESP_LOGI(TAG, "Sounds init OK: chime=%d samples, beep=%d samples",
             CHIME_SAMPLES, BEEP_SAMPLES);
}

void sounds_play_chime(void)
{
    if (!s_chime_buf) {
        ESP_LOGW(TAG, "Chime buffer not initialized");
        return;
    }
    ESP_LOGI(TAG, "[SOUND] Playing wake chime");
    media_play_pcm(s_chime_buf, CHIME_SAMPLES);
    /* Add a small silence gap so the LiveKit connection doesn't step on the tail */
    vTaskDelay(pdMS_TO_TICKS(50));
}

void sounds_play_beep(void)
{
    if (!s_beep_buf) {
        ESP_LOGW(TAG, "Beep buffer not initialized");
        return;
    }
    ESP_LOGI(TAG, "[SOUND] Playing disconnect beep");
    media_play_pcm(s_beep_buf, BEEP_SAMPLES);
    vTaskDelay(pdMS_TO_TICKS(50));
}
