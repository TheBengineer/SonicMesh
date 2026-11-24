/*
 * Host replay library: the node's detector C code as a shared library, for tools/smtool to run on WAV
 * files much faster than real time. Built by `make -C tests/host lib` into build/libsmdet.so.
 *
 * Parameters use the names and defaults the node uses ("theta", not "drone_comb.theta"), generated
 * from the same COMB_TUNABLES and IMPULSE_TUNABLES lists, so a tuning file means the same here and on
 * a board. Only the portable detector cores are here; the glue that turns their outputs into records
 * (detectors/<name>/<name>.c) is mirrored in tools/smtool/replay.py.
 *
 * Input is sound pressure in Pa at 16 kHz, as the node feeds its detectors.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "comb.h"
#include "impulse.h"

#define API __attribute__((visibility("default")))

static void put_json(char *buf, size_t cap, size_t *len, const char *name, const char *type, double def,
		     double lo, double hi, const char *help)
{
	*len += (size_t)snprintf(buf + *len, cap - *len,
				 "%s{\"n\":\"%s\",\"type\":\"%s\",\"def\":%.7g,\"min\":%.7g,\"max\":%.7g,\"help\":\"%s\"}",
				 *len > 1 ? "," : "", name, type, def, lo, hi, help);
}

#define X_JSON(_n, _t, _d, _lo, _hi, _h) put_json(buf, sizeof(buf), &len, #_n, #_t, _d, _lo, _hi, _h);

#define X_SET(_n, _t, _d, _lo, _hi, _h)                                                            \
	if (strcmp(name, #_n) == 0) {                                                              \
		if (v < (_lo) || v > (_hi)) return -2;                                             \
		p->_n = (_t)v;                                                                     \
		return 0;                                                                          \
	}

#define X_GET(_n, _t, _d, _lo, _hi, _h)                                                            \
	if (strcmp(name, #_n) == 0) {                                                              \
		*v = (double)p->_n;                                                                \
		return 0;                                                                          \
	}

/* ---- drone comb ---- */

struct smd_comb {
	struct comb_params p;
	struct comb c;
};

API const char *smd_comb_params(void)
{
	static char buf[8192];
	size_t len = 0;

	buf[len++] = '[';
	buf[len] = 0;
	COMB_TUNABLES(X_JSON)
	snprintf(buf + len, sizeof(buf) - len, "]");
	return buf;
}

API int smd_comb_frame_len(void) { return COMB_NFFT; }
API int smd_comb_hop(void) { return COMB_HOP; }

/* New comb with the node defaults; not started until smd_comb_reset. */
API struct smd_comb *smd_comb_new(void)
{
	struct smd_comb *h = calloc(1, sizeof(*h));

	if (h) comb_node_params(&h->p);
	return h;
}

/* 0, -1 unknown name, -2 out of range. Takes effect at the next smd_comb_reset. */
API int smd_comb_set(struct smd_comb *h, const char *name, double v)
{
	struct comb_params *p = &h->p;

	COMB_TUNABLES(X_SET)
	return -1;
}

API int smd_comb_get(struct smd_comb *h, const char *name, double *v)
{
	struct comb_params *p = &h->p;

	COMB_TUNABLES(X_GET)
	return -1;
}

API int smd_comb_reset(struct smd_comb *h) { return comb_init(&h->c, &h->p); }

#define COMB_OUT_N 9

/*
 * Steps every whole frame of x (n samples): frames start at 0, hop, 2 hop, ... Writes COMB_OUT_N
 * doubles per frame to out: on, tracking, f0_hz, score, peak, nharm, band_db, floor_db, q. Returns
 * the frame count. State carries over between calls only if each call's x starts where the previous
 * frame left off, so feed the whole recording in one call, or overlapping chunks.
 */
API int smd_comb_run(struct smd_comb *h, const float *x, long n, double *out)
{
	int frames = 0;

	for (long s = 0; s + COMB_NFFT <= n; s += COMB_HOP, frames++) {
		struct comb_out o;
		double *r = &out[(size_t)frames * COMB_OUT_N];

		comb_step(&h->c, &x[s], &o);
		r[0] = o.on;
		r[1] = o.tracking;
		r[2] = o.f0_hz;
		r[3] = o.score;
		r[4] = o.peak;
		r[5] = o.nharm;
		r[6] = o.band_db;
		r[7] = o.floor_db;
		r[8] = o.q;
	}
	return frames;
}

/* ---- gunshot onset ---- */

struct smd_impulse {
	struct impulse_params p;
	struct impulse d;
};

API const char *smd_impulse_params(void)
{
	static char buf[4096];
	size_t len = 0;

	buf[len++] = '[';
	buf[len] = 0;
	IMPULSE_TUNABLES(X_JSON)
	snprintf(buf + len, sizeof(buf) - len, "]");
	return buf;
}

API int smd_impulse_win(void) { return IMPULSE_WIN; }

API struct smd_impulse *smd_impulse_new(void)
{
	struct smd_impulse *h = calloc(1, sizeof(*h));

	if (h) impulse_default_params(&h->p);
	return h;
}

API int smd_impulse_set(struct smd_impulse *h, const char *name, double v)
{
	struct impulse_params *p = &h->p;

	IMPULSE_TUNABLES(X_SET)
	return -1;
}

API int smd_impulse_get(struct smd_impulse *h, const char *name, double *v)
{
	struct impulse_params *p = &h->p;

	IMPULSE_TUNABLES(X_GET)
	return -1;
}

API void smd_impulse_reset(struct smd_impulse *h) { impulse_init(&h->d, &h->p); }

/* Hold length in windows, after smd_impulse_reset (the glue uses it to close a shot). */
API int smd_impulse_hold_windows(struct smd_impulse *h) { return h->d.hold_windows; }

/*
 * Steps every whole window of x. Per window writes onset (0/1), power and floor (Pa^2) to the three
 * arrays. Returns the window count. State carries over between calls.
 */
API long smd_impulse_run(struct smd_impulse *h, const float *x, long n, unsigned char *onset, float *power,
			 float *floor_)
{
	long w = 0;

	for (long s = 0; s + IMPULSE_WIN <= n; s += IMPULSE_WIN, w++) {
		struct impulse_window o;

		impulse_step(&h->d, &x[s], &o);
		onset[w] = o.onset;
		power[w] = o.power;
		floor_[w] = o.floor;
	}
	return w;
}

API void smd_free(void *h) { free(h); }
