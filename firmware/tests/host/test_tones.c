/*
 * Host test for detectors/deploy_tones/tones.c. Build and run with `make -C firmware/tests/host test`.
 *
 * Frames are synthesized as docs/deploy-tones.md describes (8 tones, 48 ms symbols with 4 ms
 * raised-cosine ramps, preamble 0 7 0 7, 16-bit word and CRC-8) at 16 kHz, then fed in 512-sample
 * blocks, as the detector receives them.
 */
#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "tones.h"

#define PI 3.14159265358979323846
#define SYM_LEN 768 /* 48 ms at 16 kHz */
#define RAMP 64     /* 4 ms */
#define FRAME_LEN (TONES_SYMS * SYM_LEN)
#define BLOCK 512
#define AMP 0.3
#define MAX_REPORTS 16

static int failures;
static int64_t worst_start_err; /* start error of largest size seen */

#define CHECK(cond)                                                                                \
	do {                                                                                       \
		if (!(cond)) {                                                                     \
			fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #cond);   \
			failures++;                                                                \
		}                                                                                  \
	} while (0)

static uint32_t rng_state = 2463534242u;

static uint32_t rnd(void)
{
	rng_state ^= rng_state << 13;
	rng_state ^= rng_state >> 17;
	rng_state ^= rng_state << 5;
	return rng_state;
}

/* Symbols 0..11 of a frame carrying word: preamble, then the word and its CRC, 3 bits each. */
static void make_symbols(uint16_t word, uint8_t sym[TONES_SYMS])
{
	static const uint8_t pre[4] = {0, 7, 0, 7};
	uint8_t b[2] = {(uint8_t)(word >> 8), (uint8_t)word};
	uint32_t v = ((uint32_t)word << 8) | tones_crc8(b, 2);

	memcpy(sym, pre, sizeof(pre));
	for (int i = 0; i < 8; i++) {
		sym[4 + i] = (uint8_t)((v >> (21 - 3 * i)) & 7);
	}
}

/* Writes one frame of FRAME_LEN samples with the given symbols. */
static void synth(int16_t *out, const uint8_t sym[TONES_SYMS], double amp)
{
	for (int s = 0; s < TONES_SYMS; s++) {
		double f = 1500.0 + 250.0 * sym[s];

		for (int n = 0; n < SYM_LEN; n++) {
			double env = 1.0;

			if (n < RAMP) {
				env = 0.5 - 0.5 * cos(PI * n / RAMP);
			} else if (n >= SYM_LEN - RAMP) {
				env = 0.5 - 0.5 * cos(PI * (SYM_LEN - n) / RAMP);
			}
			double t = (double)(s * SYM_LEN + n) / TONES_RATE;
			double v = amp * env * sin(2.0 * PI * f * t);

			out[s * SYM_LEN + n] = (int16_t)lrint(v * 32767.0);
		}
	}
}

/* Adds samples to a stream at offset. */
static void place(int16_t *stream, size_t at, const int16_t *frame, size_t n)
{
	for (size_t i = 0; i < n; i++) {
		long v = stream[at + i] + (long)frame[i];

		stream[at + i] = (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
	}
}

static size_t round_up(size_t n)
{
	return (n + BLOCK - 1) / BLOCK * BLOCK;
}

/* Feeds the stream in blocks and returns the reports. */
static int decode(const int16_t *x, size_t n, struct tones_report *rep)
{
	static struct tones t;
	int total = 0;

	tones_init(&t, 7.8f, 5000.0f);
	for (size_t off = 0; off < n; off += BLOCK) {
		total += tones_feed(&t, x + off, BLOCK, off, rep + total, MAX_REPORTS - total);
	}
	return total;
}

/* The reported start must be within one hop (128 samples) of the true start. */
static bool start_ok(int64_t err)
{
	if (err < -TONES_HOP || err > TONES_HOP) {
		return false;
	}
	if (llabs((long long)err) > llabs((long long)worst_start_err)) {
		worst_start_err = err;
	}
	return true;
}

static void test_crc(void)
{
	CHECK(tones_crc8((const uint8_t *)"123456789", 9) == 0xF4);
	uint8_t z[2] = {0, 0};

	CHECK(tones_crc8(z, 2) == 0);
}

/* One frame at many start offsets, for three words. Word 0x1007 is swept over 0..3000 samples. */
static void test_offsets(void)
{
	static const uint16_t words[] = {0x1000 | 7, 0x1FFF, 0x1000};
	static const size_t extra[] = {255, 333, 1001, 4099};
	struct tones_report rep[MAX_REPORTS];

	for (unsigned w = 0; w < sizeof(words) / sizeof(words[0]); w++) {
		uint8_t sym[TONES_SYMS];
		int16_t frame[FRAME_LEN];
		size_t count = w == 0 ? 3001 : 128 + sizeof(extra) / sizeof(extra[0]);

		make_symbols(words[w], sym);
		synth(frame, sym, AMP);
		for (size_t idx = 0; idx < count; idx++) {
			size_t p = w != 0 ? (idx < 128 ? idx : extra[idx - 128]) : idx;
			size_t n = round_up(p + FRAME_LEN + 4096);
			int16_t *stream = calloc(n, sizeof(int16_t));

			place(stream, p, frame, FRAME_LEN);
			int got = decode(stream, n, rep);

			CHECK(got == 1);
			if (got == 1) {
				CHECK(rep[0].word == words[w]);
				CHECK(start_ok((int64_t)rep[0].start - (int64_t)p));
				CHECK(rep[0].ratio_db >= 7.8f);
				if (w == 0 && p == 0) {
					/* Full scale sine is 0 dBFS; this frame is AMP (about -10.5 dBFS). */
					CHECK(fabsf(rep[0].level_dbfs - 20.0f * log10f((float)AMP)) < 0.5f);
				}
			}
			free(stream);
		}
	}
}

/* The same frame three times, as the page plays it, is reported once; a repeat after 5 s is not. */
static void test_repeats(void)
{
	uint8_t sym[TONES_SYMS];
	int16_t frame[FRAME_LEN];
	struct tones_report rep[MAX_REPORTS];
	const size_t gap = 4000; /* 250 ms */
	const size_t p1 = 300, p2 = p1 + FRAME_LEN + gap, p3 = p2 + FRAME_LEN + gap;
	const size_t p4 = p3 + FRAME_LEN + 96000; /* 6 s after the third copy */
	size_t n = round_up(p4 + FRAME_LEN + 4096);
	int16_t *stream = calloc(n, sizeof(int16_t));

	make_symbols(0x1007, sym);
	synth(frame, sym, AMP);
	place(stream, p1, frame, FRAME_LEN);
	place(stream, p2, frame, FRAME_LEN);
	place(stream, p3, frame, FRAME_LEN);
	place(stream, p4, frame, FRAME_LEN);
	int got = decode(stream, n, rep);

	CHECK(got == 2);
	if (got == 2) {
		CHECK(rep[0].word == 0x1007 && rep[1].word == 0x1007);
		CHECK(start_ok((int64_t)rep[1].start - (int64_t)p4));
	}
	free(stream);
}

/* A symbol changed after the CRC was made fails the CRC; the same frame unchanged decodes. */
static void test_corrupt(void)
{
	uint8_t sym[TONES_SYMS];
	int16_t frame[FRAME_LEN];
	struct tones_report rep[MAX_REPORTS];
	size_t n = round_up(FRAME_LEN + 4096);
	int16_t *stream = calloc(n, sizeof(int16_t));

	make_symbols(0x1234, sym);
	sym[6] = (uint8_t)((sym[6] + 1) & 7);
	synth(frame, sym, AMP);
	place(stream, 0, frame, FRAME_LEN);
	CHECK(decode(stream, n, rep) == 0);

	/* A wrong preamble is rejected before the CRC is looked at. */
	make_symbols(0x1234, sym);
	sym[2] = 1;
	memset(stream, 0, n * sizeof(int16_t));
	synth(frame, sym, AMP);
	place(stream, 0, frame, FRAME_LEN);
	CHECK(decode(stream, n, rep) == 0);

	/* Control: the frame as made. */
	make_symbols(0x1234, sym);
	memset(stream, 0, n * sizeof(int16_t));
	synth(frame, sym, AMP);
	place(stream, 0, frame, FRAME_LEN);
	CHECK(decode(stream, n, rep) == 1 && rep[0].word == 0x1234);
	free(stream);
}

/* 60 s of white noise at about full scale over 0.3: nothing reported. */
static void test_noise_only(void)
{
	const size_t n = 60 * TONES_RATE;
	int16_t *stream = malloc(n * sizeof(int16_t));
	struct tones_report rep[MAX_REPORTS];

	for (size_t i = 0; i < n; i++) {
		double u = (rnd() / 4294967296.0) * 2.0 - 1.0;

		stream[i] = (int16_t)lrint(u * 0.35 * 32767.0);
	}
	CHECK(decode(stream, n, rep) == 0);
	free(stream);
}

/* The frame in noise that is 3 dB below the tone's peak level per tone: still decoded. */
static void test_frame_in_noise(void)
{
	uint8_t sym[TONES_SYMS];
	int16_t frame[FRAME_LEN];
	struct tones_report rep[MAX_REPORTS];
	const size_t p = 777;
	size_t n = round_up(p + FRAME_LEN + 4096);
	int16_t *stream = calloc(n, sizeof(int16_t));

	make_symbols(0x1ABC, sym);
	synth(frame, sym, AMP);
	place(stream, p, frame, FRAME_LEN);
	for (size_t i = 0; i < n; i++) {
		double u = (rnd() / 4294967296.0) * 2.0 - 1.0;
		long v = stream[i] + (long)lrint(u * 0.35 * 32767.0);

		stream[i] = (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : v);
	}
	int got = decode(stream, n, rep);

	CHECK(got == 1);
	if (got == 1) {
		CHECK(rep[0].word == 0x1ABC);
		CHECK(start_ok((int64_t)rep[0].start - (int64_t)p));
	}
	free(stream);
}

int main(void)
{
	test_crc();
	test_offsets();
	test_repeats();
	test_corrupt();
	test_noise_only();
	test_frame_in_noise();
	printf("tones: largest start error %lld samples (one hop is %d)\n", (long long)worst_start_err,
	       TONES_HOP);
	if (failures) {
		fprintf(stderr, "test_tones: %d failures\n", failures);
		return 1;
	}
	printf("test_tones ok\n");
	return 0;
}
