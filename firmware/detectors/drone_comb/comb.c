/*
 * Harmonic comb drone detector. See comb.h. Logic follows web/src/detector/comb.ts line by line; the
 * comments cite its line numbers. Only the default configuration of comb.ts is kept (useAge, useHarm and
 * useImpulse on, useSlew off), as the fixture and the node use nothing else.
 *
 * Precision: float for the per-bin work, the window and flank sums, the candidate scores and the fine f0
 * search. Double for the state that drifts over frames (smoothed power and floor, both per bin) and for the
 * harmonic-table geometry, since float32 there breaks the parity with the double-precision reference. Scores
 * sum logs in groups: products of ratios in float, one log10f per group (logsum_add).
 */
#include "comb.h"

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define REF_PA 20e-6
#define REF_HOP 512.0
#define BASE_N 1024
#define F_HARM_LIMIT 4000.0   /* comb.ts line 9 */
#define F0_MIN 80.0           /* line 10 */
#define F0_MAX 1200.0         /* line 11 */
#define F0_RATIO 1.005        /* line 12 */
#define N_HARM_MAX 16         /* line 13 */
#define TOL 0.03              /* line 14 */
#define RELATED_TOL 0.04      /* line 15 */
#define SUB_RATIO 0.85        /* line 16 */
#define GATE_RATIO 2.0f      /* line 17: log10(ratio) >= log10(2) */
#define FINE_STEPS 30         /* line 18 */
#define FINE_REL 0.001        /* line 19 */
#define INIT_MIN_FRAMES 3     /* line 20 */
#define MIN_HALF_HZ (COMB_FS / 1024.0)     /* line 21 */
#define MIN_FLANK_HZ (3.0 * COMB_FS / 1024.0) /* line 22 */
#define MAX_H 6               /* line 23 */
#define HARM_MIN 2            /* line 77 */
#define HARM_TOL 0.04         /* line 78 */
#define JUMP_DB 6.0f          /* line 80 */
#define IMPULSE_HOLD 4        /* line 81 */
#define SMOOTH 0.75           /* line 69 */
#define FLOOR_UP_DB 0.1       /* line 70 */
#define FLOOR_DOWN_DB 0.5     /* line 71 */
#define FLOOR_GATE_DB 6.0     /* line 72 */
#define K_ON 6                /* line 66 */
#define M_WIN 16              /* line 67 */
#define HOLD_FRAMES 32        /* line 68 */
#define AGE_MIN 62            /* line 74 */
#define GOOD_FRAC 0.7         /* line 75 */
#define INIT_FRAMES_DEFAULT 8 /* line 88 */
#define MAX_ENV_BINS 128      /* start-up envelope half-width limit (not in comb.ts) */
#define NO_HIT_TIME (-1000000000)
#define M_PI_D 3.14159265358979323846

/* Work counters for the host bench (tests/host/bench_comb.c). Compiled out unless COMB_STATS is defined. */
#ifdef COMB_STATS
unsigned long comb_stat_frames, comb_stat_cands, comb_stat_full;
unsigned long comb_stat_log_level, comb_stat_log_score, comb_stat_log_fine;
#define STAT(v) ((v)++)
#else
#define STAT(v) ((void)0)
#endif

static int imax(int a, int b) { return a > b ? a : b; }
static int imin(int a, int b) { return a < b ? a : b; }
static int iabs(int v) { return v < 0 ? -v : v; }
static int clampi(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

/* Frequency of candidate c, comb.ts line 195. Only used to build the table c->f0_grid. */
static double grid_f0(int c) { return F0_MIN * pow(F0_RATIO, c); }

/* Sum of log10(r) over several ratios r > 1, with one log10f per group instead of one per ratio. The product
 * is flushed to the log before it can exceed 1e30, and a ratio above 1e8 is logged alone, so the float
 * product never overflows. */
struct logsum {
	float prod;
	float total;
};

static void logsum_reset(struct logsum *s)
{
	s->prod = 1.0f;
	s->total = 0.0f;
}

/* Adds log10(r), for r > 1. Returns true if it called log10f. */
static bool logsum_add(struct logsum *s, float r)
{
	if (r > 1e8f) {
		s->total += log10f(r);
		return true;
	}
	if (s->prod > 1e30f) {
		s->total += log10f(s->prod);
		s->prod = 1.0f;
		s->prod *= r;
		return true;
	}
	s->prod *= r;
	return false;
}

/* The sum so far, with the last product logged. Returns true if it called log10f through *called. */
static float logsum_value(const struct logsum *s, bool *called)
{
	*called = s->prod > 1.0f;
	return *called ? s->total + log10f(s->prod) : s->total;
}

/* A per-frame sample count: comb.ts toFrames (lines 121-143). k is hop / REF_HOP. */
static int count_frames(double x, double k, bool floor_one)
{
	double v;
	if (x == 0) return 0;
	v = rint(x / k);
	if (floor_one && v < 1) v = 1;
	return (int)v;
}

void comb_default_params(struct comb_params *p)
{
	p->theta = 0.16f;          /* line 64 */
	p->floor_up_db = 0.1f;     /* line 70 */
	p->gate_harm = 1;          /* line 87 */
	p->sub_guard = true;       /* line 86 */
	p->hold_ratio = 1.0f;      /* line 65 */
	p->n_fft = BASE_N;         /* line 91 */
	p->hop = (int)REF_HOP;     /* line 92 */
	p->gap_frames = 0;         /* line 84 */
	p->gap_harm = 0;           /* line 85 */
	p->init_env_bins = 0;      /* line 90 */
	p->k_on = K_ON;
	p->m_win = M_WIN;
	p->hold_frames = HOLD_FRAMES;
	p->age_min = AGE_MIN;
	p->good_frac = (float)GOOD_FRAC;
	p->harm_min = HARM_MIN;
}

void comb_node_params(struct comb_params *p)
{
#define COMB_X_DEFAULT(_n, _t, _d, _lo, _hi, _h) p->_n = (_t)(_d);
	COMB_TUNABLES(COMB_X_DEFAULT)
#undef COMB_X_DEFAULT
	p->n_fft = BASE_N;
	p->hop = (int)REF_HOP;
}
/* Geometry for one frame length: comb.ts Geometry constructor, lines 167-227. */
static int build_geometry(struct comb *c)
{
	const int nfft = c->nfft;
	const double df = (double)COMB_FS / nfft;
	const int nb = (int)rint(F_HARM_LIMIT / df) + 1;
	const int lo_bin = (int)ceil(F0_MIN / df);
	const int min_half = imax(1, (int)rint(MIN_HALF_HZ / df));
	const int min_flank = imax(3, (int)rint(MIN_FLANK_HZ / df));
	int i, h, m, e = 0;

	c->df = df;
	c->inv_df = (float)(1.0 / df);
	c->nb = nb;
	c->lo_bin = lo_bin;
	c->grid = COMB_NCAND;
	if ((int)(floor(log(F0_MAX / F0_MIN) / log(F0_RATIO)) + 1) != COMB_NCAND) return -1;

	c->off[0] = 0;
	for (i = 0; i < COMB_NCAND; i++) {
		const double f0 = grid_f0(i);
		c->f0_grid[i] = f0;
		int nh = (int)floor(F_HARM_LIMIT / f0);
		nh = imin(N_HARM_MAX, nh);
		c->nh[i] = (uint8_t)nh;
		c->off[i + 1] = (uint16_t)(c->off[i] + nh);
		for (h = 1; h <= nh; h++) {
			/* comb.ts lines 199-212. Only harmonics with h <= nh are stored, so all are valid. */
			const int cb = (int)rint((f0 * h) / df);
			const int half = imax(min_half, (int)rint(TOL * cb));
			const int fl = imax(min_flank, 2 * half);
			const int lo = clampi(cb - half, lo_bin, nb);
			const int hi1 = clampi(cb + half + 1, lo_bin, nb);
			if (fl > 255 || e >= COMB_NENTRY) return -1;
			c->lo[e] = (int16_t)lo;
			c->width[e] = (uint8_t)(hi1 - lo);
			c->fl[e] = (uint8_t)fl;
			e++;
		}
	}
	if (e != COMB_NENTRY) return -1;

	/* Sub-harmonic candidates, comb.ts lines 218-225. */
	for (i = 0; i < COMB_NCAND; i++) {
		for (m = 2; m <= 4; m++) {
			const double target = grid_f0(i) / m;
			const int j = clampi((int)rint(log(target / F0_MIN) / log(F0_RATIO)), 0, COMB_NCAND - 1);
			const bool ok = fabs(grid_f0(j) / target - 1) < 0.5 * (F0_RATIO - 1) && target >= F0_MIN * 0.99;
			c->sub[i][m - 1] = (int16_t)(ok ? j : -1);
		}
	}
	return 0;
}

/* Iterative radix-2 complex FFT in place, forward sign, comb.ts fft (dsp.ts). */
static void fft(struct comb *c)
{
	const int n = c->nfft;
	float *re = c->re, *im = c->im;
	int i, j = 0, len, k;

	for (i = 1; i < n; i++) {
		int bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			float t = re[i];
			re[i] = re[j];
			re[j] = t;
			t = im[i];
			im[i] = im[j];
			im[j] = t;
		}
	}
	for (len = 2; len <= n; len <<= 1) {
		const int half = len >> 1;
		const int stride = n / len;
		for (k = 0; k < half; k++) {
			const float wr = c->tw_re[k * stride];
			const float wi = c->tw_im[k * stride];
			for (i = 0; i < n; i += len) {
				const int a = i + k;
				const int b = a + half;
				const float tr = re[b] * wr - im[b] * wi;
				const float ti = re[b] * wi + im[b] * wr;
				re[b] = re[a] - tr;
				im[b] = im[a] - ti;
				re[a] += tr;
				im[a] += ti;
			}
		}
	}
}

/* comb.ts powerOf (lines 320-330). */
static void power_of(struct comb *c, const float *x)
{
	const int n = c->nfft;
	int i, k;
	for (i = 0; i < n; i++) {
		c->re[i] = x[i] * c->hann[i];
		c->im[i] = 0.0f;
	}
	fft(c);
	for (k = 0; k < c->nb; k++) {
		const float re = c->re[k], im = c->im[k];
		c->power[k] = c->scale * (re * re + im * im);
	}
}

/* Median of n values, sorted in place (insertion sort; n <= 8 or the envelope window). comb.ts line 115. */
static double median(double *v, int n)
{
	int i, j;
	for (i = 1; i < n; i++) {
		const double x = v[i];
		for (j = i - 1; j >= 0 && v[j] > x; j--) v[j + 1] = v[j];
		v[j + 1] = x;
	}
	return (n % 2 == 1) ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
}

/* comb.ts startFloor (lines 393-412). */
static void start_floor(struct comb *c)
{
	const int nb = c->nb;
	const int nf = c->init_frames;
	double column[COMB_INIT_FRAMES];
	int k, f;

	for (k = 0; k < nb; k++) {
		for (f = 0; f < nf; f++) column[f] = c->init_level[f][k];
		c->floor[k] = median(column, nf);
	}
	if (c->init_env_bins > 0) {
		const int w = c->init_env_bins;
		double window[2 * MAX_ENV_BINS + 1];
		double env[COMB_MAX_NBINS];
		int j;
		for (k = 0; k < nb; k++) {
			for (j = -w; j <= w; j++) window[j + w] = c->floor[clampi(k + j, 0, nb - 1)];
			env[k] = median(window, 2 * w + 1);
		}
		for (k = 0; k < nb; k++) c->floor[k] = fmin(c->floor[k], env[k]);
	}
	c->floor_ready = true;
}

/* comb.ts harmonicCount (lines 414-434): harmonics 1..MAX_H whose peak stands above the flanks. */
static int harmonic_count(const struct comb *c, int cand, double tol)
{
	int count = 0;
	int h;
	for (h = 1; h <= MAX_H && h <= c->nh[cand]; h++) {
		const int o = c->off[cand] + h - 1;
		const int lo = c->lo[o];
		const int hi1 = lo + c->width[o];
		int b, k, fa, fb, size;
		float mean = 0.0f;
		if (hi1 <= lo) continue;
		b = lo;
		for (k = lo + 1; k < hi1; k++)
			if (c->w[k] > c->w[b]) b = k;
		fa = clampi(lo - c->fl[o], c->lo_bin, c->nb);
		fb = clampi(hi1 + c->fl[o], c->lo_bin, c->nb);
		size = (lo - fa) + (fb - hi1);
		if (size == 0) continue;
		for (k = fa; k < lo; k++) mean += c->w[k];
		for (k = hi1; k < fb; k++) mean += c->w[k];
		mean /= (float)size;
		if (c->w[b] < 2.0f * fmaxf(mean, 1e-30f)) continue;
		if (fabs((b * c->df) / (c->f0_grid[cand] * h) - 1) <= tol) count++;
	}
	return count;
}

/* comb.ts related (lines 109-113): whether fa/fb stand at a ratio a/b with a, b up to limit. */
static bool related(double fa, double fb, int limit)
{
	const double ratio = fmax(fa, fb) / fmin(fa, fb);
	int a, b;
	for (a = 1; a <= limit; a++)
		for (b = 1; b <= a; b++)
			if (fabs((ratio * b) / a - 1) <= RELATED_TOL) return true;
	return false;
}

/* comb.ts argmax (lines 444-448). First maximum wins. */
static int argmax(const struct comb *c, int lo, int hi)
{
	int best = lo, i;
	for (i = lo + 1; i <= hi; i++)
		if (c->s[i] > c->s[best]) best = i;
	return best;
}

/* comb.ts combOf (lines 333-391): smoothing, floor, the impulse gate, and the comb score per candidate.
 * Returns false during start-up. */
static bool comb_of(struct comb *c)
{
	const int nb = c->nb;
	const int grid = c->grid;
	int k, cand, h;
	double cur;
	float sum = 0.0f, bb;
	bool rose, jump;
	float peak = 0.0f;

	for (k = 0; k < nb; k++) {
		/* line 338: the smoothing recursion, in double (state that drifts over frames) */
		c->ps[k] = c->started ? c->smooth * c->ps[k] + (1.0 - c->smooth) * (double)c->power[k] : (double)c->power[k];
		c->level[k] = 10.0f * log10f((float)(c->ps[k] + 1e-20));
		STAT(comb_stat_log_level);
	}
	c->started = true;
	if (c->init_count < c->init_frames) {
		memcpy(c->init_level[c->init_count], c->level, (size_t)nb * sizeof(float));
		c->init_count++;
		return false;
	}
	if (!c->floor_ready) start_floor(c);

	/* lines 349-355: broadband level and the impulse gate */
	for (k = c->lo_bin; k < nb; k++) sum += c->power[k];
	bb = 10.0f * log10f(sum + 1e-20f);
	rose = bb - c->bb_prev > JUMP_DB;
	jump = rose || c->impulse_left > 0;
	c->impulse_left = rose ? c->impulse_hold : imax(0, c->impulse_left - 1);
	c->bb_prev = bb;

	/* lines 357-363: floor tracking and per-bin weights */
	for (k = 0; k < nb; k++) {
		cur = c->level[k];
		if (!jump) {
			if (cur < c->floor[k]) c->floor[k] -= c->floor_down;
			else if (cur <= c->floor[k] + FLOOR_GATE_DB) c->floor[k] += c->floor_up;
		}
		c->w[k] = k < c->lo_bin ? 0.0f : powf(10.0f, (float)((cur - c->floor[k]) / 10.0));
	}

	/* lines 368-388: the comb score of every candidate. A jump frame scores 0 everywhere (line 351). */
	if (jump) {
		memset(c->s, 0, (size_t)grid * sizeof c->s[0]);
		c->peak = 0.0f;
		return true;
	}
	for (cand = 0; cand < grid; cand++) {
		struct logsum ls;
		bool gate = false, called = false;
		const int nhc = c->nh[cand];
		const int base = c->off[cand];
		logsum_reset(&ls);
		STAT(comb_stat_cands);
		for (h = 0; h < nhc; h++) {
			/* The score is 0 unless a harmonic below gate_harm passes (lines 384 and 386), so a candidate
			 * that has not passed the gate by then is done. */
			const int o = base + h;
			if (h >= c->gate_harm && !gate) break;
			const int lo = c->lo[o];
			const int hi1 = lo + c->width[o];
			const int fa = clampi(lo - c->fl[o], c->lo_bin, nb);
			const int fb = clampi(hi1 + c->fl[o], c->lo_bin, nb);
			const int flank = (lo - fa) + (fb - hi1);
			float win = 0.0f, fl = 0.0f, ratio;
			int k;
			if (flank <= 0) continue;
			for (k = lo; k < hi1; k++) win += c->w[k];
			for (k = fa; k < lo; k++) fl += c->w[k];
			for (k = hi1; k < fb; k++) fl += c->w[k];
			win /= (float)imax(hi1 - lo, 1);
			fl /= (float)flank;
			ratio = win / fmaxf(fl, 1e-30f);
			if (ratio <= 1.0f) continue;
			if (logsum_add(&ls, ratio)) STAT(comb_stat_log_score);
			if (h < c->gate_harm && ratio >= GATE_RATIO) gate = true;
		}
		if (gate) {
			STAT(comb_stat_full);
			c->s[cand] = logsum_value(&ls, &called) / (float)nhc;
			if (called) STAT(comb_stat_log_score);
		} else {
			c->s[cand] = 0.0f;
		}
		if (c->s[cand] > peak) peak = c->s[cand];
	}
	c->peak = peak;
	return true;
}

/* comb.ts hitOk (lines 437-442) with the default useHarm. Returns whether the hit stands. */
static bool hit_ok(const struct comb *c, int cand, int *h)
{
	*h = harmonic_count(c, cand, HARM_TOL);
	return *h >= c->harm_min;
}

/* comb.ts update (lines 450-512): the track state machine. */
static void update(struct comb *c)
{
	c->t++;
	if (c->q == 0) {
		/* lines 455-476: acquire the strongest candidate above theta */
		const int best = argmax(c, 0, c->grid - 1);
		if ((double)c->s[best] >= c->theta) {
			int h = 0;
			if (hit_ok(c, best, &h)) {
				int age = 1;
				int good = h >= c->harm_min ? 1 : 0;
				if (c->gap_frames > 0 && c->has_dormant && c->t - c->d_last_hit <= c->gap_frames &&
				    (iabs(best - c->d_index) <= c->track_step || related(c->f0_grid[best], c->f0_grid[c->d_index], c->gap_harm))) {
					age = c->d_age + 1;
					good = c->d_good + (h >= c->harm_min ? 1 : 0);
				}
				c->has_dormant = false;
				c->index = best;
				c->q = 1;
				c->last_hit = c->t;
				c->age = age;
				c->good = good;
			}
		}
	} else {
		/* lines 477-494: follow the track within trackStep of its pitch */
		const int lo = imax(0, c->index - c->track_step);
		const int hi = imin(c->grid - 1, c->index + c->track_step);
		const int best = argmax(c, lo, hi);
		int h = 0;
		bool ok = false;
		if ((double)c->s[best] >= c->theta * c->hold_ratio) ok = hit_ok(c, best, &h);
		if (ok) {
			c->index = best;
			c->q = imin(c->m_win, c->q + 1);
			c->last_hit = c->t;
			c->age++;
			if (h >= c->harm_min) c->good++;
		} else {
			c->q--;
			if (c->q == 0) {
				/* a dropped track is kept for gap_frames, so a re-found one keeps its age */
				if (c->gap_frames > 0 && c->age > 0) {
					c->has_dormant = true;
					c->d_index = c->index;
					c->d_age = c->age;
					c->d_good = c->good;
					c->d_last_hit = c->last_hit;
				}
				c->index = -1;
				c->age = 0;
				c->good = 0;
			}
		}
	}
	if (c->q > 0) {
		/* lines 501-508: sub-harmonic takeover by the lowest candidate nearly as strong (divisors 4, 3, 2) */
		int d;
		for (d = 4; d >= 2; d--) {
			const int j = c->sub[c->index][d - 1];
			if ((!c->sub_guard || c->s[c->index] > 0) && j >= 0 && (double)c->s[j] >= SUB_RATIO * (double)c->s[c->index]) {
				c->index = j;
				break;
			}
		}
		/* line 509 */
		if (c->q >= c->k_on && c->age >= c->age_min && (double)c->good >= c->good_frac * c->age) c->on = true;
	}
	/* line 511 */
	if (c->on && c->t - c->last_hit > c->hold_frames) c->on = false;
}

/* comb.ts fineF0 (lines 543-570): the sub-grid f0 within 3 % of the track that best fits the weights. */
static void fine_f0(struct comb *c)
{
	const float f0 = (float)c->f0_hz;
	float best = -INFINITY, best_f = f0;
	int best_nh = 0, j;
	for (j = -FINE_STEPS; j <= FINE_STEPS; j++) {
		const float f = f0 * (1.0f + (float)FINE_REL * (float)j);
		const int nh = imin(N_HARM_MAX, (int)floorf((float)F_HARM_LIMIT / f));
		struct logsum ls;
		float score;
		int h;
		bool called;
		logsum_reset(&ls);
		for (h = 1; h <= nh; h++) {
			const float x = f * (float)h * c->inv_df;
			int i0;
			float fr, val;
			if (x >= (float)(c->nb - 1)) continue;
			i0 = (int)x;
			fr = x - (float)i0;
			val = c->w[i0] * (1.0f - fr) + c->w[i0 + 1] * fr;
			if (val > 1.0f && logsum_add(&ls, val)) STAT(comb_stat_log_fine);
		}
		score = logsum_value(&ls, &called) / (float)imax(nh, 1);
		if (called) STAT(comb_stat_log_fine);
		if (score > best) {
			best = score;
			best_f = f;
			best_nh = nh;
		}
	}
	c->f0_hz = best_f;
	c->nharm = best_nh;
}

/* comb.ts outputs (lines 514-540). */
static void outputs(struct comb *c)
{
	const int q = c->q;
	const int index = c->index;
	int k;
	float sum = 0.0f;
	double fsum = 0.0;

	c->score = q > 0 ? ((float)q / (float)c->m_win) * c->s[index] : 0.0f;
	c->f0_hz = q > 0 ? c->f0_grid[index] : 0.0;
	c->nharm = q > 0 ? c->nh[index] : 0;
	if (c->on && q > 0) fine_f0(c);

	if (c->nharm > 0) {
		const int lo = (int)ceil((0.5 * c->f0_hz) / c->df);
		const int hi = imin(c->nb - 1, (int)trunc((c->nharm * c->f0_hz) / c->df));
		for (k = lo; k <= hi; k++) {
			sum += c->power[k];
			fsum += c->floor[k];
		}
		fsum /= hi - lo + 1;
	} else {
		for (k = 0; k < c->nb; k++) {
			sum += c->power[k];
			fsum += c->floor[k];
		}
		fsum /= c->nb;
	}
	c->band_db = 10.0f * log10f(fmaxf(sum, 1e-30f) / (float)(REF_PA * REF_PA));
	c->floor_db = (float)fsum;
}

int comb_init(struct comb *c, const struct comb_params *p)
{
	const int n = p->n_fft;
	double k;
	int i;

	if (n < 256 || n > COMB_MAX_NFFT || (n & (n - 1)) != 0 || p->hop <= 0 || p->hop > n) return -1;
	if (p->init_env_bins < 0 || p->init_env_bins * n / BASE_N > MAX_ENV_BINS) return -1;

	memset(c, 0, sizeof *c);
	c->nfft = n;
	c->hop = p->hop;
	c->theta = p->theta;
	c->hold_ratio = p->hold_ratio;
	c->gate_harm = p->gate_harm;
	c->sub_guard = p->sub_guard;
	c->gap_harm = p->gap_harm;
	c->harm_min = p->harm_min;
	/* Back to the nearest double of the 6-digit value, so 0.7f compares as comb.ts's 0.7. */
	c->good_frac = rint((double)p->good_frac * 1e6) / 1e6;

	/* comb.ts toFrames (lines 121-143): time constants in hops of 512 samples */
	k = (double)p->hop / REF_HOP;
	c->smooth = pow(SMOOTH, k);
	c->floor_up = (double)p->floor_up_db * k;
	c->floor_down = FLOOR_DOWN_DB * k;
	c->k_on = count_frames(p->k_on, k, true);
	c->m_win = count_frames(p->m_win, k, true);
	c->hold_frames = count_frames(p->hold_frames, k, true);
	c->age_min = count_frames(p->age_min, k, true);
	c->impulse_hold = count_frames(IMPULSE_HOLD, k, false);
	c->gap_frames = count_frames(p->gap_frames, k, false);
	c->init_env_bins = (int)rint(p->init_env_bins * ((double)n / BASE_N));
	c->init_frames = imax(INIT_MIN_FRAMES, (int)rint(INIT_FRAMES_DEFAULT / k));
	if (c->init_frames > COMB_INIT_FRAMES) return -1;
	c->track_step = (int)rint((TOL * k) / log(F0_RATIO));

	/* Window and FFT tables (dsp.ts hann, fft): the window in double, then stored as float. */
	{
		double sq = 0.0;
		for (i = 0; i < n; i++) {
			const double w = 0.5 - 0.5 * cos((2.0 * M_PI_D * i) / n);
			c->hann[i] = (float)w;
			sq += w * w;
		}
		c->scale = (float)(2.0 / (n * sq));
	}
	for (i = 0; i < n / 2; i++) {
		const double a = (2.0 * M_PI_D * i) / n;
		c->tw_re[i] = (float)cos(a);
		c->tw_im[i] = (float)-sin(a);
	}

	if (build_geometry(c) != 0) return -1;

	c->impulse_left = 0;
	c->t = -1;
	c->q = 0;
	c->index = -1;
	c->last_hit = NO_HIT_TIME;
	c->started = false;
	c->floor_ready = false;
	return 0;
}

void comb_step(struct comb *c, const float frame[COMB_NFFT], struct comb_out *out)
{
	STAT(comb_stat_frames);
	power_of(c, frame);
	if (comb_of(c)) {
		update(c);
		outputs(c);
	}
	out->on = c->on;
	out->tracking = c->q > 0;
	out->f0_hz = (float)c->f0_hz;
	out->score = c->score;
	out->nharm = c->nharm;
	out->peak = c->peak;
	out->band_db = c->band_db;
	out->floor_db = c->floor_db;
	out->q = c->q;
	out->index = c->index;
}
