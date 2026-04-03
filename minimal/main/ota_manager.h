#pragma once

#include <stdbool.h>

#include "esp_err.h"

#include "device_api.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t mitr_ota_init(void);
void mitr_ota_note_heartbeat_success(void);
void mitr_ota_apply_heartbeat_response(const mitr_device_heartbeat_response_t *response);
bool mitr_ota_has_pending_update(void);
esp_err_t mitr_ota_apply_pending_update(void);
const char *mitr_ota_state(void);
const char *mitr_ota_target_version(void);
const char *mitr_ota_last_error(void);
bool mitr_ota_pending_verify(void);
int mitr_ota_validation_heartbeat_count(void);

#ifdef __cplusplus
}
#endif
