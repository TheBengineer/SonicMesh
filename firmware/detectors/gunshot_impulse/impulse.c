#include <math.h>
#include <string.h>

#include "impulse.h"

#define REF_PA 20e-6f

void impulse_default_params(struct impulse_params *p)
{
#define IMPULSE_X_DEFAULT(_n, _t, _d, _lo, _hi, _h) p->_n = (_t)(_d);
	IMPULSE_TUNABLES(IMPULSE_X_DEFAULT)
#undef IMPULSE_X_DEFAULT
}

static float db_to_power(float db)
{
	return powf(10.0f, db / 10.0f);
}

void impulse_init(struct impulse *d, const struct impulse_params *p)
{
	memset(d, 0, sizeof(*d));
	/* Defaults reproduce impulse.ts: ratio 16, 4e-4 Pa^2, alpha 0.001, learn 10, decay exp(-1/5). */
	d->ratio = db_to_power(p->ratio_db);
	d->min_power = REF_PA * REF_PA * db_to_power(p->min_db);
	d->bg_alpha = 1.0f - expf(-IMPULSE_WIN_MS / p->bg_tau_ms);
	d->learn_ratio = db_to_power(p->learn_db);
	d->recent_decay = expf(-IMPULSE_WIN_MS / p->recent_tau_ms);
	d->hold_windows = (int)lrintf(p->hold_ms / IMPULSE_WIN_MS);
}

void impulse_step(struct impulse *d, const float x[IMPULSE_WIN], struct impulse_window *out)
{
	float e = 0;

	for (int i = 0; i < IMPULSE_WIN; i++) {
		e += x[i] * x[i];
	}
	e /= IMPULSE_WIN;
	if (!d->primed) {
		d->background = e;
		d->primed = true;
	}
	float floor = d->background > d->recent ? d->background : d->recent;

	out->onset = false;
	out->power = e;
	out->floor = floor;
	if (d->hold > 0) {
		d->hold--;
	} else if (e > d->ratio * floor && e > d->min_power) {
		out->onset = true;
		d->hold = d->hold_windows;
	} else if (e < d->learn_ratio * d->background) {
		d->background += d->bg_alpha * (e - d->background);
	}
	float decayed = d->recent * d->recent_decay;

	d->recent = e > decayed ? e : decayed;
}
