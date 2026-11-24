#include <errno.h>
#include <string.h>

#include <zephyr/drivers/hwinfo.h>
#include <zephyr/kernel.h>
#include <zephyr/random/random.h>

#include <sonicmesh/msg.h>
#include <sonicmesh/param.h>
#include <sonicmesh/records.h>
#include <sonicmesh/timesync.h>
#include <sonicmesh/trace.h>
#include <sonicmesh/wire.h>

struct pending {
	uint8_t type;
	uint8_t len;
	uint8_t left; /* frames still to ride in; 0 = free */
	uint16_t id;
	uint32_t seq; /* queue order */
	uint8_t data[SM_RECORD_MAX_PAYLOAD];
};

static struct pending pool[CONFIG_SM_RECORD_POOL];
static K_MUTEX_DEFINE(lock);
static uint16_t next_id;
static uint32_t next_seq;
static unsigned int dropped;
static bool ids_seeded;

SM_PARAM_DEFINE(radio, repeats, int, CONFIG_SM_RECORD_REPEATS, 1, 20, NULL,
		"frames each record rides in (no acknowledgements)");

/* The gateway's "rec" fields, except the record type is "ty", since "t" is the trace's time. */
SM_TRACE_DEFINE(rec, "records this board queues to send. 1: each one (nt network time now, n node, ty type, i id, p payload hex)");

static void trace_record(uint8_t type, uint16_t id, const uint8_t *data, uint8_t len)
{
	char hex[2 * SM_RECORD_MAX_PAYLOAD + 1];

	for (uint8_t i = 0; i < len; i++) {
		snprintk(&hex[2 * i], 3, "%02x", data[i]);
	}
	hex[2 * len] = '\0';
	/* nt: network time at the same instant as t (-1 if not synced), so a tool can place a timed
	 * record's network time on this board's clock. */
	int64_t now = sm_time_local_us();
	uint32_t net;
	int64_t nt = sm_time_to_net(now, &net) ? (int64_t)net : -1;

	SM_TRACE(rec, 1, now, ",\"nt\":%lld,\"n\":%u,\"ty\":%u,\"i\":%u,\"p\":\"%s\"", nt, sm_node_id(), type,
		 id, hex);
}

int sm_msg_send(uint8_t type, const void *payload, uint8_t len)
{
	if (len > SM_RECORD_MAX_PAYLOAD) {
		return -EINVAL;
	}
	k_mutex_lock(&lock, K_FOREVER);
	if (!ids_seeded) {
		/* Random start, so a rebooted node's first ids are not taken for repeats of its last. */
		next_id = (uint16_t)sys_rand32_get();
		ids_seeded = true;
	}
	for (size_t i = 0; i < ARRAY_SIZE(pool); i++) {
		struct pending *p = &pool[i];

		if (p->left == 0) {
			p->type = type;
			p->len = len;
			uint16_t id = next_id++;

			p->id = id;
			p->seq = next_seq++;
			p->left = (uint8_t)sm_radio_repeats;
			memcpy(p->data, payload, len);
			k_mutex_unlock(&lock);
			if (SM_TRACE_ON(rec, 1)) {
				trace_record(type, id, payload, len);
			}
			return 0;
		}
	}
	dropped++;
	k_mutex_unlock(&lock);
	return -ENOMEM;
}

int sm_msg_send_timed(uint8_t type, int64_t t_local_us, const void *body, uint8_t body_len)
{
	uint8_t buf[SM_RECORD_MAX_PAYLOAD];
	uint32_t t;
	bool net = sm_time_to_net(t_local_us, &t);

	if (body_len > sizeof(buf) - SM_TIMED_HDR_LEN) {
		return -EINVAL;
	}
	sm_put_u32(buf, t);
	buf[4] = net ? SM_TFLAG_NET : 0;
	memcpy(&buf[SM_TIMED_HDR_LEN], body, body_len);
	return sm_msg_send(type, buf, SM_TIMED_HDR_LEN + body_len);
}

size_t sm_msg_fill_frame(uint8_t *buf, size_t cap, uint16_t node, uint8_t flags)
{
	struct sm_frame_hdr hdr = {.node = node, .flags = flags};
	size_t len = sm_wire_begin(buf, cap, &hdr);
	size_t empty = len;
	uint32_t after = 0;
	bool first = true;

	k_mutex_lock(&lock, K_FOREVER);
	/* Oldest first: pick the lowest seq above the last one taken, until nothing more fits. */
	for (;;) {
		struct pending *best = NULL;

		for (size_t i = 0; i < ARRAY_SIZE(pool); i++) {
			struct pending *p = &pool[i];

			if (p->left && (first || (int32_t)(p->seq - after) > 0) &&
			    (!best || (int32_t)(p->seq - best->seq) < 0)) {
				best = p;
			}
		}
		if (!best) {
			break;
		}
		first = false;
		after = best->seq;
		size_t n = sm_wire_add(buf, len, cap, best->type, best->id, best->data, best->len);

		if (n == 0) {
			continue; /* does not fit; a later, smaller one might */
		}
		len = n;
		best->left--;
	}
	k_mutex_unlock(&lock);
	return len == empty ? 0 : sm_wire_finish(buf, len);
}

unsigned int sm_msg_pending(void)
{
	unsigned int n = 0;

	k_mutex_lock(&lock, K_FOREVER);
	for (size_t i = 0; i < ARRAY_SIZE(pool); i++) {
		n += pool[i].left != 0;
	}
	k_mutex_unlock(&lock);
	return n;
}

unsigned int sm_msg_dropped(void)
{
	return dropped;
}

uint16_t sm_node_id(void)
{
	static uint16_t id;

	if (id == 0) {
		uint8_t dev[8] = {0};
		ssize_t n = hwinfo_get_device_id(dev, sizeof(dev));
		uint32_t h = 2166136261u;

		/* FNV-1a over the device id, folded to 16 bits; 0 and 0xFFFF are reserved. */
		for (ssize_t i = 0; i < n; i++) {
			h = (h ^ dev[i]) * 16777619u;
		}
		id = (uint16_t)(h ^ (h >> 16));
		if (id == 0 || id == 0xFFFF) {
			id = 1;
		}
	}
	return id;
}
