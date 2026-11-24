/*
 * SonicMesh BLE frame format, version 1. Portable C99, shared by the firmware, the host tests and
 * tools/smlog.py (which mirrors it in Python). See docs/firmware.md for the full description.
 *
 * A frame rides in one BLE extended advertisement on Coded PHY, as Manufacturer Specific Data with
 * company id 0xFFFF (reserved for testing):
 *
 *   AD: len | 0xFF | 0xFF 0xFF | magic 'S' | version | node id (u16) | flags | records...
 *
 *   record: type (u8) | len (u8) | id (u16) | payload (len bytes)
 *
 * All multi-byte fields are little-endian. Any number of record types can share a frame. A receiver
 * skips record types it does not know, using len, so new detectors need no change to the radio code,
 * the gateway or older tools.
 */
#ifndef SONICMESH_WIRE_H
#define SONICMESH_WIRE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define SM_COMPANY_ID 0xFFFFu
#define SM_MAGIC 0x53u /* 'S' */
#define SM_WIRE_VERSION 1u

/* Frame header, after the company id. */
#define SM_FRAME_HDR_LEN 5u
#define SM_RECORD_HDR_LEN 4u
#define SM_RECORD_MAX_PAYLOAD 64u

/* Frame flags. */
#define SM_FLAG_GATEWAY 0x01u /* sent by a gateway */
#define SM_FLAG_SYNCED 0x02u  /* node times are network time; else they are the node's own clock */

struct sm_frame_hdr {
	uint16_t node;
	uint8_t flags;
};

struct sm_record_view {
	uint8_t type;
	uint8_t len;
	uint16_t id;
	const uint8_t *payload;
};

/* Writes the AD header and frame header into buf. Returns bytes written. buf holds at least
 * 2 + 2 + SM_FRAME_HDR_LEN bytes. The AD length byte is fixed up by sm_wire_finish. */
size_t sm_wire_begin(uint8_t *buf, size_t cap, const struct sm_frame_hdr *hdr);

/* Appends one record. Returns the new length, or 0 if it does not fit in cap. */
size_t sm_wire_add(uint8_t *buf, size_t len, size_t cap, uint8_t type, uint16_t id, const void *payload,
		   uint8_t payload_len);

/* Fixes the AD length byte. Returns len. */
size_t sm_wire_finish(uint8_t *buf, size_t len);

/*
 * Parses the manufacturer data payload (starting at the company id, i.e. the AD data after the
 * 0xFF type byte). Returns true if it is a SonicMesh frame of a version we read, and fills hdr and
 * *records_at / *records_len for sm_wire_next.
 */
bool sm_wire_parse(const uint8_t *mfg, size_t len, struct sm_frame_hdr *hdr, const uint8_t **records_at,
		   size_t *records_len);

/* Iterates records. *pos starts at 0. Returns false at the end or on a truncated record. */
bool sm_wire_next(const uint8_t *records, size_t len, size_t *pos, struct sm_record_view *rec);

/* Little-endian helpers for building payloads. */
static inline void sm_put_u16(uint8_t *p, uint16_t v)
{
	p[0] = (uint8_t)v;
	p[1] = (uint8_t)(v >> 8);
}

static inline void sm_put_u32(uint8_t *p, uint32_t v)
{
	p[0] = (uint8_t)v;
	p[1] = (uint8_t)(v >> 8);
	p[2] = (uint8_t)(v >> 16);
	p[3] = (uint8_t)(v >> 24);
}

static inline uint16_t sm_get_u16(const uint8_t *p)
{
	return (uint16_t)(p[0] | (p[1] << 8));
}

static inline uint32_t sm_get_u32(const uint8_t *p)
{
	return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

#endif
