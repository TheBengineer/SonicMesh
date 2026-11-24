/*
 * Deploy tone decoder: 8-FSK frames as described in docs/deploy-tones.md. Portable C99, no Zephyr.
 * deploy_tones.c feeds it audio and sends the reports; tools/smtool/tones.py follows the same rules.
 */
#ifndef SM_TONES_H
#define SM_TONES_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define TONES_RATE 16000
#define TONES_N 8          /* tones, 1500 + 250 k Hz */
#define TONES_WIN 256      /* analysis window, samples (Hann) */
#define TONES_HOP 128      /* samples between windows */
#define TONES_HOPS 72      /* hops of history: one frame */
#define TONES_SYM_HOPS 6   /* hops per symbol */
#define TONES_SYMS 12      /* symbols per frame */
#define TONES_RECENT 4     /* words remembered for repeat suppression */
#define TONES_CAND_HOPS 6  /* a passing test starts a candidate window of this many hops */

/* A frame that passed every test. start is the sample index of the frame's first hop. */
struct tones_report {
	uint16_t word;
	uint64_t start;
	float level_dbfs;  /* mean tone level, dB relative to a full-scale sine */
	float ratio_db;    /* least dominance over the 12 symbols, dB */
};

/* Every frame that passed the preamble, for tracing. */
struct tones_frame {
	uint64_t start;
	uint16_t word;
	bool crc_ok;
	bool dominant;
	float ratio_db;
};

struct tones {
	/* Settings. tones_init clears the struct, so set on_frame after it. */
	float ratio;             /* least dominance, linear */
	uint64_t repeat_samples; /* repeat suppression window */
	void (*on_frame)(void *ctx, const struct tones_frame *f);
	void *ctx;

	/* Audio stream. */
	uint64_t next;   /* sample index expected next */
	uint32_t filled; /* samples in ring, up to TONES_WIN */
	uint32_t pos;    /* ring index of the oldest sample */
	float ring[TONES_WIN];
	float win[TONES_WIN];
	float coef[TONES_N]; /* 2 cos(2 pi f / rate) */
	float xw[TONES_WIN]; /* scratch: the windowed samples */

	/* Hop history: power per tone, indexed by hop % TONES_HOPS. */
	float hist[TONES_HOPS][TONES_N];
	uint32_t nhist; /* hops held, up to TONES_HOPS */
	uint32_t skip;  /* hops to ignore after a reported frame */
	uint32_t pending;       /* hops left in the candidate window, 0 if none */
	uint64_t best_hop;      /* hop of the best candidate so far */
	float best_dom;         /* its least dominance, linear */
	struct tones_report best;

	/* Recent reports, for repeat suppression. */
	uint16_t recent_word[TONES_RECENT];
	uint64_t recent_start[TONES_RECENT];
	uint32_t nrecent, recent_next;
};

/* Clears the decoder. min_ratio_db: least dominance per symbol. repeat_ms: same word within this
 * time of its last report is not reported again. */
void tones_init(struct tones *t, float min_ratio_db, float repeat_ms);

/*
 * Feeds n samples whose first one has index first_sample (a gap restarts the history). Writes up to
 * max reports to out and returns how many. A block of 512 samples gives at most one report.
 */
int tones_feed(struct tones *t, const int16_t *x, size_t n, uint64_t first_sample,
	       struct tones_report *out, int max);

/* CRC-8/SMBUS (polynomial 0x07, initial 0, no reflection, no final XOR). */
uint8_t tones_crc8(const uint8_t *p, size_t n);

#endif
