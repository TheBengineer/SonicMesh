# Host tests for the portable C code in firmware (no Zephyr, no target toolchain).
# `make test` builds every test_*.c here, each with its own main, and runs them.
# A test links only the sources named in SRC_<test>; add a test by dropping in test_<name>.c and, if it
# needs library code, an SRC_test_<name> line.

CC ?= gcc
FW := ../..
COMB_DIR := $(FW)/detectors/drone_comb
COMB_SRC := $(COMB_DIR)/comb.c
COMB_HDR := $(COMB_DIR)/comb.h
TONES_DIR := $(FW)/detectors/deploy_tones
BUILD := build

SIGNALS := signals.c

SRC_test_comb := $(COMB_SRC) $(SIGNALS)
SRC_test_wire := $(FW)/lib/wire.c
SRC_test_tones := $(TONES_DIR)/tones.c

FIXTURE_JSON := $(FW)/../web/tests/fixtures/comb_parity.json
FIXTURE := $(BUILD)/comb_parity.txt

# COMB_MAX_NFFT=8192 so the parity cases with n_fft 4096 and 8192 fit. The node builds with the default, 1024.
CFLAGS := -std=c99 -O2 -Wall -Wextra -Werror -DCOMB_MAX_NFFT=8192 -I$(COMB_DIR) -I$(TONES_DIR) -I$(FW)/include
LDLIBS := -lm

TESTS := $(patsubst test_%.c,$(BUILD)/test_%,$(wildcard test_*.c))

.SECONDEXPANSION:
.PHONY: test bench lib clean
test: $(TESTS) $(FIXTURE)
	@set -e; for t in $(TESTS); do echo "== $$t"; ./$$t $(FIXTURE); done
	@echo "all host tests passed"

# Shared library of the detector cores for tools/smtool replay (smdet.c). Node frame size (1024).
IMPULSE_DIR := $(FW)/detectors/gunshot_impulse
lib: $(BUILD)/libsmdet.so

$(BUILD)/libsmdet.so: smdet.c $(COMB_SRC) $(COMB_HDR) $(IMPULSE_DIR)/impulse.c $(IMPULSE_DIR)/impulse.h | $(BUILD)
	$(CC) -std=c99 -O2 -Wall -Wextra -Werror -fPIC -shared -fvisibility=hidden -I$(COMB_DIR) -I$(IMPULSE_DIR) \
		smdet.c $(COMB_SRC) $(IMPULSE_DIR)/impulse.c -o $@ $(LDLIBS)

# Timing of comb_step on 20 s of drone_600_fading and 20 s of noise. Not part of `make test`.
bench: $(BUILD)/bench_comb
	./$(BUILD)/bench_comb 20

$(BUILD)/bench_comb: bench_comb.c $(COMB_SRC) $(SIGNALS) $(COMB_HDR) signals.h | $(BUILD)
	$(CC) $(CFLAGS) -D_POSIX_C_SOURCE=200809L -DCOMB_STATS bench_comb.c $(COMB_SRC) $(SIGNALS) -o $@ $(LDLIBS)

$(BUILD)/test_%: test_%.c $$(SRC_test_$$*) $(COMB_HDR) | $(BUILD)
	$(CC) $(CFLAGS) $< $(SRC_test_$*) -o $@ $(LDLIBS)

# The fixture is generated into the build directory and never committed.
$(FIXTURE): fixture_to_bin.py $(FIXTURE_JSON) | $(BUILD)
	python3 fixture_to_bin.py $(FIXTURE_JSON) $@

$(BUILD):
	mkdir -p $(BUILD)

clean:
	rm -rf $(BUILD)
