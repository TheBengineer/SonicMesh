/* Reset cause and crash record, for unattended boards. See lib/diag.c. */
#ifndef SONICMESH_DIAG_H
#define SONICMESH_DIAG_H

#include <stdint.h>

/* Prints the reset cause and the last crash, if any. */
void sm_diag_print(void);

/* hwinfo RESET_* bits for this boot. */
uint32_t sm_diag_reset_cause(void);

/* Crashes since power on. */
uint32_t sm_diag_crashes(void);

#endif
