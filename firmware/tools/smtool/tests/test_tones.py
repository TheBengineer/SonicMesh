"""Deploy tones: CRC, framing, synthesis, decoder (offsets, noise, corruption, level), WAV, and the merge."""
import argparse
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

import numpy as np

from smtool import audio, tones
from smtool.tones import RATE, Decoder, mark_word, synth, synth_symbols, word_symbols


def resampled_send(word, amplitude=0.9, lead_48k=0, seed=None, noise=0.0):
    """A send at 48 kHz, optional leading silence, resampled to the 16 kHz decoder rate."""
    x = synth(word, rate=48000, amplitude=amplitude)
    if lead_48k:
        x = np.concatenate((np.zeros(lead_48k), x))
    y = audio.resample(x, 48000, RATE)
    if noise:
        y = y + noise * np.random.default_rng(seed).standard_normal(len(y))
    return y


def decode_chunks(samples, chunk_sizes):
    """Feeds the decoder in the given chunk sizes (cycled), flushes, returns all reports."""
    dec = Decoder()
    pos, i = 0, 0
    while pos < len(samples):
        n = chunk_sizes[i % len(chunk_sizes)]
        dec.feed(samples[pos:pos + n])
        pos += n
        i += 1
    dec.flush()
    return dec.reports


def bitserial_crc8(data):
    """Independent bit-by-bit CRC-8 (poly 0x07, init 0) to check the table-free crc8()."""
    crc = 0
    for byte in data:
        for bit in range(7, -1, -1):
            top = (crc >> 7) & 1
            crc = ((crc << 1) & 0xFF) ^ (0x07 if top ^ ((byte >> bit) & 1) else 0)
    return crc


class CrcAndFramingTest(unittest.TestCase):
    def test_crc_check_value(self):
        self.assertEqual(tones.crc8(b"123456789"), 0xF4)
        self.assertEqual(tones.crc8(b""), 0)

    def test_crc_matches_bit_serial(self):
        rng = np.random.default_rng(1)
        for _ in range(50):
            data = bytes(rng.integers(0, 256, size=2).tolist())
            self.assertEqual(tones.crc8(data), bitserial_crc8(data))

    def test_mark_word(self):
        self.assertEqual(mark_word(0), 0x1000)
        self.assertEqual(mark_word(4095), 0x1FFF)
        self.assertEqual(mark_word(5), 0x1005)
        with self.assertRaises(ValueError):
            mark_word(4096)
        with self.assertRaises(ValueError):
            mark_word(-1)

    def test_symbols_for_known_word(self):
        # Word 0x1005: CRC-8 of bytes 10 05 is 0x4C (checked bit-serially), so the 24 bits are
        # 0001 0000 0000 0101 0100 1100 and the 3-bit groups are 0,4,0,0,2,5,1,4.
        self.assertEqual(bitserial_crc8(bytes([0x10, 0x05])), 0x4C)
        syms = word_symbols(0x1005)
        self.assertEqual(len(syms), 12)
        self.assertEqual(syms[:4], [0, 7, 0, 7])
        self.assertEqual(syms[4:], [0, 4, 0, 0, 2, 5, 1, 4])

    def test_symbols_round_trip_to_word_and_crc(self):
        for word in (0x0000, 0x1000, 0x1FFF, 0xABCD, 0x7F01):
            syms = word_symbols(word)
            bits = 0
            for v in syms[4:]:
                bits = (bits << 3) | v
            self.assertEqual(bits >> 8, word)
            self.assertEqual(bits & 0xFF, bitserial_crc8(bytes([word >> 8, word & 0xFF])))


class SynthTest(unittest.TestCase):
    def test_length_and_range(self):
        x = synth(mark_word(7), rate=48000)
        self.assertEqual(x.dtype, np.float32)
        # 3 frames of 12 symbols of 48 ms, 2 gaps of 250 ms
        self.assertAlmostEqual(len(x) / 48000, 3 * 0.576 + 2 * 0.25, places=4)
        self.assertLessEqual(float(np.max(np.abs(x))), 0.9 + 1e-6)

    def test_ramps_start_and_end_quietly(self):
        x = synth_symbols([3, 3, 3], rate=48000, repeats=1, amplitude=1.0)
        self.assertLess(abs(x[0]), 1e-3)
        self.assertLess(abs(x[-1]), 1e-3)


class DecoderTest(unittest.TestCase):
    def test_round_trip_reports_once(self):
        reports = decode_chunks(resampled_send(mark_word(1234)), [1000])
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0].word, mark_word(1234))
        self.assertLessEqual(abs(reports[0].start_sample - 0), 128)

    def test_chunk_size_does_not_matter(self):
        y = resampled_send(mark_word(42))
        ref = decode_chunks(y, [len(y)])
        for sizes in ([1], [77], [128], [4097, 3, 500]):
            got = decode_chunks(y, sizes)
            self.assertEqual([r.word for r in got], [r.word for r in ref], sizes)
            self.assertEqual([r.start_sample for r in got], [r.start_sample for r in ref], sizes)

    def test_start_offsets(self):
        # lead is in 16 kHz samples; the 48 kHz lead is 3x that and resamples exactly. The frame start
        # is within one hop (128 samples) of the true start.
        for lead in (1, 127, 128, 500, 4000, 2 * RATE + 77):
            y = resampled_send(mark_word(99), lead_48k=3 * lead)
            reports = decode_chunks(y, [999])
            self.assertEqual(len(reports), 1, f"lead {lead}")
            self.assertEqual(reports[0].word, mark_word(99), f"lead {lead}")
            self.assertLessEqual(abs(reports[0].start_sample - lead), 128, f"lead {lead}")

    def test_two_words_both_reported(self):
        gap = np.zeros(RATE)  # 1 s between the two sends
        y = np.concatenate((resampled_send(mark_word(1)), gap, resampled_send(mark_word(2))))
        reports = decode_chunks(y, [4096])
        self.assertEqual([r.word for r in reports], [mark_word(1), mark_word(2)])

    def test_white_noise_still_decodes(self):
        y = resampled_send(mark_word(777), noise=0.2, seed=5)
        reports = decode_chunks(y, [2048])
        self.assertEqual([r.word for r in reports], [mark_word(777)])

    def test_heavy_noise_alone_gives_nothing(self):
        rng = np.random.default_rng(11)
        noise = rng.standard_normal(30 * RATE)
        self.assertEqual(decode_chunks(noise, [RATE]), [])

    def test_corrupted_symbol_gives_nothing(self):
        syms = word_symbols(mark_word(300))
        syms[6] = (syms[6] + 3) % 8  # one data symbol wrong in every repeat, so no copy is good
        x = audio.resample(synth_symbols(syms, rate=48000), 48000, RATE)
        self.assertEqual(decode_chunks(x, [1000]), [])

    def test_corrupted_preamble_gives_nothing(self):
        syms = word_symbols(mark_word(300))
        syms[2] = 1
        x = audio.resample(synth_symbols(syms, rate=48000), 48000, RATE)
        self.assertEqual(decode_chunks(x, [1000]), [])

    def test_level_full_scale_and_tenth(self):
        full = decode_chunks(resampled_send(mark_word(5), amplitude=1.0), [1000])
        self.assertEqual(len(full), 1)
        self.assertAlmostEqual(full[0].level_dbfs, 0.0, delta=0.5)
        tenth = decode_chunks(resampled_send(mark_word(5), amplitude=0.1), [1000])
        self.assertEqual(len(tenth), 1)
        self.assertAlmostEqual(tenth[0].level_dbfs, -20.0, delta=0.5)

    def test_min_ratio_reported(self):
        reports = decode_chunks(resampled_send(mark_word(5)), [1000])
        self.assertGreaterEqual(reports[0].min_ratio_db, 7.8)

    def test_decode_wav_file(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "send.wav")
            tones.write_wav(path, synth(mark_word(2048), rate=48000), 48000)
            reports = tones.decode_wav(path)
            self.assertEqual([r.word for r in reports], [mark_word(2048)])


class MergeTest(unittest.TestCase):
    def rec(self, node, mark, wall, level10=-120, ratio10=95, rid=1, gw=1000):
        payload = tones.struct.pack(tones.TONE_FMT, 123456, 0, mark_word(mark), level10, ratio10)
        return {"k": "rec", "g": gw, "n": node, "f": 0, "rssi": -60, "t": tones.TONE_TYPE,
                "i": rid, "p": payload.hex(), "w": wall}

    def phone(self, mark, iso, lat, lon, acc=4.0):
        return {"mark": mark, "time": iso, "lat": lat, "lon": lon, "acc": acc}

    def test_merge_basic_and_duplicate_number(self):
        marks = tones.load_marks({"marks": [
            self.phone(5, "2026-11-23T10:00:00Z", 51.5, -0.12),
            self.phone(7, "2026-11-23T10:05:00Z", 51.6, -0.13),
            self.phone(5, "2026-11-23T11:00:00Z", 51.7, -0.14),  # mark 5 reused an hour later
        ]})
        t0 = tones.parse_time("2026-11-23T10:00:00Z")
        lines = [
            self.rec(0x1234, 5, t0 + 3, rid=1),  # nearest the first 5
            self.rec(0x1234, 7, t0 + 300, rid=2),
            self.rec(0x00AB, 5, t0 + 3600 + 5, rid=3),  # nearest the second 5
            {"k": "gw", "w": t0},  # not a record, ignored
            self.rec(0x00AB, 9, t0, rid=4),  # mark 9 has no phone entry
        ]
        unmatched = []
        nodes = tones.merge(marks, lines, unmatched)
        self.assertEqual([n["node"] for n in nodes], ["00ab", "1234"])
        by_node = {n["node"]: n for n in nodes}
        self.assertEqual(by_node["00ab"]["mark"], 5)
        self.assertAlmostEqual(by_node["00ab"]["lat"], 51.7)
        self.assertAlmostEqual(by_node["00ab"]["level_db_spl"], -12.0)
        self.assertAlmostEqual(by_node["00ab"]["ratio_db"], 9.5)
        self.assertEqual(by_node["1234"]["mark"], 7)
        self.assertEqual([m["mark"] for m in by_node["1234"]["other_marks"]], [5])
        self.assertEqual(len(unmatched), 1)
        self.assertEqual(unmatched[0]["mark"], 9)

    def test_node_with_two_marks_keeps_latest(self):
        marks = tones.load_marks([
            self.phone(1, "2026-11-23T10:00:00Z", 1.0, 2.0),
            self.phone(2, "2026-11-23T10:10:00Z", 3.0, 4.0),
        ])
        t0 = tones.parse_time("2026-11-23T10:00:00Z")
        lines = [self.rec(0x0042, 1, t0 + 1, rid=1), self.rec(0x0042, 2, t0 + 600, rid=2)]
        nodes = tones.merge(marks, lines)
        self.assertEqual(len(nodes), 1)
        self.assertEqual(nodes[0]["mark"], 2)
        self.assertEqual(nodes[0]["lat"], 3.0)
        self.assertEqual([m["mark"] for m in nodes[0]["other_marks"]], [1])

    def test_duplicates_and_non_mark_records_are_skipped(self):
        marks = tones.load_marks([self.phone(3, "2026-11-23T10:00:00Z", 1.0, 1.0)])
        r = self.rec(0x0007, 3, 0.0, rid=1)
        other_cmd = dict(r, p=tones.struct.pack(tones.TONE_FMT, 0, 0, 0x2003, 0, 0).hex())
        dup = dict(r, dup=True)
        nodes = tones.merge(marks, [r, dup, other_cmd, dict(r, t=0x02)])
        self.assertEqual(len(nodes), 1)
        self.assertEqual(nodes[0]["mark"], 3)
        self.assertEqual(nodes[0]["other_marks"], [])

    def test_load_marks_accepts_both_shapes(self):
        entry = self.phone(4, "2026-11-23T10:00:00Z", 0.0, 0.0)
        self.assertEqual(len(tones.load_marks([entry])), 1)
        self.assertEqual(len(tones.load_marks({"marks": [entry]})), 1)


class CliTest(unittest.TestCase):
    def test_add_parser_registers_tones(self):
        root = argparse.ArgumentParser()
        sub = root.add_subparsers(dest="cmd")
        tones.add_parser(sub)
        args = root.parse_args(["tones", "wav", "--mark", "5", "--rate", "16000", "out.wav"])
        self.assertEqual((args.mark, args.rate, args.out), (5, 16000, "out.wav"))
        args = root.parse_args(["tones", "merge", "--phone", "m.json", "--log", "a.jsonl", "--log", "b.jsonl"])
        self.assertEqual(args.log, ["a.jsonl", "b.jsonl"])
        self.assertEqual(args.out, "nodes.json")
        self.assertEqual(root.parse_args(["tones", "decode", "x.wav"]).file, "x.wav")


if __name__ == "__main__":
    unittest.main()
