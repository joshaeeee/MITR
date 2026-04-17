
#pragma once

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

bool join_room(void);
void leave_room();
bool session_is_active(void);
int session_reconnect_window_sec(void);

/**
 * Publish a `{type:"wake",wakeAtMs:...}` data message to the agent on topic
 * `mitr.device_event`. Non-blocking. Safe to call only when the room is
 * connected.
 */
void publish_wake_event(int64_t wake_at_ms);

/**
 * Returns true once (and clears) if the agent has signalled `turn_ended` via
 * the `mitr.device_control` data topic since the last call. Poll this from
 * the main device loop while handling a wake-driven turn.
 */
bool consume_turn_ended(void);

#ifdef __cplusplus
}
#endif
