#include <string.h>

#include "esp_log.h"
#include "codec_init.h"
#include "codec_board.h"
#include "board.h"

static const char *TAG = "board";
static const char *MITR_ESP32_S3_RAW_I2S_CFG =
    "i2s: {mclk: -1, bclk: 4, ws: 5, din: -1, dout: 6}\n"
    "i2s: {mclk: -1, bclk: 13, ws: 14, din: 12, dout: -1}\n"
    "out: {codec: DUMMY, pa: 15, i2c_port: -1, i2s_port: 0}\n"
    "in: {codec: DUMMY, pa: 15, i2c_port: -1, i2s_port: 1}\n";

void board_init()
{
    ESP_LOGI(TAG, "Initializing board");

    if (strcmp(CONFIG_LK_EXAMPLE_CODEC_BOARD_TYPE, "MITR_ESP32_S3_RAW_I2S") == 0) {
        ESP_LOGI(TAG, "Using inline raw I2S board config for Mitr ESP32-S3");
        ESP_ERROR_CHECK(codec_board_parse_all_config(MITR_ESP32_S3_RAW_I2S_CFG) == 0 ? ESP_OK : ESP_FAIL);
    } else {
        set_codec_board_type(CONFIG_LK_EXAMPLE_CODEC_BOARD_TYPE);
    }
    codec_init_cfg_t cfg = {
        .in_mode = CODEC_I2S_MODE_STD,
        .out_mode = CODEC_I2S_MODE_STD,
        .in_use_tdm = false,
        .reuse_dev = false
    };
    int ret = init_codec(&cfg);
    ESP_LOGI(TAG, "Codec board type: %s", CONFIG_LK_EXAMPLE_CODEC_BOARD_TYPE);
    ESP_ERROR_CHECK(ret == 0 ? ESP_OK : ESP_FAIL);
}
