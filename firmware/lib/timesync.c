#include <math.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include <sonicmesh/timesync.h>
#include <sonicmesh/trace.h>

LOG_MODULE_REGISTER(sm_time, CONFIG_SONICMESH_LOG_LEVEL);

int64_t sm_time_local_us(void)
{
	return (int64_t)k_ticks_to_us_floor64(k_uptime_ticks());
}

#ifdef CONFIG_SM_ROLE_GATEWAY

bool sm_time_to_net(int64_t local_us, uint32_t *net_us)
{
	*net_us = (uint32_t)local_us;
	return true;
}

void sm_timesync_point(int64_t rx_local_us, uint32_t label_us)
{
	ARG_UNUSED(rx_local_us);
	ARG_UNUSED(label_us);
}

int64_t sm_timesync_age_us(void)
{
	return 0;
}

void sm_timesync_state(double *offset_us, double *drift_ppm, int *points)
{
	*offset_us = 0;
	*drift_ppm = 0;
	*points = 0;
}

#else

/* Points in the fit: 32 events is 32 s at the default period, long enough to see drift. */
#define FIT_POINTS 32
/* A point this far off the fit is a stray (a late label update, a misread). */
#define OUTLIER_US 3000.0
/* This many strays in a row means the clocks really jumped (gateway restart): start over. */
#define OUTLIER_RUN 5
/* After this long with no event the node stops calling its times network time. */
#define STALE_US (30LL * 1000000)

SM_TRACE_DEFINE(sync, "time sync. 1: each sync train event (label, residual from the fit before it in us, "
		"drift ppm, points)");

struct pair {
	int64_t local;
	int64_t net; /* unwrapped */
};

static struct {
	struct k_spinlock lock;
	struct pair pts[FIT_POINTS];
	int n, head, strays;
	int64_t last_rx;
	/* fit: net = net0 + (1 + rate) * (local - local0) */
	int64_t local0, net0;
	double rate;
	bool fitted;
	int64_t net_hi; /* upper bits for unwrapping the 32-bit labels */
	uint32_t last_net32;
} ts;

static void refit(void)
{
	/* Least squares of (net - local) against local, centred on the newest point for precision. */
	const struct pair *ref = &ts.pts[(ts.head + FIT_POINTS - 1) % FIT_POINTS];
	double sx = 0, sy = 0, sxx = 0, sxy = 0;
	int n = ts.n;

	for (int i = 0; i < n; i++) {
		const struct pair *p = &ts.pts[i];
		double x = (double)(p->local - ref->local);
		double y = (double)((p->net - p->local) - (ref->net - ref->local));

		sx += x;
		sy += y;
		sxx += x * x;
		sxy += x * y;
	}
	double slope = 0;
	double den = n * sxx - sx * sx;

	if (n >= 4 && den > 0) {
		slope = (n * sxy - sx * sy) / den;
	}
	double icept = (sy - slope * sx) / n;

	ts.local0 = ref->local;
	ts.net0 = ref->net + (int64_t)llround(icept);
	ts.rate = slope;
	ts.fitted = true;
}

void sm_timesync_point(int64_t rx_local_us, uint32_t label_us)
{
	k_spinlock_key_t key = k_spin_lock(&ts.lock);

	ts.last_rx = rx_local_us;
	if (label_us < ts.last_net32) {
		ts.net_hi += 1LL << 32;
	}
	ts.last_net32 = label_us;

	int64_t net = ts.net_hi + label_us;
	double resid = 0;

	if (ts.fitted && ts.n >= 8) {
		double pred = (double)ts.net0 + (double)(rx_local_us - ts.local0) * (1.0 + ts.rate);

		resid = (double)net - pred;
		if (fabs(resid) > OUTLIER_US) {
			if (++ts.strays < OUTLIER_RUN) {
				k_spin_unlock(&ts.lock, key);
				SM_TRACE(sync, 1, rx_local_us, ",\"label\":%u,\"resid_us\":%.1f,\"stray\":1",
					 label_us, resid);
				return;
			}
			LOG_WRN("sync jumped %.0f us, refitting", resid);
			ts.n = 0;
			ts.head = 0;
		}
	}
	ts.strays = 0;
	ts.pts[ts.head] = (struct pair){.local = rx_local_us, .net = net};
	ts.head = (ts.head + 1) % FIT_POINTS;
	if (ts.n < FIT_POINTS) {
		ts.n++;
	}
	refit();
	double ppm = ts.rate * 1e6;
	int n = ts.n;

	k_spin_unlock(&ts.lock, key);
	SM_TRACE(sync, 1, rx_local_us, ",\"label\":%u,\"resid_us\":%.1f,\"ppm\":%.2f,\"pts\":%d", label_us,
		 resid, ppm, n);
}

bool sm_time_to_net(int64_t local_us, uint32_t *net_us)
{
	k_spinlock_key_t key = k_spin_lock(&ts.lock);
	bool ok = ts.fitted && ts.last_rx != 0 && sm_time_local_us() - ts.last_rx < STALE_US;

	if (ok) {
		double net = (double)ts.net0 + (double)(local_us - ts.local0) * (1.0 + ts.rate);

		*net_us = (uint32_t)(int64_t)llround(net);
	} else {
		*net_us = (uint32_t)local_us;
	}
	k_spin_unlock(&ts.lock, key);
	return ok;
}

int64_t sm_timesync_age_us(void)
{
	return ts.last_rx ? sm_time_local_us() - ts.last_rx : -1;
}

void sm_timesync_state(double *offset_us, double *drift_ppm, int *points)
{
	k_spinlock_key_t key = k_spin_lock(&ts.lock);

	*offset_us = ts.fitted ? (double)(ts.net0 - ts.local0) : 0;
	*drift_ppm = ts.rate * 1e6;
	*points = ts.n;
	k_spin_unlock(&ts.lock, key);
}

#endif
