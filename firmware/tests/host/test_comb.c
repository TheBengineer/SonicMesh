/*
 * Parity test: the C comb detector against sim/detector/detector.py, through the frames recorded in
 * web/tests/fixtures/comb_parity.json (converted to text by fixture_to_bin.py). Builds the same signals as
 * web/tests/comb.test.ts and checks every frame of every case with the same tolerances.
 *
 * Usage: test_comb <comb_parity.txt>
 */
#include "comb.h"
#include "signals.h"

#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>

#define MAX_FRAMES 1024

static int seconds;
static struct comb det;

struct frame_ref {
	int q, index, on;
	double f0, score, band, floor, peak;
};
static struct frame_ref refs[MAX_FRAMES];

/* Checks one frame against the reference with the tolerances of comb.test.ts. Returns true if it matches;
 * otherwise names the field and writes the values into detail. */
static bool compare(const struct comb_out *o, const struct frame_ref *r, const char **field, char *detail, size_t size)
{
	if (o->q != r->q) {
		*field = "q";
		snprintf(detail, size, "got %d want %d", o->q, r->q);
		return false;
	}
	if (o->index != r->index) {
		*field = "index";
		snprintf(detail, size, "got %d want %d", o->index, r->index);
		return false;
	}
	if ((o->on ? 1 : 0) != r->on) {
		*field = "on";
		snprintf(detail, size, "got %d want %d", o->on ? 1 : 0, r->on);
		return false;
	}
	if (fabs(o->f0_hz - r->f0) >= 1e-3) {
		*field = "f0";
		snprintf(detail, size, "got %.6f want %.6f", o->f0_hz, r->f0);
		return false;
	}
	if (fabs(o->score - r->score) >= 1e-3) {
		*field = "score";
		snprintf(detail, size, "got %.6f want %.6f", o->score, r->score);
		return false;
	}
	if (r->floor != 0) {
		if (fabs(o->band_db - r->band) >= 1e-2) {
			*field = "band";
			snprintf(detail, size, "got %.4f want %.4f", o->band_db, r->band);
			return false;
		}
		if (fabs(o->floor_db - r->floor) >= 1e-2) {
			*field = "floor";
			snprintf(detail, size, "got %.4f want %.4f", o->floor_db, r->floor);
			return false;
		}
		if (fabs(o->peak - r->peak) >= 1e-3) {
			*field = "peak";
			snprintf(detail, size, "got %.6f want %.6f", o->peak, r->peak);
			return false;
		}
	}
	return true;
}

/* Runs one case. Returns 0 on a match, 1 on a mismatch, 2 on a setup error. */
static int run_case(FILE *f, int case_no)
{
	char signal[64];
	int n_fft, hop, gate_harm, gap_frames, gap_harm, sub_guard, init_env_bins, frames;
	double floor_up, hold_ratio;
	struct comb_params p;
	struct comb_out out;
	int n_samples = 0, count = 0, i;
	int start;
	bool ok = true;
	const char *field = "";
	char detail[160] = "";
	int bad_frame = -1;
	const float *sig = NULL;

	if (fscanf(f, " CASE %63s %d %d %lf %d %d %d %d %d %lf %d", signal, &n_fft, &hop, &floor_up, &gate_harm,
	           &gap_frames, &gap_harm, &sub_guard, &init_env_bins, &hold_ratio, &frames) != 11)
		return 2;
	if (frames > MAX_FRAMES) return 2;
	for (i = 0; i < frames; i++) {
		if (fscanf(f, " %d %d %d %lf %lf %lf %lf %lf", &refs[i].q, &refs[i].index, &refs[i].on, &refs[i].f0,
		           &refs[i].score, &refs[i].band, &refs[i].floor, &refs[i].peak) != 8)
			return 2;
	}

	comb_default_params(&p);
	p.n_fft = n_fft;
	p.hop = hop;
	p.floor_up_db = (float)floor_up;
	p.gate_harm = gate_harm;
	p.gap_frames = gap_frames;
	p.gap_harm = gap_harm;
	p.sub_guard = sub_guard != 0;
	p.init_env_bins = init_env_bins;
	p.hold_ratio = (float)hold_ratio;
	if (comb_init(&det, &p) != 0) {
		printf("FAIL case %d %s: comb_init rejected the params\n", case_no, signal);
		return 1;
	}
	if (!signal_make(signal, seconds, &sig, &n_samples)) {
		printf("FAIL case %d: unknown signal %s\n", case_no, signal);
		return 2;
	}

	for (start = 0; start + n_fft <= n_samples; start += hop) {
		if (count < frames && ok) {
			comb_step(&det, sig + start, &out);
			if (!compare(&out, &refs[count], &field, detail, sizeof detail)) {
				ok = false;
				bad_frame = count;
			}
		} else {
			comb_step(&det, sig + start, &out);
		}
		count++;
	}
	if (ok && count != frames) {
		printf("FAIL case %d %s: %d frames, fixture has %d\n", case_no, signal, count, frames);
		return 1;
	}

	{
		int on_frames = 0;
		for (i = 0; i < frames; i++) on_frames += refs[i].on;
		if (ok) {
			printf("PASS case %d %-17s n_fft=%d hop=%d gap=%d/%d sub_guard=%d env=%d hold=%.2f  %d frames, %d on\n",
			       case_no, signal, n_fft, hop, gap_frames, gap_harm, sub_guard, init_env_bins, hold_ratio, frames,
			       on_frames);
			return 0;
		}
	}
	printf("FAIL case %d %-17s n_fft=%d hop=%d: frame %d field %s: %s\n", case_no, signal, n_fft, hop, bad_frame, field,
	       detail);
	return 1;
}

int main(int argc, char **argv)
{
	FILE *f;
	int case_no = 0, failed = 0, cases = 0;

	if (argc < 2) {
		fprintf(stderr, "usage: %s comb_parity.txt\n", argv[0]);
		return 2;
	}
	f = fopen(argv[1], "r");
	if (!f) {
		fprintf(stderr, "cannot open %s\n", argv[1]);
		return 2;
	}
	if (fscanf(f, " SECONDS %d", &seconds) != 1 || seconds <= 0 || seconds > 16) {
		fprintf(stderr, "bad fixture header\n");
		fclose(f);
		return 2;
	}
	for (;;) {
		int r;
		char peek;
		if (fscanf(f, " %c", &peek) != 1) break;
		ungetc(peek, f);
		r = run_case(f, case_no++);
		if (r == 2) {
			fprintf(stderr, "malformed fixture at case %d\n", case_no - 1);
			fclose(f);
			return 2;
		}
		cases++;
		if (r != 0) failed++;
	}
	fclose(f);
	printf("%d cases, %d failed\n", cases, failed);
	return failed ? 1 : 0;
}
