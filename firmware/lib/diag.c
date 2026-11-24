/*
 * Crash diagnostics for unattended nodes. A fatal error records its reason, thread and program
 * counter in RAM that survives a warm reset, then restarts the board, so a node in the field recovers
 * instead of halting. The next boot prints the record and the hardware reset cause.
 */
#include <string.h>

#include <zephyr/arch/cpu.h>
#include <zephyr/drivers/hwinfo.h>
#include <zephyr/fatal.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log_ctrl.h>
#include <zephyr/sys/reboot.h>

#include <sonicmesh/diag.h>

#define CRASH_MAGIC 0x534d4352u /* "SMCR" */

static __noinit struct {
	uint32_t magic;
	uint32_t reason;
	uint32_t pc;
	uint32_t count;
	char thread[16];
} crash;

static uint32_t reset_cause;
static uint32_t crash_count;

void k_sys_fatal_error_handler(unsigned int reason, const struct arch_esf *esf)
{
	const char *name = k_thread_name_get(k_current_get());

	if (crash.magic != CRASH_MAGIC) {
		crash.count = 0;
	}
	crash.magic = CRASH_MAGIC;
	crash.reason = reason;
#if defined(CONFIG_ARM)
	crash.pc = esf ? esf->basic.pc : 0;
#else
	crash.pc = 0; /* Xtensa: the frame layout is private to the arch; the fault log has it */
#endif
	crash.count++;
	memset(crash.thread, 0, sizeof(crash.thread));
	if (name) {
		strncpy(crash.thread, name, sizeof(crash.thread) - 1);
	}
	LOG_PANIC();
	sys_reboot(SYS_REBOOT_WARM);
}

static const char *cause_name(uint32_t c)
{
	if (c & RESET_WATCHDOG) {
		return "watchdog";
	}
	if (c & RESET_CPU_LOCKUP) {
		return "cpu lockup";
	}
	if (c & RESET_BROWNOUT) {
		return "brownout";
	}
	if (c & RESET_SOFTWARE) {
		return "software";
	}
	if (c & RESET_PIN) {
		return "reset pin";
	}
	if (c & RESET_POR) {
		return "power on";
	}
	if (c & RESET_DEBUG) {
		return "debugger";
	}
	return c ? "other" : "power on";
}

void sm_diag_print(void)
{
	printk("reset cause: %s (0x%x)\n", cause_name(reset_cause), reset_cause);
	if (crash.magic == CRASH_MAGIC) {
		printk("last crash: reason %u in thread '%s' at pc 0x%08x (%u since power on)\n", crash.reason,
		       crash.thread, crash.pc, crash.count);
	}
}

uint32_t sm_diag_reset_cause(void)
{
	return reset_cause;
}

uint32_t sm_diag_crashes(void)
{
	return crash_count;
}

static int diag_init(void)
{
	hwinfo_get_reset_cause(&reset_cause);
	hwinfo_clear_reset_cause();
	/* A power-on reset leaves the no-init RAM as garbage. */
	if (reset_cause & RESET_POR || reset_cause == 0) {
		crash.magic = 0;
	}
	crash_count = crash.magic == CRASH_MAGIC ? crash.count : 0;
	return 0;
}

SYS_INIT(diag_init, POST_KERNEL, 0);
