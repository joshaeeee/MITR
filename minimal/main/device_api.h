#pragma once

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    char *session_id;
    char *server_url;
    char *participant_token;
    char *room_name;
    char *identity;
    char *agent_name;
    char *device_id;
    char *user_id;
} mitr_device_token_response_t;

typedef struct {
    const char *session_id;
    int wifi_rssi_dbm;
    const char *network_type;
    const char *ip_address;
    const char *connection_state;
} mitr_device_heartbeat_t;

const char *mitr_device_backend_base_url(void);
const char *mitr_device_language(void);
const char *mitr_device_hardware_rev(void);
const char *mitr_device_firmware_version(void);

esp_err_t mitr_device_request_token(mitr_device_token_response_t *out);
void mitr_device_token_response_free(mitr_device_token_response_t *response);

esp_err_t mitr_device_send_heartbeat(const mitr_device_heartbeat_t *heartbeat);
esp_err_t mitr_device_send_telemetry(
    const char *session_id,
    const char *event_type,
    const char *level,
    const char *message);
esp_err_t mitr_device_end_session(const char *session_id, const char *reason);

#ifdef __cplusplus
}
#endif
