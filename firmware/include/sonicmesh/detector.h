/*
 * Detector framework. A detector is one .c file that calls SM_DETECTOR_DEFINE. The framework gives it
 * its own thread and block queue, so every detector runs at the same time on the same audio, at its
 * own priority, and a slow one cannot stall the others.
 *
 * Adding a detector:
 *   1. Write detectors/<name>/<name>.c with init, process and (optionally) on_event functions.
 *   2. SM_DETECTOR_DEFINE(<name>, init, process, on_event, stack_bytes, priority).
 *   3. Add a Kconfig option and a line in firmware/CMakeLists.txt.
 *   4. Report with sm_msg_send_timed() using a new code from records.h.
 *   5. Declare its settings as parameters named "<name>.<setting>" (param.h) and read them in init().
 *      A change to any of them re-runs init() in the detector's own thread, between blocks. Every
 *      detector also gets "<name>.enable" for free.
 *   6. Optionally declare a trace stream (trace.h) for per-frame features to tune against.
 *
 * Lower priority numbers run first. Short, timing-sensitive detectors (onsets) should sit above
 * heavy ones (FFT combs); timestamps come from the block, so priority affects latency, not accuracy.
 */
#ifndef SONICMESH_DETECTOR_H
#define SONICMESH_DETECTOR_H

#include <stdint.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/iterable_sections.h>

#include <sonicmesh/audio.h>
#include <sonicmesh/param.h>

BUILD_ASSERT(CONFIG_SM_DETECTOR_QUEUE + 3 <= CONFIG_SM_AUDIO_BLOCKS,
	     "leave blocks for the mic driver and the capture thread");

/* Events detectors publish for each other, e.g. so the comb can skip frames a shot overlaps. */
enum sm_event_type {
	SM_EVT_IMPULSE = 1, /* broadband onset at .sample */
};

struct sm_event {
	uint8_t type;
	uint64_t sample;
};

struct sm_detector_stats {
	uint32_t blocks;  /* blocks processed */
	uint32_t drops;   /* blocks missed because the queue was full */
	uint32_t busy_us; /* time spent in process() since the last health record */
	bool started;     /* its thread runs (init succeeded) */
	uint32_t wd_blocks, wd_drops; /* blocks and drops at the last watchdog check */
};

/* For the watchdog: false if audio stopped arriving, or a running detector stopped taking blocks
 * while they piled up for it, since the last call. */
bool sm_watchdog_alive(void);

struct sm_detector {
	const char *name;
	int (*init)(void);
	void (*process)(const struct sm_block *blk);
	/* Optional. Runs in the publisher's thread; keep it short. */
	void (*on_event)(const struct sm_event *evt);
	struct k_msgq *queue;
	k_thread_stack_t *stack;
	size_t stack_size;
	struct k_thread *thread;
	int prio;
	struct sm_detector_stats *stats;
	bool *enabled;  /* parameter <name>.enable */
	atomic_t *reinit; /* set when one of its parameters changes */
};

#define SM_DETECTOR_DEFINE(_name, _init, _process, _on_event, _stack_size, _prio)                \
	K_MSGQ_DEFINE(_name##_sm_queue, sizeof(struct sm_block *), CONFIG_SM_DETECTOR_QUEUE, 4);  \
	K_THREAD_STACK_DEFINE(_name##_sm_stack, _stack_size);                                    \
	static struct k_thread _name##_sm_thread;                                                \
	static struct sm_detector_stats _name##_sm_stats;                                        \
	static bool _name##_sm_enabled;                                                          \
	static atomic_t _name##_sm_reinit;                                                       \
	SM_PARAM_FIELD(_name, enable, bool, &_name##_sm_enabled, 1, 0, 1, NULL,                  \
		       "run this detector (blocks are skipped, not queued, when off)");          \
	static const STRUCT_SECTION_ITERABLE(sm_detector, _name) = {                             \
		.name = #_name,                                                                  \
		.init = _init,                                                                   \
		.process = _process,                                                             \
		.on_event = _on_event,                                                           \
		.queue = &_name##_sm_queue,                                                      \
		.stack = _name##_sm_stack,                                                       \
		.stack_size = K_THREAD_STACK_SIZEOF(_name##_sm_stack),                           \
		.thread = &_name##_sm_thread,                                                    \
		.prio = _prio,                                                                   \
		.stats = &_name##_sm_stats,                                                      \
		.enabled = &_name##_sm_enabled,                                                  \
		.reinit = &_name##_sm_reinit,                                                    \
	}

/* Sends an event to every detector's on_event. */
void sm_event_publish(const struct sm_event *evt);

/* Starts every detector thread. Called by sm_audio_start. */
int sm_detectors_start(void);

/* Hands a block to every detector. Called by the capture thread. Returns detectors it reached. */
int sm_detectors_dispatch(struct sm_block *blk);

/* Releases a detector's hold on a block. */
void sm_block_release(struct sm_block *blk);

/* Sums of all detectors' stats, and a per-detector status line to the console. */
uint32_t sm_detectors_drops(void);
void sm_detectors_print(void);

#endif
