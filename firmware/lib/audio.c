#include <math.h>
#include <stdlib.h>
#include <string.h>

#include <zephyr/audio/dmic.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include <sonicmesh/audio.h>
#include <sonicmesh/detector.h>
#include <sonicmesh/param.h>
#include <sonicmesh/trace.h>
#include <sonicmesh/timesync.h>

LOG_MODULE_REGISTER(sm_audio, CONFIG_SONICMESH_LOG_LEVEL);

#define N CONFIG_SM_AUDIO_BLOCK_SAMPLES
#define BLOCK_BYTES (N * sizeof(int16_t))
/* Blocks dropped at start while the mic and its decimation filter settle. */
#define SETTLE_BLOCKS 8
/* DC blocker pole: about 13 Hz at 16 kHz. PDM mics carry a DC offset that would bias onset energy. */
#define DC_POLE 0.995f
#define REF_PA 20e-6f

K_MEM_SLAB_DEFINE_STATIC(slab, BLOCK_BYTES, CONFIG_SM_AUDIO_BLOCKS, 4);
static struct sm_block blocks[CONFIG_SM_AUDIO_BLOCKS];

static const struct device *const dmic = DEVICE_DT_GET(DT_ALIAS(dmic0));

/*
 * Sample clock. The PDM clock and the kernel clock come from different crystals, and the PDM rate is
 * not exactly the nominal one, so the sample period is measured: a second-order loop tracks the local
 * time at the end of each block from the (jittery) time the block arrives.
 */
static struct {
	struct k_spinlock lock;
	double end_us;      /* filtered local time just after the last sample of the last block */
	double period_us;   /* filtered sample period */
	uint64_t end_sample; /* sample index just after the last block */
} clk;

static struct {
	struct k_spinlock lock;
	double sum_ms; /* mean square, Pa^2, summed per block */
	uint32_t nblk;
	float max_ms;
	uint32_t clips;
	uint32_t total_blocks;
} st;

static float pa_per_count;

/* Full scale is this level as a sine peak; a count is 1/32768 of it. Per-board calibration lives here. */
static void full_scale_changed(const struct sm_param *p);
SM_PARAM_DEFINE(audio, full_scale_db, float, CONFIG_SM_MIC_FULL_SCALE_DB_SPL, 80, 160, full_scale_changed,
		"sound level at digital full scale (sine peak), dB SPL: the mic calibration");

static void full_scale_changed(const struct sm_param *p)
{
	ARG_UNUSED(p);
	pa_per_count = REF_PA * powf(10.0f, sm_audio_full_scale_db / 20.0f) * sqrtf(2.0f) / 32768.0f;
}

SM_TRACE_DEFINE(audio, "mic. 1: every 32 ms block, level and peak dB SPL and clipped samples");

float sm_audio_pa_per_count(void)
{
	return pa_per_count;
}

int64_t sm_audio_sample_time_us(uint64_t sample)
{
	k_spinlock_key_t key = k_spin_lock(&clk.lock);
	double t = clk.end_us - (double)(int64_t)(clk.end_sample - sample) * clk.period_us;

	k_spin_unlock(&clk.lock, key);
	return (int64_t)t;
}

static void clock_update(uint64_t blocks_seen, int64_t arrived_us)
{
	const double a = 1.0 / 16; /* phase gain */
	const double b = a * a / 4; /* frequency gain, critically damped */

	k_spinlock_key_t key = k_spin_lock(&clk.lock);

	clk.end_sample += N;
	if (blocks_seen <= 1) {
		clk.period_us = 1e6 / CONFIG_SM_AUDIO_RATE;
		clk.end_us = (double)arrived_us;
	} else {
		double pred = clk.end_us + N * clk.period_us;
		double err = (double)arrived_us - pred;

		/* A long stall (debugger, flash write) would wreck the loop: re-seed the phase instead. */
		if (fabs(err) > 20000) {
			clk.end_us = (double)arrived_us;
		} else {
			clk.end_us = pred + a * err;
			clk.period_us += b * err / N;
		}
	}
	k_spin_unlock(&clk.lock, key);
}

static void block_stats(const int16_t *x, int64_t t0_us)
{
	float ss = 0;
	uint32_t clips = 0;
	int peak = 0;

	for (int i = 0; i < N; i++) {
		float v = x[i];

		ss += v * v;
		clips += (x[i] == INT16_MAX || x[i] == INT16_MIN);
		peak = MAX(peak, abs(x[i]));
	}
	float ms = ss / N * pa_per_count * pa_per_count;

	SM_TRACE(audio, 1, t0_us, ",\"db\":%.1f,\"peak_db\":%.1f,\"clips\":%u",
		 (double)(10.0f * log10f(ms / (REF_PA * REF_PA) + 1e-12f)),
		 (double)(20.0f * log10f(peak * pa_per_count / REF_PA + 1e-12f)), clips);

	k_spinlock_key_t key = k_spin_lock(&st.lock);

	st.sum_ms += (double)ms;
	st.nblk++;
	st.max_ms = MAX(st.max_ms, ms);
	st.clips += clips;
	st.total_blocks++;
	k_spin_unlock(&st.lock, key);
}

void sm_audio_take_stats(struct sm_audio_stats *s)
{
	k_spinlock_key_t key = k_spin_lock(&st.lock);
	double mean = st.nblk ? st.sum_ms / st.nblk : 0;

	s->level_db = 10.0f * log10f((float)mean / (REF_PA * REF_PA) + 1e-12f);
	s->max_db = 10.0f * log10f(st.max_ms / (REF_PA * REF_PA) + 1e-12f);
	s->clips = st.clips;
	s->blocks = st.total_blocks;
	st.sum_ms = 0;
	st.nblk = 0;
	st.max_ms = 0;
	st.clips = 0;
	k_spin_unlock(&st.lock, key);

	key = k_spin_lock(&clk.lock);
	s->rate_hz = clk.period_us > 0 ? (float)(1e6 / clk.period_us) : 0;
	k_spin_unlock(&clk.lock, key);
}

void sm_block_release(struct sm_block *blk)
{
	if (atomic_dec(&blk->refs) == 1) {
		k_mem_slab_free(&slab, (void *)blk->pcm);
	}
}

static void capture(void *p1, void *p2, void *p3)
{
	struct pcm_stream_cfg stream = {
		.pcm_rate = CONFIG_SM_AUDIO_RATE,
		.pcm_width = 16,
		.block_size = BLOCK_BYTES,
		.mem_slab = &slab,
	};
	struct dmic_cfg cfg = {
		.io = {
			/* MSM261D3526H1CPM: 1.0-3.25 MHz clock. */
			.min_pdm_clk_freq = 1000000,
			.max_pdm_clk_freq = 3250000,
			.min_pdm_clk_dc = 40,
			.max_pdm_clk_dc = 60,
		},
		.streams = &stream,
		.channel = {
			.req_num_streams = 1,
			.req_num_chan = 1,
		},
	};
	uint64_t seen = 0;
	float dc_x = 0, dc_y = 0;

	cfg.channel.req_chan_map_lo = dmic_build_channel_map(0, 0, PDM_CHAN_LEFT);
	int err = dmic_configure(dmic, &cfg);

	if (err == 0) {
		err = dmic_trigger(dmic, DMIC_TRIGGER_START);
	}
	if (err) {
		LOG_ERR("mic start failed: %d", err);
		return;
	}
	LOG_INF("mic running: %d Hz, %d-sample blocks", CONFIG_SM_AUDIO_RATE, N);

	for (;;) {
		void *buf;
		size_t size;

		err = dmic_read(dmic, 0, &buf, &size, 1000);
		int64_t now = sm_time_local_us();

		if (err) {
			/* The driver stops if it ever finds the pool empty. Restart it; the clock loop
			 * re-seeds on the gap. */
			LOG_ERR("mic read failed: %d, restarting the mic", err);
			dmic_trigger(dmic, DMIC_TRIGGER_STOP);
			k_msleep(10);
			err = dmic_configure(dmic, &cfg);
			if (err == 0) {
				err = dmic_trigger(dmic, DMIC_TRIGGER_START);
			}
			if (err) {
				LOG_ERR("mic restart failed: %d", err);
				k_msleep(1000);
			}
			continue;
		}
		seen++;
		clock_update(seen, now);

		int16_t *x = buf;

		/* DC blocker, in place: y = x - x[-1] + pole * y[-1]. */
		for (int i = 0; i < N; i++) {
			float v = x[i];
			float y = v - dc_x + DC_POLE * dc_y;

			dc_x = v;
			dc_y = y;
			x[i] = (int16_t)CLAMP(lrintf(y), INT16_MIN, INT16_MAX);
		}

		if (seen <= SETTLE_BLOCKS || size != BLOCK_BYTES) {
			k_mem_slab_free(&slab, buf);
			continue;
		}
		struct sm_block *blk = &blocks[((char *)buf - slab.buffer) / BLOCK_BYTES];
		k_spinlock_key_t key = k_spin_lock(&clk.lock);

		blk->pcm = x;
		blk->n = N;
		blk->first_sample = clk.end_sample - N;
		blk->sample_us = (float)clk.period_us;
		blk->t0_local_us = (int64_t)(clk.end_us - N * clk.period_us);
		k_spin_unlock(&clk.lock, key);
		block_stats(x, blk->t0_local_us);

		if (sm_detectors_dispatch(blk) == 0) {
			k_mem_slab_free(&slab, buf);
		}
	}
}

K_THREAD_STACK_DEFINE(capture_stack, 2048);
static struct k_thread capture_thread;

int sm_audio_start(void)
{
	if (!device_is_ready(dmic)) {
		LOG_ERR("mic not ready");
		return -ENODEV;
	}
	full_scale_changed(NULL);

	int err = sm_detectors_start();

	if (err) {
		return err;
	}
	/* Above every detector, so capture never waits on analysis. */
	k_thread_create(&capture_thread, capture_stack, K_THREAD_STACK_SIZEOF(capture_stack), capture, NULL,
			NULL, NULL, K_PRIO_PREEMPT(1), 0, K_NO_WAIT);
	k_thread_name_set(&capture_thread, "sm_capture");
	return 0;
}
