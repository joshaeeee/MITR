#pragma once

#include <stdbool.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t mitr_gateway_client_start(void);
void mitr_gateway_client_stop(void);
bool mitr_gateway_client_is_connected(void);

#ifdef __cplusplus
}
#endif
