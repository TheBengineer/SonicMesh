/*
 * Gunshot detector glue: runs the onset test on every block and sends SM_REC_SHOT once the hold after
 * an onset ends, with the loudest window in that hold as the peak.
 *
 * Parameters "gunshot.<name>" come from IMPULSE_TUNABLES (impulse.h). Trace stream "impulse":
 * level 1 prints one line per 32 ms block with its loudest window and the largest rise.
 */
#include <math.h>

#include <zephyr/kernel.h>

#include <sonicmesh/detector.h>
#include <sonicmesh/msg.h>
#include <sonicmesh/param.h>
#include <sonicmesh/records.h>
#include <sonicmesh/status_led.h>
#include <sonicmesh/trace.h>
#include <sonicmesh/wire.h>

#include "impulse.h"

#define REF_PA2 (20e-6f * 20e-6f)

static struct impulse_params params;
static struct impulse det;

#define GUNSHOT_X_PARAM(_n, _t, _d, _lo, _hi, _h) SM_PARAM_FIELD(gunshot, _n, _t, &params._n, _d, _lo, _hi, NULL, _h);
IMPULSE_TUNABLES(GUNSHOT_X_PARAM)

SM_TRACE_DEFINE(impulse, "gunshot onset test. 1: per 32 ms block, loudest 1 ms window and largest rise (dB)");
static struct {
	bool open;
	int left;
	int64_t t_us;
	float peak, rise_db;
} shot;

static int16_t db10(float db)
{
	return (int16_t)CLAMP(lrintf(db * 10.0f), INT16_MIN, INT16_MAX);
}

static void finish(void)
{
	uint8_t body[4];
	float peak_db = 10.0f * log10f(shot.peak / REF_PA2);

	sm_put_u16(&body[0], (uint16_t)db10(peak_db));
	sm_put_u16(&body[2], (uint16_t)db10(shot.rise_db));
	sm_msg_send_timed(SM_REC_SHOT, shot.t_us, body, sizeof(body));
	printk("SHOT  peak %.1f dB  rise %.1f dB\n", (double)peak_db, (double)shot.rise_db);
	shot.open = false;
}

static int gunshot_init(void)
{
	impulse_init(&det, &params);
	shot.open = false;
	return 0;
}

static void gunshot_process(const struct sm_block *blk)
{
	const float k = sm_audio_pa_per_count();
	float x[IMPULSE_WIN];
	float blk_max = 0, blk_rise = 0;

	for (uint32_t w = 0; w + IMPULSE_WIN <= blk->n; w += IMPULSE_WIN) {
		struct impulse_window out;

		for (int i = 0; i < IMPULSE_WIN; i++) {
			x[i] = blk->pcm[w + i] * k;
		}
		impulse_step(&det, x, &out);
		if (SM_TRACE_ON(impulse, 1)) {
			blk_max = MAX(blk_max, out.power);
			blk_rise = MAX(blk_rise, out.power / MAX(out.floor, 1e-12f));
		}
		if (out.onset) {
			struct sm_event evt = {.type = SM_EVT_IMPULSE, .sample = blk->first_sample + w};

			sm_event_publish(&evt);
			sm_led_flash(SM_LED_RED, 150);
			shot.open = true;
			shot.left = det.hold_windows;
			shot.t_us = sm_block_time_us(blk, w);
			shot.peak = out.power;
			shot.rise_db = 10.0f * log10f(out.power / out.floor);
		} else if (shot.open) {
			shot.peak = MAX(shot.peak, out.power);
			if (--shot.left <= 0) {
				finish();
			}
		}
	}
	SM_TRACE(impulse, 1, blk->t0_local_us, ",\"max_db\":%.1f,\"rise_db\":%.1f",
		 (double)(10.0f * log10f(blk_max / REF_PA2 + 1e-12f)), (double)(10.0f * log10f(blk_rise + 1e-12f)));
}

/* Priority 2: above the comb, so onsets are known before the comb steps the same audio. */
SM_DETECTOR_DEFINE(gunshot, gunshot_init, gunshot_process, NULL, 2048, K_PRIO_PREEMPT(2));
