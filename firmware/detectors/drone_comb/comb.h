/*
 * Harmonic comb drone detector: a C port of web/src/detector/comb.ts, itself a port of
 * sim/detector/detector.py. Portable C99: no Zephyr, no malloc, no libraries beyond <math.h>, so the
 * same file builds on the node and in the host tests (firmware/tests/host).
 *
 * The node runs 1024-sample frames, 512-sample hop, 16 kHz. Input is sound pressure in Pa. Other frame
 * lengths (n_fft up to COMB_MAX_NFFT) exist for the parity fixture; they need a larger struct.
 */
#ifndef SM_COMB_H
#define SM_COMB_H

#include <stdbool.h>
#include <stdint.h>

#define COMB_FS 16000
#define COMB_NFFT 1024
#define COMB_HOP 512
#define COMB_NBINS 257     /* 0..4 kHz at 15.625 Hz */
#define COMB_NCAND 543     /* f0 = 80 * 1.005^c */
#define COMB_NHARM_MAX 16
#define COMB_INIT_FRAMES 8

/* Largest n_fft comb_init accepts. The state arrays are sized for it, so it is a build-time choice. */
#ifndef COMB_MAX_NFFT
#define COMB_MAX_NFFT 1024
#endif
#define COMB_MAX_NBINS (COMB_MAX_NFFT / 4 + 1)
/* Harmonic table entries: sum over candidates of min(16, floor(4000 / f0)). Independent of n_fft. */
#define COMB_NENTRY 6043

/*
 * Tunables: X(name, type, node default, min, max, help). This one list gives the struct fields below,
 * the node's run-time parameters "drone_comb.<name>" (drone_comb.c) and the names the host replay
 * library exposes (tests/host/smdet.c), so a tuning file means the same on the board and in replay.
 * Frame counts are in 512-sample hops (32 ms at 16 kHz) and are rescaled for other hops.
 *
 * comb_default_params() gives DEFAULT_COMB_PARAMS from comb.ts, which the parity fixture uses; the
 * node defaults here differ only in theta (NODE_COMB_PARAMS, comb.ts line 96).
 */
#define COMB_TUNABLES(X)                                                                           \
	X(theta, float, 0.10, 0.01, 2.0, "comb score that starts a track")                         \
	X(hold_ratio, float, 1.0, 0.1, 3.0, "a track holds while the score is above theta times this") \
	X(floor_up_db, float, 0.1, 0.0, 3.0, "noise floor rise per hop, dB")                        \
	X(gate_harm, int, 1, 1, 8, "a candidate needs a harmonic below this that clears the gate")  \
	X(sub_guard, bool, 1, 0, 1, "sub-harmonic takeover only while the track scores above 0")    \
	X(gap_frames, int, 0, 0, 300, "hops a dropped track is remembered for, 0 = off")           \
	X(gap_harm, int, 0, 0, 8, "re-acquire a dropped track at up to this pitch ratio")          \
	X(init_env_bins, int, 0, 0, 128, "half-width of the start-up floor envelope, bins")          \
	X(k_on, int, 6, 1, 64, "track persistence needed to turn on")                              \
	X(m_win, int, 16, 1, 128, "track persistence ceiling")                                     \
	X(hold_frames, int, 32, 1, 1000, "hops on stays after the last hit")                      \
	X(age_min, int, 62, 1, 2000, "hops a track must live before it turns on")                  \
	X(good_frac, float, 0.7, 0.0, 1.0, "share of a track's hops that must have enough harmonics") \
	X(harm_min, int, 2, 1, 16, "harmonics a hit needs")

#define COMB_X_FIELD(_n, _t, _d, _lo, _hi, _h) _t _n;
struct comb_params {
	COMB_TUNABLES(COMB_X_FIELD)
	int n_fft;          /* frame length, a power of two in [256, COMB_MAX_NFFT] */
	int hop;            /* samples between frames, 1..n_fft */
};
#undef COMB_X_FIELD

struct comb_out {
	bool on;          /* detection on */
	bool tracking;    /* q > 0 */
	float f0_hz;      /* fine f0 while on, grid f0 while tracking, else 0 */
	float score;
	int nharm;
	float peak;       /* best candidate score this frame */
	float band_db;    /* dB SPL in the harmonic band */
	float floor_db;
	int q;            /* tracker persistence, for parity tests */
	int index;        /* tracked candidate, -1 if none */
};

/* Fields are private to comb.c. At COMB_MAX_NFFT 1024 this is 68680 bytes: about 30 KB of harmonic tables,
 * 8 KB of window and twiddles, and the rest state and scratch. */
struct comb {
	/* resolved by comb_init from struct comb_params, for the frame length and hop */
	int nfft, hop, nb, grid, lo_bin, track_step;
	int k_on, m_win, hold_frames, age_min, impulse_hold, gap_frames, init_env_bins, init_frames;
	int gate_harm, gap_harm, harm_min;
	double good_frac;
	bool sub_guard, started, floor_ready, on, has_dormant;
	double theta, hold_ratio, smooth, floor_up, floor_down;
	double df;
	float bb_prev, inv_df;
	double f0_grid[COMB_NCAND];  /* candidate frequencies, comb.ts line 195 */
	float scale;                /* 2 / (n * sum(hann^2)) */
	/* geometry */
	float hann[COMB_MAX_NFFT];
	float tw_re[COMB_MAX_NFFT / 2], tw_im[COMB_MAX_NFFT / 2];
	uint8_t nh[COMB_NCAND];
	uint16_t off[COMB_NCAND + 1];
	int16_t sub[COMB_NCAND][4];  /* sub[c][d - 1]: candidate at f0 / d, or -1 */
	int16_t lo[COMB_NENTRY];
	uint8_t width[COMB_NENTRY];   /* hi1 - lo */
	uint8_t fl[COMB_NENTRY];
	/* per frame */
	float re[COMB_MAX_NFFT], im[COMB_MAX_NFFT];
	float power[COMB_MAX_NBINS];
	float level[COMB_MAX_NBINS];
	float w[COMB_MAX_NBINS];
	float s[COMB_NCAND];
	/* state carried between frames */
	double ps[COMB_MAX_NBINS];
	double floor[COMB_MAX_NBINS];
	float init_level[COMB_INIT_FRAMES][COMB_MAX_NBINS];
	int init_count;
	int impulse_left;
	int t, q, index, age, good, last_hit;
	int d_index, d_age, d_good, d_last_hit;
	/* last outputs, held between frames that do not produce new ones */
	double f0_hz;
	int nharm;
	float score, peak, band_db, floor_db;
};

/* comb.ts DEFAULT_COMB_PARAMS (the parity fixture's base). */
void comb_default_params(struct comb_params *p);
/* The node defaults from COMB_TUNABLES, 1024-sample frames, 512 hop. */
void comb_node_params(struct comb_params *p);

/* Builds the frame's geometry tables and resets the state. Returns 0, or -1 for unsupported params. */
int comb_init(struct comb *c, const struct comb_params *p);

/* Steps one frame of n_fft samples (Pa; COMB_NFFT by default). Call every hop samples. */
void comb_step(struct comb *c, const float frame[COMB_NFFT], struct comb_out *out);

#endif
