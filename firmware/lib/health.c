#include <math.h>

#include <zephyr/kernel.h>
#include <zephyr/shell/shell.h>

#include <sonicmesh/audio.h>
#include <sonicmesh/battery.h>
#include <sonicmesh/detector.h>
#include <sonicmesh/msg.h>
#include <sonicmesh/param.h>
#include <sonicmesh/radio.h>
#include <sonicmesh/records.h>
#include <sonicmesh/status_led.h>
#include <sonicmesh/timesync.h>
#include <sonicmesh/wire.h>

#ifndef SM_BUILD
#define SM_BUILD 0
#endif

static int16_t db10(float db)
{
	return (int16_t)CLAMP(lrintf(db * 10.0f), INT16_MIN, INT16_MAX);
}

SM_PARAM_DEFINE(health, period_s, int, CONFIG_SM_HEALTH_PERIOD_S, 1, 3600, NULL,
		"HEALTH record period, s");
SM_PARAM_DEFINE(health, print, bool, 1, 0, 1, NULL, "print the status block on the console each period");

static struct sm_audio_stats last_audio;

/* `sm status` fields for a node (shell_cmds.c). */
void sm_status_fields(const struct shell *sh)
{
	double off, drift;
	int pts;
	uint32_t net;
	bool synced = sm_time_to_net(sm_time_local_us(), &net);
	int64_t age = sm_timesync_age_us();

	sm_timesync_state(&off, &drift, &pts);
	shell_fprintf(sh, SHELL_NORMAL,
		      ",\"node\":\"%04x\",\"synced\":%d,\"sync_age_ms\":%lld,\"drift_ppm\":%.2f,\"fit\":%d,"
		      "\"level_db\":%.1f,\"max_db\":%.1f,\"rate_hz\":%.2f,\"batt_mv\":%d,\"pending\":%u,"
		      "\"dropped\":%u,\"block_drops\":%u",
		      sm_node_id(), synced, age < 0 ? -1 : age / 1000, drift, pts, (double)last_audio.level_db,
		      (double)last_audio.max_db, (double)last_audio.rate_hz, sm_battery_mv(), sm_msg_pending(),
		      sm_msg_dropped(), sm_detectors_drops());
}

static void health(void *p1, void *p2, void *p3)
{
	for (;;) {
		k_sleep(K_SECONDS(sm_health_period_s));

		struct sm_audio_stats a;
		uint8_t p[18];
		int64_t age = sm_timesync_age_us();
		uint32_t up = (uint32_t)(k_uptime_get() / 1000);
		double off, drift;
		int pts;
		uint32_t net;
		bool synced = sm_time_to_net(sm_time_local_us(), &net);

		sm_audio_take_stats(&a);
		last_audio = a;
		sm_timesync_state(&off, &drift, &pts);
		sm_put_u32(&p[0], up);
		sm_put_u16(&p[4], (uint16_t)db10(a.level_db));
		sm_put_u16(&p[6], (uint16_t)db10(a.max_db));
		sm_put_u16(&p[8], (uint16_t)MIN(a.clips, UINT16_MAX));
		sm_put_u16(&p[10], (uint16_t)MIN(sm_detectors_drops(), UINT16_MAX));
		int batt = sm_battery_mv();

		sm_put_u16(&p[12], (uint16_t)batt);
		sm_put_u16(&p[14], age < 0 ? 0xFFFF : (uint16_t)MIN(age / 100000, 0xFFFE));
		sm_put_u16(&p[16], SM_BUILD);
		sm_msg_send(SM_REC_HEALTH, p, sizeof(p));

		sm_led_set(SM_LED_GREEN, synced);
		if (!sm_health_print) {
			continue;
		}
		printk("[node %04x] up %us  level %.1f dB  max %.1f dB  clips %u  rate %.2f Hz  batt %d mV\n",
		       sm_node_id(), up, (double)a.level_db, (double)a.max_db, a.clips, (double)a.rate_hz, batt);
		if (age < 0) {
			printk("  sync: no gateway heard yet\n");
		} else {
			printk("  sync: %s  last event %.1fs ago  fit %d pts  drift %.1f ppm\n",
			       synced ? "yes" : "no", age / 1e6, pts, drift);
		}
		printk("  radio: %u records pending, %u dropped\n", sm_msg_pending(), sm_msg_dropped());
		sm_detectors_print();
	}
}

K_THREAD_STACK_DEFINE(health_stack, 2048);
static struct k_thread health_thread;

int sm_health_start(void)
{
	sm_battery_init();
	k_thread_create(&health_thread, health_stack, K_THREAD_STACK_SIZEOF(health_stack), health, NULL, NULL,
			NULL, K_PRIO_PREEMPT(11), 0, K_NO_WAIT);
	k_thread_name_set(&health_thread, "sm_health");
	return 0;
}
