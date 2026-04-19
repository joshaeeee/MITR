#pragma once

#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"

#ifdef __cplusplus
extern "C" {
#endif

int  wake_word_init(void);
void wake_word_start(EventGroupHandle_t eg, EventBits_t bit);
void wake_word_stop(void);
void wake_word_rearm(void);

#ifdef __cplusplus
}
#endif
