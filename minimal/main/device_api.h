#pragma once

#include <stdbool.h>
#include <stdint.h>

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
    int64_t participant_token_expires_at_ms;
} mitr_device_token_response_t;

typedef struct {
    const char *session_id;
    int wifi_rssi_dbm;
    const char *network_type;
    const char *ip_address;
    const char *connection_state;
    const char *last_failure_reason;
    const char *last_end_reason;
    const char *reconnect_state;
    int reconnect_attempt_count;
    const char *ota_state;
    const char *ota_target_version;
    bool last_boot_ok;
    bool speaker_muted;
    int speaker_volume;
} mitr_device_heartbeat_t;

typedef struct {
    bool has_recommended_firmware;
    char version[64];
    char download_url[256];
    bool mandatory;
    char release_notes[256];
    char sha256[96];
    int min_battery_pct;
    int rollout_percentage;
    int size_bytes;
} mitr_device_recommended_firmware_t;

typedef struct {
    bool has_session_policy;
    bool always_connected;
    int reconnect_window_sec;
    int heartbeat_interval_sec;
    int telemetry_backoff_sec;
} mitr_device_session_policy_t;

typedef struct {
    mitr_device_recommended_firmware_t recommended_firmware;
    mitr_device_session_policy_t session_policy;
} mitr_device_heartbeat_response_t;

const char *mitr_device_backend_base_url(void);
const char *mitr_device_device_id(void);
const char *mitr_device_language(void);
const char *mitr_device_hardware_rev(void);
const char *mitr_device_firmware_version(void);
bool mitr_device_has_access_token(void);
bool mitr_device_has_pairing_token(void);

esp_err_t mitr_device_complete_bootstrap(void);
esp_err_t mitr_device_request_token(mitr_device_token_response_t *out);
void mitr_device_token_response_free(mitr_device_token_response_t *response);

esp_err_t mitr_device_send_heartbeat(
    const mitr_device_heartbeat_t *heartbeat,
    mitr_device_heartbeat_response_t *response);
esp_err_t mitr_device_send_telemetry(
    const char *session_id,
    const char *event_type,
    const char *level,
    const char *message);
esp_err_t mitr_device_notify_wake_detected(
    const char *session_id,
    const char *phrase,
    float score);
esp_err_t mitr_device_end_session(const char *session_id, const char *reason);

#ifdef __cplusplus
}
#endif
