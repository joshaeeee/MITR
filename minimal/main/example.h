
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

bool join_room(void);
void leave_room();
bool session_is_active(void);
bool session_is_conversation_active(void);
int session_reconnect_window_sec(void);

#ifdef __cplusplus
}
#endif
