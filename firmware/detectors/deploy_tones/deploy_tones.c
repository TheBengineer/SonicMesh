/*
 * Deploy tone detector glue: feeds every audio block to the decoder (tones.c). For each frame it
 * accepts it sends a TONE record, blinks the green LED three times and prints a line.
 *
 * Parameters "deploy_tones.<name>": min_ratio_db and repeat_ms here, and enable (every detector has
 * it). Trace stream "tones": level 1 prints each report; level 2 prints every frame that passed the
 * preamble, with its CRC and dominance result.
 */
#include <math.h>

#include <zephyr/kernel.h>

#include <sonicmesh/audio.h>
#include <sonicmesh/detector.h>
#include <sonicmesh/msg.h>
#include <sonicmesh/param.h>
#include <sonicmesh/records.h>
#include <sonicmesh/status_led.h>
#include <sonicmesh/trace.h>
#include <sonicmesh/wire.h>

#include "tones.h"

#define BLINKS 3
#define BLINK_ON_MS 100
#define BLINK_PERIOD_MS 200

SM_PARAM_DEFINE(deploy_tones, min_ratio_db, float, 7.8, 0, 40, NULL,
		"least dominance of each symbol over the other seven tones, dB");
SM_PARAM_DEFINE(deploy_tones, repeat_ms, int, 5000, 0, 600000, NULL,
		"the same word within this time of its last report is not reported again, ms");

SM_TRACE_DEFINE(tones, "deploy tone frames. 1: each report (word, level and dominance in dB). 2: also "
		       "every frame that passed the preamble (start, word, CRC ok, dominant, dominance dB)");

static struct tones det;
static int blinks_left;

static void blink_step(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(blink_work, blink_step);

/* Runs on the system work queue: flashes, then schedules the next flash, so no thread sleeps. */
static void blink_step(struct k_work *work)
{
	ARG_UNUSED(work);
	sm_led_flash(SM_LED_GREEN, BLINK_ON_MS);
	if (--blinks_left > 0) {
		k_work_reschedule(&blink_work, K_MSEC(BLINK_PERIOD_MS));
	}
}

static int16_t db10(float db)
{
	return (int16_t)CLAMP(lrintf(db * 10.0f), INT16_MIN, INT16_MAX);
}

/* dB SPL of a full-scale sine, from the mic calibration: the offset from dB relative to full scale. */
static float spl_offset_db(void)
{
	float peak_pa = sm_audio_pa_per_count() * 32768.0f;

	return 20.0f * log10f(peak_pa / (sqrtf(2.0f) * 20e-6f));
}

static void report(const struct tones_report *r, float spl_off)
{
	float level_db = r->level_dbfs + spl_off;
	int64_t t_us = sm_audio_sample_time_us(r->start);
	uint8_t body[6];

	sm_put_u16(&body[0], r->word);
	sm_put_u16(&body[2], (uint16_t)db10(level_db));
	sm_put_u16(&body[4], (uint16_t)db10(r->ratio_db));
	sm_msg_send_timed(SM_REC_TONE, t_us, body, sizeof(body));
	SM_TRACE(tones, 1, t_us, ",\"word\":%u,\"level_db\":%.1f,\"ratio_db\":%.1f", (unsigned)r->word,
		 (double)level_db, (double)r->ratio_db);
	printk("TONE  word 0x%04x  level %.1f dB SPL  dominance %.1f dB\n", (unsigned)r->word,
	       (double)level_db, (double)r->ratio_db);
	blinks_left = BLINKS;
	k_work_reschedule(&blink_work, K_NO_WAIT);
}

static void on_frame(void *ctx, const struct tones_frame *f)
{
	ARG_UNUSED(ctx);
	if (SM_TRACE_ON(tones, 2)) {
		SM_TRACE(tones, 2, sm_audio_sample_time_us(f->start),
			 ",\"word\":%u,\"crc_ok\":%d,\"dominant\":%d,\"ratio_db\":%.1f", (unsigned)f->word,
			 f->crc_ok ? 1 : 0, f->dominant ? 1 : 0, (double)f->ratio_db);
	}
}

static int deploy_init(void)
{
	tones_init(&det, sm_deploy_tones_min_ratio_db, (float)sm_deploy_tones_repeat_ms);
	det.on_frame = on_frame;
	return 0;
}

static void deploy_process(const struct sm_block *blk)
{
	struct tones_report rep[4];
	int n = tones_feed(&det, blk->pcm, blk->n, blk->first_sample, rep, ARRAY_SIZE(rep));
	float spl_off = n > 0 ? spl_offset_db() : 0;

	for (int i = 0; i < n; i++) {
		report(&rep[i], spl_off);
	}
}

/* Priority 4: after the gunshot onset (2), before the drone comb (13). Stack as the gunshot's. */
SM_DETECTOR_DEFINE(deploy_tones, deploy_init, deploy_process, NULL, 2048, K_PRIO_PREEMPT(4));
