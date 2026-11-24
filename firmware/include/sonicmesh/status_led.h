/* The board's RGB LED, for field checks without a laptop. */
#ifndef SONICMESH_STATUS_LED_H
#define SONICMESH_STATUS_LED_H

#include <stdint.h>

enum sm_led {
	SM_LED_RED,
	SM_LED_GREEN,
	SM_LED_BLUE,
};

int sm_led_init(void);
/* Lights one colour for ms milliseconds, on top of whatever else is lit. */
void sm_led_flash(enum sm_led led, uint32_t ms);
/* Holds one colour on or off until changed. */
void sm_led_set(enum sm_led led, bool on);

#endif
