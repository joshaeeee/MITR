#include "mel_features.h"
#include <math.h>
#include <string.h>
#include "esp_heap_caps.h"
#include "esp_log.h"

#define TAG "mel"

/* ---- FFT configuration ---- */
#define FFT_SIZE   512            /* Must be power-of-2 >= MEL_WIN_SAMPLES */
#define N_FFT_BINS (FFT_SIZE / 2 + 1)  /* DC to Nyquist inclusive: 257 bins */

/* ---- Mel filterbank configuration ---- */
#define SAMPLE_RATE 16000
#define FMIN        125.0f
#define FMAX        7600.0f

/* ---- Pre-computed tables (in PSRAM) ---- */
static float *s_hann = NULL;       /* [MEL_WIN_SAMPLES] */
static float *s_tw_re = NULL;      /* [FFT_SIZE/2] twiddle cosines */
static float *s_tw_im = NULL;      /* [FFT_SIZE/2] twiddle sines */
static float *s_fft_re = NULL;     /* [FFT_SIZE] working buffer */
static float *s_fft_im = NULL;     /* [FFT_SIZE] working buffer */

/* Sparse mel filterbank: start/end bin + float weights for each filter */
typedef struct {
    int    start;
    int    end;
    float *w;   /* [end - start + 1] */
} mel_filter_t;

static mel_filter_t s_mel[MEL_NUM_BINS];
static float       *s_mel_pool = NULL;  /* backing pool for all filter weights */

/* ---- Ring buffer for the 480-sample window ---- */
static int16_t s_win_buf[MEL_WIN_SAMPLES];
static int     s_win_pos = 0;   /* oldest sample write position */

/* ------------------------------------------------------------------ */

static float hz_to_mel(float hz) { return 2595.0f * log10f(1.0f + hz / 700.0f); }
static float mel_to_hz(float m)  { return 700.0f * (powf(10.0f, m / 2595.0f) - 1.0f); }

/* In-place radix-2 Cooley-Tukey FFT for N=FFT_SIZE (512).
 * Uses pre-computed twiddle factors.
 * After this call: re[k], im[k] = k-th complex DFT coefficient.          */
static void fft512(float *re, float *im)
{
    const int N = FFT_SIZE;

    /* --- bit-reversal permutation --- */
    for (int i = 1, j = 0; i < N; i++) {
        int bit = N >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            float t;
            t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }

    /* --- butterfly stages --- */
    /* For stage with butterfly length `len`, the twiddle for pair j within
     * a group is W_{N}^{j * (N / len)} = s_tw_re/im[j * stride].         */
    for (int len = 2, stride = N / 2; len <= N; len <<= 1, stride >>= 1) {
        int half = len >> 1;
        for (int i = 0; i < N; i += len) {
            for (int j = 0; j < half; j++) {
                float twr = s_tw_re[j * stride];
                float twi = s_tw_im[j * stride];
                float uRe = re[i + j];
                float uIm = im[i + j];
                float vRe = re[i + j + half] * twr - im[i + j + half] * twi;
                float vIm = re[i + j + half] * twi + im[i + j + half] * twr;
                re[i + j]        = uRe + vRe;
                im[i + j]        = uIm + vIm;
                re[i + j + half] = uRe - vRe;
                im[i + j + half] = uIm - vIm;
            }
        }
    }
}

/* ------------------------------------------------------------------ */

void mel_features_init(void)
{
    /* Allocate all tables from PSRAM */
    s_hann   = heap_caps_malloc(MEL_WIN_SAMPLES * sizeof(float), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    s_tw_re  = heap_caps_malloc((FFT_SIZE / 2) * sizeof(float), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    s_tw_im  = heap_caps_malloc((FFT_SIZE / 2) * sizeof(float), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    s_fft_re = heap_caps_malloc(FFT_SIZE * sizeof(float), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    s_fft_im = heap_caps_malloc(FFT_SIZE * sizeof(float), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);

    if (!s_hann || !s_tw_re || !s_tw_im || !s_fft_re || !s_fft_im) {
        ESP_LOGE(TAG, "PSRAM alloc failed for FFT tables");
        return;
    }

    /* Hann window */
    for (int i = 0; i < MEL_WIN_SAMPLES; i++) {
        s_hann[i] = 0.5f * (1.0f - cosf(2.0f * (float)M_PI * i / (MEL_WIN_SAMPLES - 1)));
    }

    /* Twiddle factors: W_k = exp(-j * 2*pi*k / N) = cos(...) - j*sin(...) */
    for (int k = 0; k < FFT_SIZE / 2; k++) {
        float angle = -2.0f * (float)M_PI * k / FFT_SIZE;
        s_tw_re[k] = cosf(angle);
        s_tw_im[k] = sinf(angle);
    }

    /* Mel filterbank.
     * We compute MEL_NUM_BINS + 2 centre points linearly spaced on the mel
     * scale, convert them to FFT bin indices, then build triangular filters. */
    float mel_lo  = hz_to_mel(FMIN);
    float mel_hi  = hz_to_mel(FMAX);
    int   bins[MEL_NUM_BINS + 2];
    for (int i = 0; i < MEL_NUM_BINS + 2; i++) {
        float mel = mel_lo + (float)i * (mel_hi - mel_lo) / (MEL_NUM_BINS + 1);
        float hz  = mel_to_hz(mel);
        int   bin = (int)(FFT_SIZE * hz / SAMPLE_RATE + 0.5f);
        if (bin < 0)            bin = 0;
        if (bin > FFT_SIZE / 2) bin = FFT_SIZE / 2;
        bins[i] = bin;
    }

    /* Count total weight entries */
    int total = 0;
    for (int m = 0; m < MEL_NUM_BINS; m++) {
        total += bins[m + 2] - bins[m] + 1;
    }
    s_mel_pool = heap_caps_malloc(total * sizeof(float), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_mel_pool) {
        ESP_LOGE(TAG, "PSRAM alloc failed for mel filterbank");
        return;
    }

    float *wp = s_mel_pool;
    for (int m = 0; m < MEL_NUM_BINS; m++) {
        int lo  = bins[m];
        int mid = bins[m + 1];
        int hi  = bins[m + 2];
        s_mel[m].start = lo;
        s_mel[m].end   = hi;
        s_mel[m].w     = wp;
        for (int k = lo; k <= hi; k++) {
            if (k <= mid) {
                *wp = (mid == lo) ? 1.0f : (float)(k - lo) / (float)(mid - lo);
            } else {
                *wp = (hi == mid) ? 1.0f : (float)(hi - k) / (float)(hi - mid);
            }
            wp++;
        }
    }

    memset(s_win_buf, 0, sizeof(s_win_buf));
    s_win_pos = 0;

    ESP_LOGI(TAG, "Mel features init OK: %d bins, FFT=%d, win=%d, hop=%d",
             MEL_NUM_BINS, FFT_SIZE, MEL_WIN_SAMPLES, MEL_HOP_SAMPLES);
}

/* ------------------------------------------------------------------ */

void mel_features_compute(const int16_t *new_samples, float *out)
{
    /* 1. Slide ring buffer: append MEL_HOP_SAMPLES new samples */
    for (int i = 0; i < MEL_HOP_SAMPLES; i++) {
        s_win_buf[s_win_pos] = new_samples[i];
        s_win_pos = (s_win_pos + 1) % MEL_WIN_SAMPLES;
    }

    /* 2. Build windowed frame (oldest sample first) into FFT re[], zero-pad */
    memset(s_fft_re, 0, FFT_SIZE * sizeof(float));
    memset(s_fft_im, 0, FFT_SIZE * sizeof(float));
    for (int i = 0; i < MEL_WIN_SAMPLES; i++) {
        int idx = (s_win_pos + i) % MEL_WIN_SAMPLES;
        s_fft_re[i] = (float)s_win_buf[idx] * s_hann[i];
    }

    /* 3. FFT */
    fft512(s_fft_re, s_fft_im);

    /* 4. Power spectrum (bins 0 .. FFT_SIZE/2) */
    /* We'll compute mel energies directly in step 5 */

    /* 5. Apply mel filterbank and take log */
    for (int m = 0; m < MEL_NUM_BINS; m++) {
        float energy = 0.0f;
        int   lo     = s_mel[m].start;
        int   hi     = s_mel[m].end;
        float *w     = s_mel[m].w;
        for (int k = lo; k <= hi; k++) {
            float power = s_fft_re[k] * s_fft_re[k] + s_fft_im[k] * s_fft_im[k];
            energy += power * w[k - lo];
        }
        /* log10 with floor to avoid -inf */
        out[m] = log10f(energy + 1e-6f);
    }
}
