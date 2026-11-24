/*
 * Drone detector glue: steps the harmonic comb every 512 samples over a 1024-sample frame, and sends
 * SM_REC_DRONE when a detection starts, every drone_comb.update_ms while it lasts,
 * and when it ends. Frames that overlap a gunshot (0.6 s from its onset) are skipped, as the web node
 * does (web/src/lora/nodeStub.ts), so a shot's crack and tail do not read as harmonics.
 *
 * Parameters "drone_comb.<name>": the comb's COMB_TUNABLES (comb.h) plus update_ms and shot_mask_ms
 * here. Trace stream "comb": level 1 prints every frame's outputs; level 2 adds the slowest comb step
 * every 300 frames.
 */
#include <math.h>
#include <string.h>

#include <zephyr/kernel.h>

#include <sonicmesh/detector.h>
#include <sonicmesh/msg.h>
#include <sonicmesh/param.h>
#include <sonicmesh/records.h>
#include <sonicmesh/status_led.h>
#include <sonicmesh/timesync.h>
#include <sonicmesh/trace.h>
#include <sonicmesh/wire.h>

#include "comb.h"

BUILD_ASSERT(CONFIG_SM_AUDIO_BLOCK_SAMPLES == COMB_HOP, "the comb steps once per audio block");

static struct comb_params params;
static struct comb comb;

#define DRONE_X_PARAM(_n, _t, _d, _lo, _hi, _h) SM_PARAM_FIELD(drone_comb, _n, _t, &params._n, _d, _lo, _hi, NULL, _h);
COMB_TUNABLES(DRONE_X_PARAM)
SM_PARAM_DEFINE(drone_comb, update_ms, int, CONFIG_SM_DETECTOR_DRONE_COMB_UPDATE_MS, 100, 60000, NULL,
		"period of DRONE update records while on, ms");
SM_PARAM_DEFINE(drone_comb, shot_mask_ms, int, 600, 0, 5000, NULL,
		"frames starting this long after a gunshot onset are skipped, ms");

SM_TRACE_DEFINE(comb, "drone comb. 1: every 32 ms frame (on, tracking, f0, score, peak, harmonics, band "
		      "and floor dB, persistence). 2: also the slowest comb step every 300 frames");

static int32_t shot_mask_samples;
static float frame[COMB_NFFT];
static uint32_t blocks;
static atomic_t last_shot; /* low 32 bits of the latest impulse's sample index */
static atomic_t have_shot;
static bool was_on;
static int64_t next_update_us;
static uint32_t steps, step_us_max;

static int16_t db10(float db)
{
	return (int16_t)CLAMP(lrintf(db * 10.0f), INT16_MIN, INT16_MAX);
}

static void report(uint8_t state, int64_t t_us, const struct comb_out *o)
{
	uint8_t body[8];
	uint32_t f0 = (uint32_t)lrintf(o->f0_hz * 10.0f);

	body[0] = state;
	sm_put_u16(&body[1], (uint16_t)MIN(f0, UINT16_MAX));
	body[3] = (uint8_t)o->nharm;
	sm_put_u16(&body[4], (uint16_t)CLAMP(lrintf(o->score * 1000.0f), 0, UINT16_MAX));
	sm_put_u16(&body[6], (uint16_t)db10(o->band_db));
	sm_msg_send_timed(SM_REC_DRONE, t_us, body, sizeof(body));
	printk("DRONE %s  f0 %.1f Hz  harmonics %d  score %.3f  band %.1f dB\n",
	       state == SM_DRONE_START ? "start" : state == SM_DRONE_END ? "end" : "on",
	       (double)o->f0_hz, o->nharm, (double)o->score, (double)o->band_db);
}

static bool in_shot(uint64_t frame_start)
{
	if (!atomic_get(&have_shot)) {
		return false;
	}
	/* Compare in 32 bits: wraps after 74 hours, far longer than any mask. */
	int32_t d = (int32_t)((uint32_t)frame_start - (uint32_t)atomic_get(&last_shot));

	return d < shot_mask_samples && d > -COMB_NFFT;
}

static int drone_init(void)
{
	struct comb_params p = params;

	p.n_fft = COMB_NFFT;
	p.hop = COMB_HOP;
	shot_mask_samples = (int32_t)((int64_t)sm_drone_comb_shot_mask_ms * CONFIG_SM_AUDIO_RATE / 1000);
	if (was_on) {
		/* A re-init drops the track: close the open detection so receivers see it end. */
		struct comb_out o = {0};

		report(SM_DRONE_END, sm_time_local_us(), &o);
		sm_led_set(SM_LED_BLUE, false);
		was_on = false;
	}
	blocks = 0;
	return comb_init(&comb, &p);
}

static void drone_process(const struct sm_block *blk)
{
	const float k = sm_audio_pa_per_count();

	memmove(frame, &frame[COMB_HOP], (COMB_NFFT - COMB_HOP) * sizeof(float));
	for (int i = 0; i < COMB_HOP; i++) {
		frame[COMB_NFFT - COMB_HOP + i] = blk->pcm[i] * k;
	}
	if (++blocks < COMB_NFFT / COMB_HOP) {
		return;
	}
	if (in_shot(blk->first_sample + COMB_HOP - COMB_NFFT)) {
		return;
	}

	struct comb_out o;
	int64_t t_us = sm_block_time_us(blk, blk->n - 1); /* the frame's last sample */

	int64_t t0 = sm_time_local_us();

	comb_step(&comb, frame, &o);
	step_us_max = MAX(step_us_max, (uint32_t)(sm_time_local_us() - t0));
	if (++steps % 300 == 0) {
		SM_TRACE(comb, 2, t_us, ",\"slowest_us\":%u,\"budget_us\":%u", step_us_max,
			 COMB_HOP * 1000000u / CONFIG_SM_AUDIO_RATE);
		step_us_max = 0;
	}
	SM_TRACE(comb, 1, t_us,
		 ",\"on\":%d,\"trk\":%d,\"f0\":%.1f,\"score\":%.3f,\"peak\":%.3f,\"nh\":%d,\"band\":%.1f,"
		 "\"floor\":%.1f,\"q\":%d",
		 o.on, o.tracking, (double)o.f0_hz, (double)o.score, (double)o.peak, o.nharm, (double)o.band_db,
		 (double)o.floor_db, o.q);
	if (o.on && !was_on) {
		report(SM_DRONE_START, t_us, &o);
		next_update_us = t_us + sm_drone_comb_update_ms * 1000LL;
		sm_led_set(SM_LED_BLUE, true);
	} else if (o.on && o.tracking && t_us >= next_update_us) {
		/* While on but between hits (the comb holds on for about 1 s) there is no pitch to report. */
		report(SM_DRONE_UPDATE, t_us, &o);
		next_update_us += sm_drone_comb_update_ms * 1000LL;
	} else if (!o.on && was_on) {
		report(SM_DRONE_END, t_us, &o);
		sm_led_set(SM_LED_BLUE, false);
	}
	was_on = o.on;
}

static void drone_event(const struct sm_event *evt)
{
	if (evt->type == SM_EVT_IMPULSE) {
		atomic_set(&last_shot, (atomic_val_t)(uint32_t)evt->sample);
		atomic_set(&have_shot, 1);
	}
}

/* Lowest detector priority: the comb is the heaviest and only uses CPU the rest leave. */
SM_DETECTOR_DEFINE(drone_comb, drone_init, drone_process, drone_event, 4096, K_PRIO_PREEMPT(13));
