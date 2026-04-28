#pragma once

#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t mitr_device_storage_init(void);

const char *mitr_device_storage_backend_base_url(void);
const char *mitr_device_storage_device_id(void);
const char *mitr_device_storage_access_token(void);
const char *mitr_device_storage_pairing_token(void);
const char *mitr_device_storage_language(void);

bool mitr_device_storage_has_access_token(void);
bool mitr_device_storage_has_pairing_token(void);

esp_err_t mitr_device_storage_store_bootstrap(
    const char *backend_base_url,
    const char *pairing_token,
    const char *device_id,
    const char *language);
esp_err_t mitr_device_storage_store_access_token(
    const char *device_access_token,
    const char *device_id);
esp_err_t mitr_device_storage_clear_access_token(void);

#ifdef __cplusplus
}
#endif
