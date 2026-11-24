/* Battery voltage. See lib/battery.c. */
#ifndef SONICMESH_BATTERY_H
#define SONICMESH_BATTERY_H

int sm_battery_init(void);

/* Battery voltage in mV, or 0 if it cannot be read. */
int sm_battery_mv(void);

#endif
