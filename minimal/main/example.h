
#pragma once

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

bool join_room(void);
void leave_room();
bool session_is_active(void);

#ifdef __cplusplus
}
#endif
