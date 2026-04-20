#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

void mitr_latency_init(void);
int64_t mitr_latency_boot_ms(void);
void mitr_latency_mark(const char *stage);
void mitr_latency_begin_wake(const char *stage);
void mitr_latency_mark_wake(const char *stage);
void mitr_latency_end_wake(const char *reason);

#ifdef __cplusplus
}
#endif
