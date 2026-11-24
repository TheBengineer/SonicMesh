/*
 * Test signals shared by test_comb and bench_comb: the comb.test.ts signals (LCG noise through one pole,
 * plus harmonic drones, broadband vehicle and clicks), built in double and stored as float.
 */
#ifndef SM_TEST_SIGNALS_H
#define SM_TEST_SIGNALS_H

#include <stdbool.h>

#define SIG_FS 16000

/* Builds signal `name` of `seconds` seconds into an internal buffer. Returns false for an unknown name.
 * The buffer stays valid until the next call. */
bool signal_make(const char *name, int seconds, const float **samples, int *n_samples);

#endif
