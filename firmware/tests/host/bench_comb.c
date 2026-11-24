/*
 * Timing and work counts for comb_step with the node parameters, over 20 s of drone_600_fading and 20 s of
 * noise (signals.c). Prints the best of three runs as mean microseconds per frame, and per frame the counts
 * from comb.c (built with -DCOMB_STATS): candidates entered, candidates fully scored, and log10 calls.
 *
 * Usage: bench_comb [seconds]   (built by `make bench` in firmware/tests/host; not part of `make test`)
 */
#include "comb.h"
#include "signals.h"

#include <stdio.h>
#include <stdlib.h>
#include <time.h>

extern unsigned long comb_stat_frames, comb_stat_cands, comb_stat_full;
extern unsigned long comb_stat_log_level, comb_stat_log_score, comb_stat_log_fine;

#define REPS 3

static double now_us(void)
{
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return ts.tv_sec * 1e6 + ts.tv_nsec / 1e3;
}

struct result {
	double us_per_frame;
	long frames;
	double cands, full, log_level, log_score, log_fine;
};

static void reset_stats(void)
{
	comb_stat_frames = comb_stat_cands = comb_stat_full = 0;
	comb_stat_log_level = comb_stat_log_score = comb_stat_log_fine = 0;
}

static struct result bench(const char *name, int seconds)
{
	const float *x = NULL;
	int n = 0, start, rep;
	struct comb_params p;
	struct result best = {0};
	static struct comb c;
	struct comb_out out;

	if (!signal_make(name, seconds, &x, &n)) {
		fprintf(stderr, "unknown signal %s\n", name);
		exit(2);
	}
	best.us_per_frame = 1e30;
	for (rep = 0; rep < REPS; rep++) {
		double t_sum = 0.0;
		long frames = 0;

		comb_node_params(&p);
		if (comb_init(&c, &p) != 0) {
			fprintf(stderr, "comb_init failed\n");
			exit(2);
		}
		reset_stats();
		for (start = 0; start + COMB_NFFT <= n; start += COMB_HOP) {
			const double t0 = now_us();
			comb_step(&c, x + start, &out);
			t_sum += now_us() - t0;
			frames++;
		}
		{
			const double us = t_sum / (double)frames;
			if (us < best.us_per_frame) {
				best.us_per_frame = us;
				best.frames = frames;
				best.cands = (double)comb_stat_cands / frames;
				best.full = (double)comb_stat_full / frames;
				best.log_level = (double)comb_stat_log_level / frames;
				best.log_score = (double)comb_stat_log_score / frames;
				best.log_fine = (double)comb_stat_log_fine / frames;
			}
		}
	}
	return best;
}

int main(int argc, char **argv)
{
	const int seconds = argc > 1 ? atoi(argv[1]) : 20;
	const char *names[] = {"drone_600_fading", "noise"};
	size_t i;

	for (i = 0; i < sizeof names / sizeof names[0]; i++) {
		const struct result r = bench(names[i], seconds);
		printf("%-17s %ld frames  %8.1f us/frame (best of %d)\n", names[i], r.frames, r.us_per_frame, REPS);
		printf("%-17s per frame: candidates entered %.1f, fully scored %.1f, log10f level %.1f, "
		       "log10f score %.1f, log10 fine %.1f\n",
		       "", r.cands, r.full, r.log_level, r.log_score, r.log_fine);
	}
	return 0;
}
