
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

bool join_room(void);
void leave_room();
bool session_is_active(void);
bool session_is_agent_ready(void);
bool session_is_conversation_active(void);
bool session_wait_for_agent_ready(int timeout_ms);
int session_reconnect_window_sec(void);
void on_wake_detected(void);

#ifdef __cplusplus
}
#endif
