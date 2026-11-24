#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include <sonicmesh/detector.h>
#include <sonicmesh/timesync.h>

LOG_MODULE_REGISTER(sm_detector, CONFIG_SONICMESH_LOG_LEVEL);

static void run(void *p1, void *p2, void *p3)
{
	const struct sm_detector *d = p1;

	for (;;) {
		struct sm_block *blk;

		k_msgq_get(d->queue, &blk, K_FOREVER);
		if (atomic_cas(d->reinit, 1, 0) && d->init) {
			int err = d->init();

			LOG_INF("%s: parameters changed, re-initialised (%d)", d->name, err);
		}
		int64_t t0 = sm_time_local_us();

		d->process(blk);
		d->stats->busy_us += (uint32_t)(sm_time_local_us() - t0);
		d->stats->blocks++;
		sm_block_release(blk);
	}
}

int sm_detectors_start(void)
{
	int count = 0;

	STRUCT_SECTION_FOREACH(sm_detector, d) {
		int err = d->init ? d->init() : 0;

		if (err) {
			LOG_ERR("%s: init failed (%d), not started", d->name, err);
			continue;
		}
		k_thread_create(d->thread, d->stack, d->stack_size, run, (void *)d, NULL, NULL, d->prio, 0,
				K_NO_WAIT);
		k_thread_name_set(d->thread, d->name);
		d->stats->started = true;
		LOG_INF("detector %s started at priority %d", d->name, d->prio);
		count++;
	}
	if (count == 0) {
		LOG_WRN("no detectors enabled");
	}
	return 0;
}

static atomic_t dispatched; /* blocks handed out since boot */

bool sm_watchdog_alive(void)
{
	static atomic_val_t last;
	atomic_val_t now = atomic_get(&dispatched);
	bool ok = now != last;

	last = now;
	STRUCT_SECTION_FOREACH(sm_detector, d) {
		struct sm_detector_stats *s = d->stats;

		/* Blocks piled up (drops rose) but none were processed: the thread is stuck. */
		if (s->started && s->drops != s->wd_drops && s->blocks == s->wd_blocks) {
			LOG_ERR("%s stopped taking blocks", d->name);
			ok = false;
		}
		s->wd_blocks = s->blocks;
		s->wd_drops = s->drops;
	}
	return ok;
}

int sm_detectors_dispatch(struct sm_block *blk)
{
	int n = 0;

	atomic_inc(&dispatched);
	STRUCT_SECTION_COUNT(sm_detector, &n);
	if (n == 0) {
		return 0;
	}
	/* Hold one reference while handing out, so a fast detector cannot free the block early. */
	atomic_set(&blk->refs, n + 1);
	STRUCT_SECTION_FOREACH(sm_detector, d) {
		if (!*d->enabled) {
			sm_block_release(blk);
			continue;
		}
		if (k_msgq_put(d->queue, &blk, K_NO_WAIT) != 0) {
			d->stats->drops++;
			sm_block_release(blk);
		}
	}
	sm_block_release(blk);
	return n;
}

/* Parameter "<detector>.<x>" changed: re-run that detector's init() before its next block. */
void sm_detector_param_changed(const char *name)
{
	STRUCT_SECTION_FOREACH(sm_detector, d) {
		size_t n = strlen(d->name);

		if (strncmp(name, d->name, n) == 0 && name[n] == '.') {
			atomic_set(d->reinit, 1);
		}
	}
}

void sm_event_publish(const struct sm_event *evt)
{
	STRUCT_SECTION_FOREACH(sm_detector, d) {
		if (d->on_event) {
			d->on_event(evt);
		}
	}
}

uint32_t sm_detectors_drops(void)
{
	uint32_t drops = 0;

	STRUCT_SECTION_FOREACH(sm_detector, d) {
		drops += d->stats->drops;
	}
	return drops;
}

void sm_detectors_print(void)
{
	static int64_t last;
	int64_t now = sm_time_local_us();
	int64_t span = last ? now - last : 0;

	last = now;
	STRUCT_SECTION_FOREACH(sm_detector, d) {
		uint32_t busy = d->stats->busy_us;

		d->stats->busy_us = 0;
		printk("  %-12s blocks %u  drops %u  cpu %u%%\n", d->name, d->stats->blocks, d->stats->drops,
		       span > 0 ? (unsigned int)((uint64_t)busy * 100 / span) : 0);
	}
}
