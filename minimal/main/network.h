#pragma once

#include <stdbool.h>

#include "esp_err.h"
#include "freertos/FreeRTOS.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t mitr_network_start(bool *provisioning_started);
bool mitr_network_wait_connected(TickType_t timeout);
bool mitr_network_is_connected(void);

#ifdef __cplusplus
}
#endif
