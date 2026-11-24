/*
 * Gateway: hears node frames on Coded PHY, drops repeats, prints one JSON line per new record on the
 * console, and runs the sync train. Output lines (see tools/smlog.py):
 *   {"k":"rec","g":<us>,"n":<node>,"f":<flags>,"rssi":<dBm>,"t":<type>,"i":<id>,"p":"<hex>"}
 *   {"k":"sync","g":<us>,"b":<label count>}   (every 10th train relabel)
 *   {"k":"gw","g":<us>,"up":<s>,"frames":<n>,"recs":<n>,"dups":<n>,"lost":<n>}
 */
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/gap.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include <sonicmesh/msg.h>
#include <sonicmesh/radio.h>
#include <sonicmesh/records.h>
#include <sonicmesh/status_led.h>
#include <sonicmesh/timesync.h>
#include <sonicmesh/wire.h>

LOG_MODULE_REGISTER(sm_gateway, CONFIG_SONICMESH_LOG_LEVEL);

#define MAX_NODES 32
#define RECENT_IDS 32

struct line {
	int64_t g;
	uint16_t node;
	uint8_t flags;
	int8_t rssi;
	uint8_t type;
	uint8_t len;
	uint16_t id;
	uint8_t payload[SM_RECORD_MAX_PAYLOAD];
};

K_MSGQ_DEFINE(lines, sizeof(struct line), 64, 4);

static struct {
	uint16_t node;
	uint16_t ids[RECENT_IDS];
	uint8_t n, head;
} seen[MAX_NODES];

static uint32_t frames, recs, dups, lost;

/* True if this (node, id) was printed recently. Records repeat for about half a second. */
static bool repeat(uint16_t node, uint16_t id)
{
	int free_slot = -1;

	for (int i = 0; i < MAX_NODES; i++) {
		if (seen[i].n && seen[i].node == node) {
			for (int j = 0; j < seen[i].n; j++) {
				if (seen[i].ids[j] == id) {
					return true;
				}
			}
			seen[i].ids[seen[i].head] = id;
			seen[i].head = (seen[i].head + 1) % RECENT_IDS;
			seen[i].n = MIN(seen[i].n + 1, RECENT_IDS);
			return false;
		}
		if (!seen[i].n && free_slot < 0) {
			free_slot = i;
		}
	}
	if (free_slot >= 0) {
		seen[free_slot].node = node;
		seen[free_slot].ids[0] = id;
		seen[free_slot].n = 1;
		seen[free_slot].head = 1;
	}
	return false;
}

struct rx_ctx {
	int64_t g;
	int8_t rssi;
};

static bool ad_found(struct bt_data *data, void *user)
{
	struct rx_ctx *ctx = user;
	struct sm_frame_hdr hdr;
	const uint8_t *recs_at;
	size_t recs_len, pos = 0;
	struct sm_record_view rec;

	if (data->type != BT_DATA_MANUFACTURER_DATA) {
		return true;
	}
	if (!sm_wire_parse(data->data, data->data_len, &hdr, &recs_at, &recs_len) ||
	    (hdr.flags & SM_FLAG_GATEWAY)) {
		return false;
	}
	frames++;
	while (sm_wire_next(recs_at, recs_len, &pos, &rec)) {
		if (repeat(hdr.node, rec.id)) {
			dups++;
			continue;
		}
		struct line l = {
			.g = ctx->g,
			.node = hdr.node,
			.flags = hdr.flags,
			.rssi = ctx->rssi,
			.type = rec.type,
			.len = MIN(rec.len, SM_RECORD_MAX_PAYLOAD),
			.id = rec.id,
		};

		memcpy(l.payload, rec.payload, l.len);
		if (k_msgq_put(&lines, &l, K_NO_WAIT) != 0) {
			lost++;
		} else {
			recs++;
		}
	}
	return false;
}

static void scan_recv(const struct bt_le_scan_recv_info *info, struct net_buf_simple *buf)
{
	struct rx_ctx ctx = {.g = sm_time_local_us(), .rssi = info->rssi};

	bt_data_parse(buf, ad_found, &ctx);
}

static struct bt_le_scan_cb scan_cb = {
	.recv = scan_recv,
};

/*
 * Sync train: a periodic advertising train on Coded PHY, strictly periodic in the controller. Once per
 * period its payload is rewritten with the gateway's clock; every node hears the same payload in the
 * same transmission and pairs it with its own arrival time (timesync.h). The extended advertisement
 * that carries the train's sync info is slow: nodes only need it to find the train.
 */
static struct bt_le_ext_adv *train_adv;
static uint32_t labels;
#define SYNC_LEN (4 + 2)
static uint8_t train_frame[4 + SM_FRAME_HDR_LEN + SM_RECORD_HDR_LEN + SYNC_LEN];

static size_t build_train(uint32_t label)
{
	struct sm_frame_hdr hdr = {.node = 0, .flags = SM_FLAG_GATEWAY};
	uint8_t p[SYNC_LEN];
	size_t len = sm_wire_begin(train_frame, sizeof(train_frame), &hdr);

	sm_put_u32(&p[0], label);
	sm_put_u16(&p[4], CONFIG_SM_SYNC_PERIOD_MS);
	len = sm_wire_add(train_frame, len, sizeof(train_frame), SM_REC_SYNC, (uint16_t)labels, p, sizeof(p));
	return sm_wire_finish(train_frame, len);
}

static void relabel_work_fn(struct k_work *work)
{
	uint32_t label = (uint32_t)sm_time_local_us();
	size_t len = build_train(label);
	struct bt_data ad = BT_DATA(BT_DATA_MANUFACTURER_DATA, &train_frame[2], len - 2);
	int err = bt_le_per_adv_set_data(train_adv, &ad, 1);

	if (err) {
		LOG_WRN("train data update failed: %d", err);
		return;
	}
	labels++;
	if (labels % 10 == 0) {
		printk("{\"k\":\"sync\",\"g\":%lld,\"b\":%u}\n", sm_time_local_us(), labels);
	}
	sm_led_flash(SM_LED_GREEN, 20);
}

static K_WORK_DEFINE(relabel_work, relabel_work_fn);

static void relabel_tick(struct k_timer *t)
{
	k_work_submit(&relabel_work);
}

static K_TIMER_DEFINE(relabel_timer, relabel_tick, NULL);

static int train_start(void)
{
	struct bt_le_adv_param adv_param = {
		.id = BT_ID_DEFAULT,
		.sid = 1,
		.options = BT_LE_ADV_OPT_EXT_ADV | BT_LE_ADV_OPT_CODED,
		.interval_min = BT_GAP_MS_TO_ADV_INTERVAL(500),
		.interval_max = BT_GAP_MS_TO_ADV_INTERVAL(600),
	};
	struct bt_le_per_adv_param per_param = {
		.interval_min = BT_GAP_MS_TO_PER_ADV_INTERVAL(CONFIG_SM_SYNC_PERIOD_MS),
		.interval_max = BT_GAP_MS_TO_PER_ADV_INTERVAL(CONFIG_SM_SYNC_PERIOD_MS),
		.options = 0,
	};
	size_t len = build_train(1);
	struct bt_data ad = BT_DATA(BT_DATA_MANUFACTURER_DATA, &train_frame[2], len - 2);
	int err = bt_le_ext_adv_create(&adv_param, NULL, &train_adv);

	if (!err) {
		/* The extended advertisement names the gateway, so nodes know which train to follow. */
		err = bt_le_ext_adv_set_data(train_adv, &ad, 1, NULL, 0);
	}
	if (!err) {
		err = bt_le_per_adv_set_param(train_adv, &per_param);
	}
	if (!err) {
		err = bt_le_per_adv_set_data(train_adv, &ad, 1);
	}
	if (!err) {
		err = bt_le_per_adv_start(train_adv);
	}
	if (!err) {
		err = bt_le_ext_adv_start(train_adv, BT_LE_EXT_ADV_START_DEFAULT);
	}
	if (err) {
		LOG_ERR("sync train start failed: %d", err);
		return err;
	}
	/* Relabel at the train's period. The label timer and the train share the gateway's crystal,
	 * so each label trails its transmission by the same amount every time. */
	k_timer_start(&relabel_timer, K_MSEC(CONFIG_SM_SYNC_PERIOD_MS), K_MSEC(CONFIG_SM_SYNC_PERIOD_MS));
	return 0;
}

static void printer(void *p1, void *p2, void *p3)
{
	int64_t next_status = sm_time_local_us() + 10000000;

	for (;;) {
		struct line l;

		if (k_msgq_get(&lines, &l, K_MSEC(500)) == 0) {
			char hex[2 * SM_RECORD_MAX_PAYLOAD + 1];

			for (int i = 0; i < l.len; i++) {
				snprintk(&hex[2 * i], 3, "%02x", l.payload[i]);
			}
			hex[2 * l.len] = '\0';
			printk("{\"k\":\"rec\",\"g\":%lld,\"n\":%u,\"f\":%u,\"rssi\":%d,\"t\":%u,\"i\":%u,\"p\":\"%s\"}\n",
			       l.g, l.node, l.flags, l.rssi, l.type, l.id, hex);
			sm_led_flash(l.type == SM_REC_SHOT ? SM_LED_RED : SM_LED_BLUE, 30);
		}
		int64_t now = sm_time_local_us();

		if (now >= next_status) {
			next_status = now + 10000000;
			printk("{\"k\":\"gw\",\"g\":%lld,\"up\":%u,\"frames\":%u,\"recs\":%u,\"dups\":%u,\"lost\":%u}\n",
			       now, (uint32_t)(now / 1000000), frames, recs, dups, lost);
		}
	}
}

K_THREAD_STACK_DEFINE(printer_stack, 2048);
static struct k_thread printer_thread;

int sm_radio_start(void)
{
	/* Listen all the time, except while the gateway's own train is on air. */
	struct bt_le_scan_param scan_param = {
		.type = BT_LE_SCAN_TYPE_PASSIVE,
		.options = BT_LE_SCAN_OPT_CODED | BT_LE_SCAN_OPT_NO_1M,
		.interval = BT_GAP_SCAN_FAST_INTERVAL,
		.window = BT_GAP_SCAN_FAST_INTERVAL,
	};
	int err = bt_enable(NULL);

	if (err) {
		LOG_ERR("bt_enable failed: %d", err);
		return err;
	}
	err = train_start();
	if (err) {
		return err;
	}
	bt_le_scan_cb_register(&scan_cb);
	err = bt_le_scan_start(&scan_param, NULL);
	if (err) {
		LOG_ERR("coded scan start failed: %d", err);
		return err;
	}
	k_thread_create(&printer_thread, printer_stack, K_THREAD_STACK_SIZEOF(printer_stack), printer, NULL, NULL,
			NULL, K_LOWEST_APPLICATION_THREAD_PRIO, 0, K_NO_WAIT);
	k_thread_name_set(&printer_thread, "sm_print");
	LOG_INF("gateway up: Coded PHY scan and sync train every %d ms", CONFIG_SM_SYNC_PERIOD_MS);
	return 0;
}
