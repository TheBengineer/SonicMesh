/*
 * Audio capture over USB: `sm capture <seconds>` streams the audio exactly as the detectors receive it
 * (after the DC blocker, 16-bit, CONFIG_SM_AUDIO_RATE), so a tool can record a board's view of a sound,
 * replay it through the same detector code, and measure the microphone chain.
 *
 * It is a detector like any other: it gets every block, copies the ones it needs into its own queue
 * and releases them at once, so it never holds the shared pool. A thread at the lowest priority, below
 * the comb, sends each block as one JSON line. Capturing must not change what the detectors do (the
 * replay check compares them), so it uses only spare CPU; when that is short the queue overflows and
 * the capture has gaps, while the detectors drop nothing. At priority 12 it cost the comb 8 % of its
 * blocks.
 *
 *   {"k":"pcm","s":<first sample>,"t":<local us of first sample>,"n":<samples>,"d":"<base64 int16 LE>"}
 *
 * and finishes with {"k":"capture","blocks":<sent>,"gaps":<blocks not sent>,"last_s":<first sample of
 * the last block sent>,"rate_hz":<measured>}.
 * Blocks follow on from each other (s steps by n); a missing s is a gap, either because USB was too slow
 * for the queue or because the shell dropped a line it could not lock in time. 512 samples take about
 * 1.4 kB of text, about 43 kB/s.
 */
#include <errno.h>
#include <stdlib.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/shell/shell.h>
#include <zephyr/sys/base64.h>

#include <sonicmesh/audio.h>
#include <sonicmesh/detector.h>

#define N CONFIG_SM_AUDIO_BLOCK_SAMPLES
#define QUEUE_BLOCKS 16 /* 0.5 s at 32 ms blocks */
#define MAX_SECONDS 600

struct cap_block {
	uint64_t first_sample;
	int64_t t0_local_us;
	int16_t pcm[N];
};

K_MSGQ_DEFINE(cap_queue, sizeof(struct cap_block), QUEUE_BLOCKS, 8);

static atomic_t want;   /* blocks still to queue */
static atomic_t gaps;   /* blocks not queued while capturing */
static atomic_t sending; /* a capture is running */
static const struct shell *out_sh;
static uint32_t total_blocks;
static K_SEM_DEFINE(start_sem, 0, 1);

static int capture_init(void)
{
	return 0;
}

static void capture_process(const struct sm_block *blk)
{
	static struct cap_block b; /* the detector thread is the only writer */

	if (atomic_get(&want) <= 0) {
		return;
	}
	b.first_sample = blk->first_sample;
	b.t0_local_us = blk->t0_local_us;
	memcpy(b.pcm, blk->pcm, sizeof(b.pcm));
	if (k_msgq_put(&cap_queue, &b, K_NO_WAIT) != 0) {
		atomic_inc(&gaps);
	}
	atomic_dec(&want);
}

/* Priority 3: right below the gunshot detector, so copying never waits on the comb. */
SM_DETECTOR_DEFINE(capture, capture_init, capture_process, NULL, 1024, K_PRIO_PREEMPT(3));

static void send_thread(void *p1, void *p2, void *p3)
{
	static struct cap_block b;
	static char line[2 * N * 4 / 3 + 160];

	for (;;) {
		k_sem_take(&start_sem, K_FOREVER);

		uint32_t sent = 0;
		int64_t first_t = 0, last_t = 0;
		uint64_t first_s = 0, last_s = 0;

		while (sent + (uint32_t)atomic_get(&gaps) < total_blocks) {
			if (k_msgq_get(&cap_queue, &b, K_MSEC(1000)) != 0) {
				if (atomic_get(&want) <= 0) {
					break; /* the rest were gaps */
				}
				continue;
			}
			size_t olen;

			int h = snprintk(line, sizeof(line), "{\"k\":\"pcm\",\"s\":%llu,\"t\":%lld,\"n\":%d,\"d\":\"",
					 (unsigned long long)b.first_sample, (long long)b.t0_local_us, N);

			/* The payload is encoded in place, not formatted: this thread runs on spare CPU. */
			base64_encode((uint8_t *)&line[h], sizeof(line) - h - 4, &olen, (const uint8_t *)b.pcm,
				      sizeof(b.pcm));
			memcpy(&line[h + olen], "\"}\n", 4);
			shell_fprintf(out_sh, SHELL_NORMAL, "%s", line);
			if (sent == 0) {
				first_t = b.t0_local_us;
				first_s = b.first_sample;
			}
			last_t = b.t0_local_us;
			last_s = b.first_sample;
			sent++;
		}
		double rate = last_t > first_t ? (double)(last_s - first_s) * 1e6 / (double)(last_t - first_t) : 0;

		shell_fprintf(out_sh, SHELL_NORMAL,
			      "{\"k\":\"capture\",\"blocks\":%u,\"gaps\":%d,\"last_s\":%llu,\"rate_hz\":%.2f}\n",
			      sent, (int)atomic_get(&gaps), (unsigned long long)last_s, rate);
		atomic_set(&sending, 0);
	}
}

K_THREAD_DEFINE(sm_capture_send, 2048, send_thread, NULL, NULL, NULL, K_PRIO_PREEMPT(14), 0, 0);

/* sm capture <seconds> | sm capture stop */
static int cmd_capture(const struct shell *sh, size_t argc, char **argv)
{
	if (strcmp(argv[1], "stop") == 0) {
		atomic_set(&want, 0);
		shell_print(sh, "{\"k\":\"ok\",\"c\":\"capture\"}");
		return 0;
	}
	char *end;
	double s = strtod(argv[1], &end);

	if (*end || s <= 0 || s > MAX_SECONDS) {
		shell_print(sh, "{\"k\":\"err\",\"c\":\"capture\",\"e\":%d,\"m\":\"seconds is 0-%d, or stop\"}",
			    -EINVAL, MAX_SECONDS);
		return -EINVAL;
	}
	if (!atomic_cas(&sending, 0, 1)) {
		shell_print(sh, "{\"k\":\"err\",\"c\":\"capture\",\"e\":%d,\"m\":\"a capture is running\"}", -EBUSY);
		return -EBUSY;
	}
	k_msgq_purge(&cap_queue);
	out_sh = sh;
	total_blocks = (uint32_t)(s * CONFIG_SM_AUDIO_RATE / N + 0.5);
	if (total_blocks == 0) {
		total_blocks = 1;
	}
	atomic_set(&gaps, 0);
	atomic_set(&want, total_blocks);
	k_sem_give(&start_sem);
	/* Answer now; the blocks follow from the sending thread, then the "capture" line. */
	shell_print(sh, "{\"k\":\"ok\",\"c\":\"capture\",\"blocks\":%u,\"n\":%d,\"rate\":%d}", total_blocks, N,
		    CONFIG_SM_AUDIO_RATE);
	return 0;
}

SHELL_SUBCMD_ADD((sm), capture, NULL, "Stream audio as the detectors see it: sm capture <seconds> | stop",
		 cmd_capture, 2, 0);
