/*
 * Deploy tone decoder, the algorithm of docs/deploy-tones.md. Portable C99, no Zephyr.
 *
 * Audio is cut into 256-sample Hann windows at hop 128. Window starts sit on a fixed grid of the
 * sample index, so every window is a whole hop and a frame starts on a hop boundary. Each window is
 * measured on the 8 tone frequencies with the Goertzel recursion, and the last 72 hops are kept. At
 * every hop the frame test runs over those 72 hops: a frame is 12 symbols of 6 hops, and each symbol
 * is decided from its middle four hops.
 *
 * The first passing test is usually a few hops early, so a passing test opens a candidate window of
 * six tests. The one with the highest least dominance (the earliest on a tie) is reported, with its
 * hop 0 as the frame start.
 */
#include <math.h>
#include <string.h>

#include "tones.h"

#define TWO_PI 6.28318530718f
/* Hann window of 256 samples sums to 128; a full-scale sine on a tone bin then has magnitude 64, so
 * (2 / 128)^2 scales its power to 1. */
#define POWER_SCALE (1.0f / 4096.0f)
#define MID_HOPS 4 /* hops of a symbol used for its decision */
#define SKIP_HOPS (TONES_HOPS - 1)
#define DATA_FIRST 4 /* symbols 0..3 are the preamble */
#define BIG 1e30f

static const uint8_t preamble[DATA_FIRST] = {0, 7, 0, 7};

uint8_t tones_crc8(const uint8_t *p, size_t n)
{
	uint8_t crc = 0;

	for (size_t i = 0; i < n; i++) {
		crc ^= p[i];
		for (int b = 0; b < 8; b++) {
			crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x07) : (uint8_t)(crc << 1);
		}
	}
	return crc;
}

void tones_init(struct tones *t, float min_ratio_db, float repeat_ms)
{
	memset(t, 0, sizeof(*t));
	t->ratio = powf(10.0f, min_ratio_db / 10.0f);
	t->repeat_samples = (uint64_t)(repeat_ms * (TONES_RATE / 1000.0f));
	for (int n = 0; n < TONES_WIN; n++) {
		t->win[n] = 0.5f - 0.5f * cosf(TWO_PI * (float)n / TONES_WIN);
	}
	for (int k = 0; k < TONES_N; k++) {
		float f = 1500.0f + 250.0f * (float)k;

		t->coef[k] = 2.0f * cosf(TWO_PI * f / TONES_RATE);
	}
}

/* Power of the window that ends at the newest sample, on each tone, into hop % TONES_HOPS. */
static void hop_power(struct tones *t, uint64_t hop)
{
	for (uint32_t n = 0; n < TONES_WIN; n++) {
		t->xw[n] = t->ring[(t->pos + n) % TONES_WIN] * t->win[n];
	}
	float *e = t->hist[hop % TONES_HOPS];

	for (int k = 0; k < TONES_N; k++) {
		float c = t->coef[k], s1 = 0, s2 = 0;

		for (uint32_t n = 0; n < TONES_WIN; n++) {
			float s0 = t->xw[n] + c * s1 - s2;

			s2 = s1;
			s1 = s0;
		}
		float p = s1 * s1 + s2 * s2 - c * s1 * s2;

		e[k] = p > 0 ? p * POWER_SCALE : 0;
	}
	if (t->nhist < TONES_HOPS) {
		t->nhist++;
	}
}

static bool is_repeat(const struct tones *t, uint16_t word, uint64_t start)
{
	for (uint32_t i = 0; i < t->nrecent; i++) {
		if (t->recent_word[i] == word && start >= t->recent_start[i] &&
		    start - t->recent_start[i] < t->repeat_samples) {
			return true;
		}
	}
	return false;
}

static void remember(struct tones *t, uint16_t word, uint64_t start)
{
	for (uint32_t i = 0; i < t->nrecent; i++) {
		if (t->recent_word[i] == word) {
			t->recent_start[i] = start;
			return;
		}
	}
	uint32_t slot;

	if (t->nrecent < TONES_RECENT) {
		slot = t->nrecent++;
	} else {
		slot = t->recent_next;
		t->recent_next = (t->recent_next + 1) % TONES_RECENT;
	}
	t->recent_word[slot] = word;
	t->recent_start[slot] = start;
}

/*
 * The frame test over the 72 hops ending at newest. Returns true if the preamble, the dominance of
 * every symbol and the CRC all pass, with the frame in *out and its least dominance (linear) in *dom.
 */
static bool frame_pass(struct tones *t, uint64_t newest, struct tones_report *out, float *dom)
{
	uint64_t h0 = newest + 1 - TONES_HOPS;
	uint8_t sym[TONES_SYMS];
	float rmin = BIG, level = 0;

	for (int i = 0; i < TONES_SYMS; i++) {
		uint64_t base = h0 + (uint64_t)i * TONES_SYM_HOPS;
		float s[TONES_N];
		float smax, total = 0;
		int d = 0;

		memset(s, 0, sizeof(s));
		for (uint64_t j = 1; j <= MID_HOPS; j++) {
			const float *e = t->hist[(base + j) % TONES_HOPS];

			for (int k = 0; k < TONES_N; k++) {
				s[k] += e[k];
			}
		}
		smax = s[0];
		for (int k = 0; k < TONES_N; k++) {
			total += s[k];
			if (s[k] > smax) {
				smax = s[k];
				d = k;
			}
		}
		/* Mean of the other seven tones; silence gives a ratio of 0. */
		float others = (total - smax) / (TONES_N - 1);
		float r = 0;

		if (smax > 0) {
			r = others > 1e-30f ? smax / others : BIG;
		}
		sym[i] = (uint8_t)d;
		level += smax;
		if (r < rmin) {
			rmin = r;
		}
	}

	for (int i = 0; i < DATA_FIRST; i++) {
		if (sym[i] != preamble[i]) {
			return false;
		}
	}

	uint32_t v = 0;

	for (int i = DATA_FIRST; i < TONES_SYMS; i++) {
		v = (v << 3) | sym[i];
	}
	uint16_t word = (uint16_t)(v >> 8);
	uint8_t bytes[2] = {(uint8_t)(word >> 8), (uint8_t)word};
	bool crc_ok = tones_crc8(bytes, 2) == (uint8_t)(v & 0xFF);
	bool dominant = rmin >= t->ratio;
	uint64_t start = h0 * TONES_HOP;
	float ratio_db = 10.0f * log10f(rmin > 0 ? rmin : 1e-30f);

	if (t->on_frame) {
		struct tones_frame f = {.start = start, .word = word, .crc_ok = crc_ok,
					.dominant = dominant, .ratio_db = ratio_db};

		t->on_frame(t->ctx, &f);
	}
	if (!crc_ok || !dominant) {
		return false;
	}
	out->word = word;
	out->start = start;
	out->level_dbfs = 10.0f * log10f(level / (TONES_SYMS * MID_HOPS) + 1e-12f);
	out->ratio_db = ratio_db;
	*dom = rmin;
	return true;
}

/* Ends a candidate window: reports the best candidate unless it is a repeat, then ignores tests
 * until 71 hops after the chosen hop. Returns 1 if a report was written to out. */
static int finish_candidate(struct tones *t, uint64_t newest, struct tones_report *out)
{
	int got = 0;

	if (!is_repeat(t, t->best.word, t->best.start)) {
		remember(t, t->best.word, t->best.start);
		*out = t->best;
		got = 1;
	}
	t->skip = 0;
	if (t->best_hop + SKIP_HOPS > newest) {
		t->skip = (uint32_t)(t->best_hop + SKIP_HOPS - newest);
	}
	return got;
}

static void reset_stream(struct tones *t, uint64_t first_sample)
{
	t->next = first_sample;
	t->filled = 0;
	t->pos = 0;
	t->nhist = 0;
	t->skip = 0;
	t->pending = 0;
}

int tones_feed(struct tones *t, const int16_t *x, size_t n, uint64_t first_sample,
	       struct tones_report *out, int max)
{
	int nout = 0;

	if (first_sample != t->next) {
		reset_stream(t, first_sample);
	}
	for (size_t i = 0; i < n; i++) {
		t->ring[t->pos] = x[i] * (1.0f / 32768.0f);
		t->pos = (t->pos + 1) % TONES_WIN;
		if (t->filled < TONES_WIN) {
			t->filled++;
		}
		t->next++;
		if (t->filled < TONES_WIN || t->next % TONES_HOP != 0) {
			continue;
		}
		/* The window that ends at the newest sample starts at next - 256, on the hop grid. */
		uint64_t hop = (t->next - TONES_WIN) / TONES_HOP;

		hop_power(t, hop);
		if (t->nhist < TONES_HOPS) {
			continue;
		}
		if (t->pending == 0 && t->skip > 0) {
			t->skip--;
			continue;
		}

		struct tones_report cand;
		float dom = 0;
		bool ok = frame_pass(t, hop, &cand, &dom);

		if (t->pending == 0) {
			if (ok) {
				t->pending = TONES_CAND_HOPS - 1;
				t->best = cand;
				t->best_dom = dom;
				t->best_hop = hop;
			}
			continue;
		}
		if (ok && dom > t->best_dom) {
			t->best = cand;
			t->best_dom = dom;
			t->best_hop = hop;
		}
		if (--t->pending == 0 && nout < max) {
			nout += finish_candidate(t, hop, &out[nout]);
		}
	}
	return nout;
}
