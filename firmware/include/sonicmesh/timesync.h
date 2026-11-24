/*
 * Network time. The gateway runs a periodic advertising train, strictly periodic in its controller,
 * and once per period writes its own clock reading into the train's payload. Every node hears the
 * same payload in the same transmission, so the reading labels that instant for all of them. The
 * label trails the true air time by a fixed amount (under one period: the train and the label timer
 * share the gateway's crystal), and that fixed amount, like any radio or interrupt delay common to
 * every node, cancels in the time differences between nodes that shot location uses. Each node fits
 * its local clock to the labels by least squares over the recent events, for offset and drift.
 */
#ifndef SONICMESH_TIMESYNC_H
#define SONICMESH_TIMESYNC_H

#include <stdbool.h>
#include <stdint.h>

/* Monotonic local time in microseconds. */
int64_t sm_time_local_us(void);

/*
 * Converts a local time to network time. Returns true if the node is synced; otherwise *net_us is the
 * local time truncated to 32 bits. On the gateway the two clocks are the same and this returns true.
 */
bool sm_time_to_net(int64_t local_us, uint32_t *net_us);

/* Node: called by the radio for each periodic event heard, with its label (gateway clock). */
void sm_timesync_point(int64_t rx_local_us, uint32_t label_us);

/* Microseconds since the last sync event, or -1 if none has arrived. */
int64_t sm_timesync_age_us(void);

/* Current fit: offset (net - local, us) and drift (ppm). For status output. */
void sm_timesync_state(double *offset_us, double *drift_ppm, int *points);

#endif
