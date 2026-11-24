/*
 * Audio capture. One thread reads the PDM mic in blocks and hands each block to every detector. The
 * block's buffer is shared, read-only, and returns to the pool when the last detector releases it.
 */
#ifndef SONICMESH_AUDIO_H
#define SONICMESH_AUDIO_H

#include <stdint.h>
#include <zephyr/sys/atomic.h>

struct sm_block {
	const int16_t *pcm;    /* samples */
	uint16_t n;            /* sample count, CONFIG_SM_AUDIO_BLOCK_SAMPLES */
	uint64_t first_sample; /* index of pcm[0] since capture started */
	int64_t t0_local_us;   /* local time of pcm[0] */
	float sample_us;       /* measured sample period */
	atomic_t refs;
};

/* Local time of sample i of a block. */
static inline int64_t sm_block_time_us(const struct sm_block *b, uint32_t i)
{
	return b->t0_local_us + (int64_t)(i * b->sample_us);
}

/* Pascals per count, from CONFIG_SM_MIC_FULL_SCALE_DB_SPL. */
float sm_audio_pa_per_count(void);

/* Local time of any sample index, from the current clock fit. */
int64_t sm_audio_sample_time_us(uint64_t sample);

/* Starts capture and the detectors. */
int sm_audio_start(void);

struct sm_audio_stats {
	float level_db;  /* mean level since the last call, dB SPL */
	float max_db;    /* loudest block since the last call */
	uint32_t clips;  /* full-scale samples since the last call */
	uint32_t blocks; /* blocks captured since boot */
	float rate_hz;   /* measured sample rate */
};

/* Returns and resets the period stats. */
void sm_audio_take_stats(struct sm_audio_stats *s);

#endif
