/*
 * Gunshot onset detector: a C port of web/src/detector/impulse.ts. Portable C99.
 *
 * Mean-square power in 1 ms windows (16 samples at 16 kHz). An onset is a window ratio_db above the
 * louder of a slow background and a short recent peak, and above min_db SPL. After an onset the test
 * holds for hold_ms so the crack itself does not start another. The defaults are ASSUMED (not tuned
 * on recordings); see docs/gunshots.md.
 */
#ifndef SM_IMPULSE_H
#define SM_IMPULSE_H

#include <stdbool.h>

#define IMPULSE_WIN 16
#define IMPULSE_WIN_MS 1.0f /* at 16 kHz */

/*
 * Tunables: X(name, type, default, min, max, help). The same list gives the node's run-time
 * parameters "gunshot.<name>" and the host replay library's names (see comb.h).
 */
#define IMPULSE_TUNABLES(X)                                                                        \
	X(ratio_db, float, 12.0412, 3.0, 40.0, "onset: window over the background and recent peak, dB") \
	X(min_db, float, 60.0, 20.0, 130.0, "onset: window level at least this, dB SPL")             \
	X(bg_tau_ms, float, 999.5, 10.0, 60000.0, "background time constant, ms")                   \
	X(learn_db, float, 10.0, 0.0, 40.0, "background learns only from windows within this, dB")   \
	X(recent_tau_ms, float, 5.0, 0.5, 200.0, "recent-peak decay time constant, ms")              \
	X(hold_ms, int, 50, 1, 1000, "after an onset, no new onset for this long, ms")

#define IMPULSE_X_FIELD(_n, _t, _d, _lo, _hi, _h) _t _n;
struct impulse_params {
	IMPULSE_TUNABLES(IMPULSE_X_FIELD)
};
#undef IMPULSE_X_FIELD

struct impulse {
	/* resolved from impulse_params */
	float ratio, min_power, bg_alpha, learn_ratio, recent_decay;
	int hold_windows;
	/* state */
	float background; /* Pa^2 */
	float recent;     /* Pa^2 */
	bool primed;
	int hold;
};

struct impulse_window {
	bool onset;
	float power; /* mean square of this window, Pa^2 */
	float floor; /* level it was compared with, Pa^2 */
};

void impulse_default_params(struct impulse_params *p);

void impulse_init(struct impulse *d, const struct impulse_params *p);

/* Steps one window of IMPULSE_WIN samples in Pa. */
void impulse_step(struct impulse *d, const float x[IMPULSE_WIN], struct impulse_window *out);

#endif
