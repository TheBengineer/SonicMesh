/*
 * Host test for firmware/lib/wire.c. Build and run with `make -C firmware/tests/host test`.
 *
 * It prints the hex of the frame it builds ("frame: ..."). tools/smlog.py --selftest decodes that
 * same hex in Python and checks the values, so a change to either decoder shows up in one of them.
 */
#include <stdio.h>
#include <string.h>

#include <sonicmesh/records.h>
#include <sonicmesh/wire.h>

static int failures;

#define CHECK(cond)                                                                                \
	do {                                                                                       \
		if (!(cond)) {                                                                     \
			fprintf(stderr, "%s:%d: CHECK failed: %s\n", __FILE__, __LINE__, #cond);   \
			failures++;                                                                \
		}                                                                                  \
	} while (0)

#define FRAME_CAP 256

/* Builds the reference frame: SHOT, SYNC, an unknown type with no payload, DRONE and a 64-byte
 * record. Returns its length. */
static size_t build_frame(uint8_t *buf, size_t cap)
{
	struct sm_frame_hdr hdr = {.node = 0x00AB, .flags = SM_FLAG_SYNCED};
	uint8_t shot[9], sync[8], drone[13], big[SM_RECORD_MAX_PAYLOAD];
	size_t len;
	unsigned i;

	/* SHOT: t_us, tflags (network time), peak -12.3 dB (x10 = -123), rise 24.3 dB (x10 = 243). */
	sm_put_u32(&shot[0], 0x12345678u);
	shot[4] = SM_TFLAG_NET;
	sm_put_u16(&shot[5], (uint16_t)-123);
	sm_put_u16(&shot[7], 243);

	/* A SYNC record with arbitrary bytes: the wire test checks framing, not the SYNC layout. */
	sm_put_u32(&sync[0], 7u);
	sm_put_u32(&sync[4], 0x0ABCDEF0u);

	/* DRONE: t 1 s on the node's own clock, state update, f0 123.4 Hz, 5 harmonics, score 0.812,
	 * band -4.5 dB. */
	sm_put_u32(&drone[0], 1000000u);
	drone[4] = 0;
	drone[5] = SM_DRONE_UPDATE;
	sm_put_u16(&drone[6], 1234);
	drone[8] = 5;
	sm_put_u16(&drone[9], 812);
	sm_put_u16(&drone[11], (uint16_t)-45);

	for (i = 0; i < sizeof big; i++) {
		big[i] = (uint8_t)(0xA0u + i);
	}

	len = sm_wire_begin(buf, cap, &hdr);
	CHECK(len == 9);
	len = sm_wire_add(buf, len, cap, SM_REC_SHOT, 0x0102, shot, sizeof shot);
	len = sm_wire_add(buf, len, cap, SM_REC_SYNC, 0x0001, sync, sizeof sync);
	len = sm_wire_add(buf, len, cap, 0x42, 0x0003, NULL, 0);
	len = sm_wire_add(buf, len, cap, SM_REC_DRONE, 0x7FFE, drone, sizeof drone);
	len = sm_wire_add(buf, len, cap, 0x80, 0x1111, big, sizeof big);
	CHECK(len != 0);
	return sm_wire_finish(buf, len);
}

static void test_build_and_refuse(void)
{
	struct sm_frame_hdr hdr = {.node = 1, .flags = 0};
	uint8_t small[16], payload[10] = {0}, big[64] = {0}, buf[300];
	size_t len, total;

	/* 9 header bytes + a 10-byte payload needs 23 bytes; cap is 16. */
	len = sm_wire_begin(small, sizeof small, &hdr);
	CHECK(len == 9);
	CHECK(sm_wire_add(small, len, sizeof small, 1, 1, payload, 10) == 0);
	/* A 3-byte payload needs exactly 16. */
	CHECK(sm_wire_add(small, len, sizeof small, 1, 1, payload, 3) == 16);

	/* The AD length byte counts at most 255. Four 64-byte records would need 281 bytes. */
	len = sm_wire_begin(buf, sizeof buf, &hdr);
	len = sm_wire_add(buf, len, sizeof buf, 0x80, 1, big, 64);
	len = sm_wire_add(buf, len, sizeof buf, 0x80, 2, big, 64);
	len = sm_wire_add(buf, len, sizeof buf, 0x80, 3, big, 64);
	CHECK(len == 213);
	CHECK(sm_wire_add(buf, len, sizeof buf, 0x80, 4, big, 64) == 0);

	total = build_frame(buf, FRAME_CAP);
	CHECK(total == 123);
	CHECK(buf[0] == total - 1);
	CHECK(buf[1] == 0xFF);
	CHECK(sm_get_u16(&buf[2]) == SM_COMPANY_ID);
	CHECK(buf[4] == SM_MAGIC);
	CHECK(buf[5] == SM_WIRE_VERSION);

	printf("frame: ");
	for (len = 0; len < total; len++) {
		printf("%02x", buf[len]);
	}
	printf("\n");
}

static void test_parse_and_iterate(void)
{
	uint8_t buf[FRAME_CAP], mfg[FRAME_CAP], bad[FRAME_CAP];
	size_t total = build_frame(buf, sizeof buf);
	size_t mfg_len = total - 2, rlen, pos = 0, count = 0;
	const uint8_t *at;
	struct sm_frame_hdr hdr;
	struct sm_record_view rec;

	memcpy(mfg, buf + 2, mfg_len);
	CHECK(sm_wire_parse(mfg, mfg_len, &hdr, &at, &rlen));
	CHECK(hdr.node == 0x00AB);
	CHECK(hdr.flags == SM_FLAG_SYNCED);
	CHECK(at == mfg + 7);
	CHECK(rlen == total - 9);

	CHECK(sm_wire_next(at, rlen, &pos, &rec));
	CHECK(rec.type == SM_REC_SHOT);
	CHECK(rec.id == 0x0102);
	CHECK(rec.len == 9);
	CHECK(sm_get_u32(rec.payload) == 0x12345678u);
	CHECK(rec.payload[4] == SM_TFLAG_NET);
	CHECK(sm_get_u16(&rec.payload[5]) == 0xFF85u);
	CHECK(sm_get_u16(&rec.payload[7]) == 243);

	CHECK(sm_wire_next(at, rlen, &pos, &rec));
	CHECK(rec.type == SM_REC_SYNC);
	CHECK(rec.id == 0x0001);
	CHECK(rec.len == 8);
	CHECK(sm_get_u32(rec.payload) == 7u);
	CHECK(sm_get_u32(&rec.payload[4]) == 0x0ABCDEF0u);

	CHECK(sm_wire_next(at, rlen, &pos, &rec));
	CHECK(rec.type == 0x42);
	CHECK(rec.id == 0x0003);
	CHECK(rec.len == 0);

	CHECK(sm_wire_next(at, rlen, &pos, &rec));
	CHECK(rec.type == SM_REC_DRONE);
	CHECK(rec.id == 0x7FFE);
	CHECK(rec.len == 13);
	CHECK(sm_get_u32(rec.payload) == 1000000u);
	CHECK(rec.payload[4] == 0);
	CHECK(rec.payload[5] == SM_DRONE_UPDATE);
	CHECK(sm_get_u16(&rec.payload[6]) == 1234);
	CHECK(rec.payload[8] == 5);
	CHECK(sm_get_u16(&rec.payload[9]) == 812);
	CHECK(sm_get_u16(&rec.payload[11]) == 0xFFD3u);

	CHECK(sm_wire_next(at, rlen, &pos, &rec));
	CHECK(rec.type == 0x80);
	CHECK(rec.id == 0x1111);
	CHECK(rec.len == 64);
	CHECK(rec.payload[0] == 0xA0 && rec.payload[63] == (uint8_t)(0xA0 + 63));

	CHECK(!sm_wire_next(at, rlen, &pos, &rec));
	CHECK(pos == rlen);

	/* Reject a wrong company id, magic, version or a short frame. */
	memcpy(bad, mfg, mfg_len);
	bad[0] = 0x00;
	CHECK(!sm_wire_parse(bad, mfg_len, &hdr, &at, &rlen));
	memcpy(bad, mfg, mfg_len);
	bad[2] = 0x52;
	CHECK(!sm_wire_parse(bad, mfg_len, &hdr, &at, &rlen));
	memcpy(bad, mfg, mfg_len);
	bad[3] = SM_WIRE_VERSION + 1;
	CHECK(!sm_wire_parse(bad, mfg_len, &hdr, &at, &rlen));
	CHECK(!sm_wire_parse(mfg, 6, &hdr, &at, &rlen));

	/* A truncated record stops iteration: the last record (offset 46 in the records) cut in its
	 * payload, or cut in its header. Either way the first four records still come out. */
	rlen = total - 9;
	for (pos = 0, count = 0; sm_wire_next(at, rlen - 1, &pos, &rec); count++) {
	}
	CHECK(count == 4);
	for (pos = 0, count = 0; sm_wire_next(at, 48, &pos, &rec); count++) {
	}
	CHECK(count == 4);
}

int main(void)
{
	test_build_and_refuse();
	test_parse_and_iterate();
	if (failures) {
		fprintf(stderr, "wire: %d check(s) failed\n", failures);
		return 1;
	}
	printf("wire: ok\n");
	return 0;
}
