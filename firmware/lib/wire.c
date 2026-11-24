#include <string.h>

#include <sonicmesh/wire.h>

/* AD layout: [0] length, [1] 0xFF, [2..3] company id, [4..] frame header. */
#define AD_PREFIX 4u

size_t sm_wire_begin(uint8_t *buf, size_t cap, const struct sm_frame_hdr *hdr)
{
	if (cap < AD_PREFIX + SM_FRAME_HDR_LEN) {
		return 0;
	}
	buf[0] = 0;
	buf[1] = 0xFF;
	sm_put_u16(&buf[2], SM_COMPANY_ID);
	buf[4] = SM_MAGIC;
	buf[5] = SM_WIRE_VERSION;
	sm_put_u16(&buf[6], hdr->node);
	buf[8] = hdr->flags;
	return AD_PREFIX + SM_FRAME_HDR_LEN;
}

size_t sm_wire_add(uint8_t *buf, size_t len, size_t cap, uint8_t type, uint16_t id, const void *payload,
		   uint8_t payload_len)
{
	size_t need = SM_RECORD_HDR_LEN + payload_len;

	/* The AD length byte counts at most 255 bytes. */
	if (len + need > cap || len + need - 1 > 255) {
		return 0;
	}
	buf[len] = type;
	buf[len + 1] = payload_len;
	sm_put_u16(&buf[len + 2], id);
	if (payload_len) {
		memcpy(&buf[len + SM_RECORD_HDR_LEN], payload, payload_len);
	}
	return len + need;
}

size_t sm_wire_finish(uint8_t *buf, size_t len)
{
	buf[0] = (uint8_t)(len - 1);
	return len;
}

bool sm_wire_parse(const uint8_t *mfg, size_t len, struct sm_frame_hdr *hdr, const uint8_t **records_at,
		   size_t *records_len)
{
	if (len < 2 + SM_FRAME_HDR_LEN || sm_get_u16(mfg) != SM_COMPANY_ID || mfg[2] != SM_MAGIC ||
	    mfg[3] != SM_WIRE_VERSION) {
		return false;
	}
	hdr->node = sm_get_u16(&mfg[4]);
	hdr->flags = mfg[6];
	*records_at = &mfg[2 + SM_FRAME_HDR_LEN];
	*records_len = len - 2 - SM_FRAME_HDR_LEN;
	return true;
}

bool sm_wire_next(const uint8_t *records, size_t len, size_t *pos, struct sm_record_view *rec)
{
	size_t p = *pos;

	if (p + SM_RECORD_HDR_LEN > len) {
		return false;
	}
	rec->type = records[p];
	rec->len = records[p + 1];
	rec->id = sm_get_u16(&records[p + 2]);
	if (p + SM_RECORD_HDR_LEN + rec->len > len) {
		return false;
	}
	rec->payload = &records[p + SM_RECORD_HDR_LEN];
	*pos = p + SM_RECORD_HDR_LEN + rec->len;
	return true;
}
