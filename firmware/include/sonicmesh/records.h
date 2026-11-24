/*
 * Record type registry. One code per kind of record; payloads are little-endian.
 *
 * Adding a detector's record: take the next free code in 0x20-0x7F, document its payload here and add
 * its decoder to tools/smlog.py (RECORD_TYPES). Nothing else in the radio path changes.
 *
 * Timed records start with the same 5 bytes, so tools can place any of them in time without knowing
 * the rest of the payload:
 *   t_us   u32  event time in microseconds, wrapping every 71.6 minutes
 *   tflags u8   bit 0: t_us is network time (the gateway's clock); else the node's own clock
 */
#ifndef SONICMESH_RECORDS_H
#define SONICMESH_RECORDS_H

#define SM_TFLAG_NET 0x01u
#define SM_TIMED_HDR_LEN 5u

enum sm_record_type {
	/*
	 * Gateway time label, carried in the gateway's periodic advertising train and rewritten once
	 * per period. Every node hears the same label in the same transmission (timesync.h).
	 *   label_us   u32  gateway clock when this payload was written
	 *   period_ms  u16  train period
	 */
	SM_REC_SYNC = 0x01,

	/*
	 * Node health, every SM_HEALTH_PERIOD_S.
	 *   uptime_s     u32
	 *   level_db10   i16  mean sound level over the period, dB SPL x10 (uncalibrated)
	 *   max_db10     i16  loudest 32 ms block in the period, dB SPL x10
	 *   clips        u16  samples at full scale in the period
	 *   drops        u16  audio blocks a detector missed, since boot
	 *   batt_mv      u16  battery, 0 when not measured
	 *   sync_age_ds  u16  tenths of a second since the last sync beacon, 0xFFFF if none yet
	 *   build        u16  firmware build number
	 */
	SM_REC_HEALTH = 0x02,

	/*
	 * Drone comb detector (detectors/drone_comb). Timed.
	 *   state        u8   1 start, 2 update while on, 3 end
	 *   f0_dhz       u16  fundamental, 0.1 Hz
	 *   nharm        u8   harmonics in the fit
	 *   score_milli  u16  comb score x1000
	 *   band_db10    i16  harmonic band level, dB SPL x10 (uncalibrated)
	 */
	SM_REC_DRONE = 0x10,

	/*
	 * Gunshot onset detector (detectors/gunshot_impulse). Timed; t_us is the onset.
	 *   peak_db10    i16  loudest 1 ms window in the 50 ms after onset, dB SPL x10 (uncalibrated)
	 *   rise_db10    i16  onset window over the background, dB x10
	 */
	SM_REC_SHOT = 0x11,

	/*
	 * Deploy tone decoder (detectors/deploy_tones). Timed; t_us is the start of the frame.
	 *   word         u16  decoded word: command in bits 15..12, argument in bits 11..0 (command 1 is MARK)
	 *   level_db10   i16  tone level, dB SPL x10 (uncalibrated)
	 *   ratio_db10   i16  least dominance over the 12 symbols, dB x10
	 */
	SM_REC_TONE = 0x12,

	/* 0x20-0x7F: future detectors. 0xF0-0xFF: debug. */
};

#define SM_DRONE_START 1u
#define SM_DRONE_UPDATE 2u
#define SM_DRONE_END 3u

#endif
