
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

bool join_room(void);
void leave_room();
bool session_is_active(void);
bool session_has_livekit_session(void);
bool session_is_conversation_active(void);
int session_reconnect_window_sec(void);
bool session_begin_local_wake(const char *model_name, const char *phrase, bool play_chime);
esp_err_t session_notify_wake_detected(const char *model_name, const char *phrase);
void on_wake_detected(void);

#ifdef __cplusplus
}
#endif
