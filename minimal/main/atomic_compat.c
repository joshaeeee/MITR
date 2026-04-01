#include <stdint.h>

#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"

static portMUX_TYPE g_atomic_compat_lock = portMUX_INITIALIZER_UNLOCKED;

uint8_t __atomic_fetch_add_1(volatile void *ptr, uint8_t value, int memorder)
{
    (void)memorder;

    volatile uint8_t *target = (volatile uint8_t *)ptr;
    portENTER_CRITICAL(&g_atomic_compat_lock);
    uint8_t previous = *target;
    *target = (uint8_t)(previous + value);
    portEXIT_CRITICAL(&g_atomic_compat_lock);
    return previous;
}

uint8_t __atomic_fetch_sub_1(volatile void *ptr, uint8_t value, int memorder)
{
    (void)memorder;

    volatile uint8_t *target = (volatile uint8_t *)ptr;
    portENTER_CRITICAL(&g_atomic_compat_lock);
    uint8_t previous = *target;
    *target = (uint8_t)(previous - value);
    portEXIT_CRITICAL(&g_atomic_compat_lock);
    return previous;
}
