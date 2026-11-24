/*
 * Hardware watchdog. A node in the field has nobody to press reset, so a hang must restart it.
 *
 * The nRF52 watchdog keeps counting through a soft reset, and nothing stops it once started. So it
 * also restarts a board that hangs after a reset into the UF2 bootloader (seen twice on the bench
 * after flashing: no USB and no radio until the board was unplugged). TIMEOUT_MS leaves the
 * bootloader plenty of time to take a UF2 image.
 *
 * A thread feeds it every FEED_MS, but only while the work moves on: sm_watchdog_alive() (the node's
 * is in detector.c) must say so. The feeder runs below the shell, so a thread that spins at a higher
 * priority starves it; the detectors below it are covered by the alive check. For the first
 * GRACE_MS after boot it feeds without asking, while the radio and audio start.
 *
 * `sm wdt` shows the state; `sm wdt test` stops feeding, so the board should restart within
 * TIMEOUT_MS and report "watchdog" as its reset cause.
 */
#include <string.h>

#include <zephyr/device.h>
#include <zephyr/drivers/watchdog.h>
#include <zephyr/init.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/shell/shell.h>

#if defined(CONFIG_SOC_FAMILY_NORDIC_NRF)
#include <hal/nrf_wdt.h>
#define NRF_INHERIT 1
#else
#define NRF_INHERIT 0
#endif

LOG_MODULE_REGISTER(sm_wdt, CONFIG_SONICMESH_LOG_LEVEL);

#define TIMEOUT_MS 30000
#define FEED_MS 5000
#define GRACE_MS 30000

static const struct device *const wdt = DEVICE_DT_GET(DT_NODELABEL(wdt0));
static int channel = -1;
static bool inherited; /* already running at boot (a soft reset keeps it): fed through the registers */
static atomic_t starved; /* `sm wdt test`: stop feeding */
static uint32_t refused; /* checks in a row that said the work stopped */

__weak bool sm_watchdog_alive(void)
{
	return true;
}

/* Starts before USB and the radio, so a hang there is caught too. */
static int wdt_start(void)
{
	/* After a soft reset (a reset into the bootloader, then the new image) the watchdog still runs
	 * with the old settings, which the driver cannot change. They are ours (TIMEOUT_MS), so it is
	 * fed directly; the next power-on or watchdog reset starts it through the driver again. */
#if NRF_INHERIT
	if (nrf_wdt_started_check(NRF_WDT)) {
		inherited = true;
		return 0;
	}
#endif
	if (!device_is_ready(wdt)) {
		return 0;
	}
	struct wdt_timeout_cfg cfg = {
		.window = {.min = 0, .max = TIMEOUT_MS},
		.flags = WDT_FLAG_RESET_SOC,
	};

	channel = wdt_install_timeout(wdt, &cfg);
	if (channel < 0) {
		return 0;
	}
	/* Runs while the CPU sleeps; pauses only while a debugger has halted it. */
	if (wdt_setup(wdt, WDT_OPT_PAUSE_HALTED_BY_DBG) != 0 && wdt_setup(wdt, 0) != 0) {
		channel = -1; /* the second try: a watchdog that cannot pause for the debugger */
	}
	return 0;
}

SYS_INIT(wdt_start, POST_KERNEL, 0);

static void feed(void)
{
#if NRF_INHERIT
	if (inherited) {
		/* Every reload register: whichever channels the old settings enabled must all be fed. */
		for (int i = 0; i < NRF_WDT_CHANNEL_NUMBER; i++) {
			nrf_wdt_reload_request_set(NRF_WDT, (nrf_wdt_rr_register_t)i);
		}
		return;
	}
#endif
	wdt_feed(wdt, channel);
}

static void feeder(void *p1, void *p2, void *p3)
{
	if (channel < 0 && !inherited) {
		LOG_ERR("watchdog not running");
		return;
	}
	for (;;) {
		k_msleep(FEED_MS);
		if (atomic_get(&starved)) {
			continue;
		}
		/* Ask every time, so the check's own counters stay current through the grace period. */
		bool alive = sm_watchdog_alive();

		if (alive || k_uptime_get() < GRACE_MS) {
			refused = 0;
			feed();
		} else if (refused++ == 0) {
			LOG_ERR("work stopped; the watchdog restarts the board within %d s", TIMEOUT_MS / 1000);
		}
	}
}

/* Priority 12: below the shell (11), above the comb (13) and the capture sender (14). */
K_THREAD_DEFINE(sm_wdt_feed, 768, feeder, NULL, NULL, NULL, K_PRIO_PREEMPT(12), 0, 0);

static int cmd_wdt(const struct shell *sh, size_t argc, char **argv)
{
	if (argc > 1 && strcmp(argv[1], "test") == 0) {
		atomic_set(&starved, 1);
		shell_print(sh, "{\"k\":\"ok\",\"c\":\"wdt\",\"m\":\"not feeding; restart within %d s\"}",
			    TIMEOUT_MS / 1000);
		return 0;
	}
	shell_print(sh, "{\"k\":\"wdt\",\"running\":%d,\"inherited\":%d,\"timeout_ms\":%d,\"refused\":%u,"
		    "\"starved\":%d}",
		    channel >= 0 || inherited, inherited, TIMEOUT_MS, refused, (int)atomic_get(&starved));
	shell_print(sh, "{\"k\":\"ok\",\"c\":\"wdt\"}");
	return 0;
}

SHELL_SUBCMD_ADD((sm), wdt, NULL, "Watchdog state; `sm wdt test` stops feeding it", cmd_wdt, 1, 1);
