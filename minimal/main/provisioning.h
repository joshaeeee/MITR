#pragma once

#include <stdbool.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define MITR_PROVISIONING_CUSTOM_ENDPOINT "mitr-bootstrap"

esp_err_t mitr_provisioning_start_if_needed(bool *started);

#ifdef __cplusplus
}
#endif
