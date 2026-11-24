/*
 * Node radio. Sends pending records as Coded PHY extended advertisements, and follows the gateway's
 * periodic advertising train for time sync.
 *
 * The node has one radio, and every millisecond it listens is one it cannot send in. So it scans only
 * until it finds the gateway (CONFIG_SM_NODE_SCAN_WINDOW_MS every CONFIG_SM_NODE_SCAN_INTERVAL_MS),
 * then syncs to the train and stops scanning: from then on the controller wakes the receiver only at
 * each periodic event, about once a second. If the train is lost, the node scans again.
 */
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/gap.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include <sonicmesh/msg.h>
#include <sonicmesh/radio.h>
#include <sonicmesh/records.h>
#include <sonicmesh/timesync.h>
#include <sonicmesh/wire.h>

LOG_MODULE_REGISTER(sm_radio, CONFIG_SONICMESH_LOG_LEVEL);

/* Advertise a little faster than frames are refilled, so every frame goes out at least once. */
#define ADV_UNITS(ms) ((ms) * 1000 / 625)
#define ADV_INT_MIN ADV_UNITS(CONFIG_SM_ADV_INTERVAL_MS * 8 / 10)
#define ADV_INT_MAX ADV_UNITS(CONFIG_SM_ADV_INTERVAL_MS * 9 / 10)

/* Give up on the train after this long without an event (units of 10 ms). */
#define SYNC_TIMEOUT_10MS 1000

static struct bt_le_ext_adv *adv;
static bool advertising;
static uint8_t frame[4 + SM_FRAME_HDR_LEN + CONFIG_SM_FRAME_MAX];

static struct bt_le_per_adv_sync *sync;
static bool scanning;

/* Finds the gateway's SYNC record in an advertisement. */
struct find_ctx {
	bool gateway;
	bool found;
	uint32_t label;
};

static bool ad_found(struct bt_data *data, void *user)
{
	struct find_ctx *ctx = user;
	struct sm_frame_hdr hdr;
	const uint8_t *recs;
	size_t recs_len, pos = 0;
	struct sm_record_view rec;

	if (data->type != BT_DATA_MANUFACTURER_DATA) {
		return true;
	}
	if (!sm_wire_parse(data->data, data->data_len, &hdr, &recs, &recs_len) ||
	    !(hdr.flags & SM_FLAG_GATEWAY)) {
		return false;
	}
	ctx->gateway = true;
	while (sm_wire_next(recs, recs_len, &pos, &rec)) {
		if (rec.type == SM_REC_SYNC && rec.len >= 4) {
			ctx->label = sm_get_u32(rec.payload);
			ctx->found = true;
		}
	}
	return false;
}

static void scan_on(void)
{
	struct bt_le_scan_param p = {
		.type = BT_LE_SCAN_TYPE_PASSIVE,
		.options = BT_LE_SCAN_OPT_CODED | BT_LE_SCAN_OPT_NO_1M,
		.interval = BT_GAP_MS_TO_SCAN_INTERVAL(CONFIG_SM_NODE_SCAN_INTERVAL_MS),
		.window = BT_GAP_MS_TO_SCAN_WINDOW(CONFIG_SM_NODE_SCAN_WINDOW_MS),
	};
	int err;

	if (scanning || CONFIG_SM_NODE_SCAN_WINDOW_MS == 0) {
		return;
	}
	err = bt_le_scan_start(&p, NULL);
	if (err && err != -EALREADY) {
		LOG_WRN("scan start failed: %d", err);
		return;
	}
	scanning = true;
}

static void scan_off(void)
{
	if (scanning) {
		bt_le_scan_stop();
		scanning = false;
	}
}

/* Scan and sync changes run in the work queue, not in Bluetooth callbacks. */
static bt_addr_le_t gw_addr;
static uint8_t gw_sid;
static atomic_t want_sync, want_scan, want_stop;

static void radio_ctl(struct k_work *work)
{
	if (atomic_cas(&want_sync, 1, 0) && !sync) {
		struct bt_le_per_adv_sync_param p = {
			.sid = gw_sid,
			.options = BT_LE_PER_ADV_SYNC_OPT_NONE,
			.skip = 0,
			.timeout = SYNC_TIMEOUT_10MS,
		};

		bt_addr_le_copy(&p.addr, &gw_addr);
		int err = bt_le_per_adv_sync_create(&p, &sync);

		if (err) {
			LOG_WRN("sync create failed: %d", err);
			sync = NULL;
		}
	}
	if (atomic_cas(&want_stop, 1, 0)) {
		scan_off();
	}
	if (atomic_cas(&want_scan, 1, 0)) {
		scan_on();
	}
}

static K_WORK_DEFINE(ctl_work, radio_ctl);

static void scan_recv(const struct bt_le_scan_recv_info *info, struct net_buf_simple *buf)
{
	struct find_ctx ctx = {0};

	/* Only the gateway's advertisement that announces a periodic train is of interest. */
	if (sync || info->interval == 0) {
		return;
	}
	bt_data_parse(buf, ad_found, &ctx);
	if (ctx.gateway) {
		bt_addr_le_copy(&gw_addr, info->addr);
		gw_sid = info->sid;
		atomic_set(&want_sync, 1);
		k_work_submit(&ctl_work);
	}
}

static struct bt_le_scan_cb scan_cb = {
	.recv = scan_recv,
};

static void sync_synced(struct bt_le_per_adv_sync *s, struct bt_le_per_adv_sync_synced_info *info)
{
	LOG_INF("following the gateway's sync train (interval %u x 1.25 ms)", info->interval);
	/* The controller now listens only at the train's events: stop scanning. */
	atomic_set(&want_stop, 1);
	k_work_submit(&ctl_work);
}

static void sync_term(struct bt_le_per_adv_sync *s, const struct bt_le_per_adv_sync_term_info *info)
{
	LOG_WRN("lost the gateway's sync train (reason %u), scanning", info->reason);
	sync = NULL;
	atomic_set(&want_scan, 1);
	k_work_submit(&ctl_work);
}

static void sync_recv(struct bt_le_per_adv_sync *s, const struct bt_le_per_adv_sync_recv_info *info,
		      struct net_buf_simple *buf)
{
	/* Timestamp first: this is the shared instant every node pairs with the label. */
	int64_t rx_us = sm_time_local_us();
	struct find_ctx ctx = {0};

	bt_data_parse(buf, ad_found, &ctx);
	if (ctx.found) {
		sm_timesync_point(rx_us, ctx.label);
	}
}

static struct bt_le_per_adv_sync_cb sync_cb = {
	.synced = sync_synced,
	.term = sync_term,
	.recv = sync_recv,
};

static void send_frame(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(frame_work, send_frame);

static void send_frame(struct k_work *work)
{
	uint32_t net;
	uint8_t flags = sm_time_to_net(sm_time_local_us(), &net) ? SM_FLAG_SYNCED : 0;
	size_t len = sm_msg_fill_frame(frame, sizeof(frame), sm_node_id(), flags);

	if (len == 0) {
		if (advertising) {
			bt_le_ext_adv_stop(adv);
			advertising = false;
		}
	} else {
		/* Zephyr adds the AD length and type itself, so skip the first two bytes of the frame. */
		struct bt_data ad = BT_DATA(BT_DATA_MANUFACTURER_DATA, &frame[2], len - 2);
		int err = bt_le_ext_adv_set_data(adv, &ad, 1, NULL, 0);

		if (err) {
			LOG_WRN("set data failed: %d", err);
		} else if (!advertising) {
			err = bt_le_ext_adv_start(adv, BT_LE_EXT_ADV_START_DEFAULT);
			advertising = (err == 0);
			if (err) {
				LOG_WRN("adv start failed: %d", err);
			}
		}
	}
	k_work_reschedule(k_work_delayable_from_work(work), K_MSEC(CONFIG_SM_ADV_INTERVAL_MS));
}

int sm_radio_start(void)
{
	struct bt_le_adv_param adv_param = {
		.id = BT_ID_DEFAULT,
		.sid = 0,
		.options = BT_LE_ADV_OPT_EXT_ADV | BT_LE_ADV_OPT_CODED,
		.interval_min = ADV_INT_MIN,
		.interval_max = ADV_INT_MAX,
	};
	int err = bt_enable(NULL);

	if (err) {
		LOG_ERR("bt_enable failed: %d", err);
		return err;
	}
	err = bt_le_ext_adv_create(&adv_param, NULL, &adv);
	if (err) {
		LOG_ERR("adv create failed: %d", err);
		return err;
	}
	bt_le_scan_cb_register(&scan_cb);
	bt_le_per_adv_sync_cb_register(&sync_cb);
	scan_on();
	k_work_reschedule(&frame_work, K_MSEC(CONFIG_SM_ADV_INTERVAL_MS));
	LOG_INF("radio up: Coded PHY, node %04x", sm_node_id());
	return 0;
}
