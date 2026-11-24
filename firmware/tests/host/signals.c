/*
 * Test signals, as comb.test.ts builds them. See signals.h.
 */
#include "signals.h"

#include <math.h>
#include <stdint.h>
#include <string.h>

#define PI_D 3.14159265358979323846
#define AMBIENT_PA (20e-6 * 100.0) /* 20e-6 * 10 ** (40 / 20) */
#define MAX_SAMPLES (32 * SIG_FS)

static double sig_d[MAX_SAMPLES];
static float sig_f[MAX_SAMPLES];

/* The same LCG noise as comb.test.ts noise(), through one pole. */
static void noise(int n, uint32_t seed)
{
	uint32_t state = seed;
	double y = 0.0;
	int i;
	for (i = 0; i < n; i++) {
		state = state * 1664525u + 1013904223u;
		y = 0.9 * y + ((double)state / 4294967296.0 - 0.5);
		sig_d[i] = y * AMBIENT_PA * 6;
	}
}

/* comb.test.ts addHarmonics(). The gain falls linearly to zero over the signal when fade is set. */
static void add_harmonics(int n, int seconds, double f0, double amp, int count, double drift, int fade)
{
	int i, k;
	for (i = 0; i < n; i++) {
		const double t = (double)i / SIG_FS;
		double phase, v = 0.0, gain;
		if (t < 2 || t >= 12) continue;
		phase = 2.0 * PI_D * f0 * (t + (drift * t * t) / (2.0 * seconds));
		for (k = 1; k <= count; k++) v += (sqrt(2.0) * amp * sin(k * phase)) / k;
		gain = fade ? 1 - t / seconds : 1.0;
		sig_d[i] += v * gain;
	}
}

bool signal_make(const char *name, int seconds, const float **samples, int *n_samples)
{
	const int n = seconds * SIG_FS;
	int i;
	if (n > MAX_SAMPLES) return false;
	noise(n, 12345u);
	if (strcmp(name, "noise") == 0) {
		/* no harmonic source */
	} else if (strcmp(name, "drone_250") == 0) {
		add_harmonics(n, seconds, 250.0, AMBIENT_PA * 2, 8, 0.02, 0);
	} else if (strcmp(name, "drone_100_weak") == 0) {
		add_harmonics(n, seconds, 100.0, AMBIENT_PA * 0.6, 12, 0.0, 0);
	} else if (strcmp(name, "drone_600_fading") == 0) {
		add_harmonics(n, seconds, 600.0, AMBIENT_PA * 1.5, 5, 0.0, 1);
	} else if (strcmp(name, "vehicle_broadband") == 0) {
		for (i = 0; i < n; i++) {
			const double u = ((double)i / SIG_FS - 7) / 3;
			sig_d[i] *= 1 + 9 * exp(-(u * u));
		}
	} else if (strcmp(name, "clicks") == 0) {
		int start, j;
		for (start = 2 * SIG_FS; start < 12 * SIG_FS; start += 11200)
			for (j = 0; j < 40; j++) sig_d[start + j] += AMBIENT_PA * 40 * exp(-j / 8.0);
	} else {
		return false;
	}
	for (i = 0; i < n; i++) sig_f[i] = (float)sig_d[i];
	*samples = sig_f;
	*n_samples = n;
	return true;
}
