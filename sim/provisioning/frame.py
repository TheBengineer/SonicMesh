"""Provisioning frame: the phone's GPS fix, signed with the site key.

Layout (32 bytes, big-endian):
  version u8 | site_id u32 | seq u16 | unix_time u32 | lat_e7 i32 | lon_e7 i32 |
  alt_dm i16 | accuracy_halfm u8 | hmac[8] (truncated HMAC-SHA256 of the above) | crc16

The node can check the CRC and the HMAC, and that frames within one session
have consistent times and sequence numbers. It usually has no clock before it
joins the mesh, so the gateway checks that the time is recent, which blocks
replays of old recordings.
"""
import binascii
import hashlib
import hmac
import math
import struct
from dataclasses import dataclass

VERSION = 1
_BODY = struct.Struct(">BIHIiihB")
FRAME_BYTES = _BODY.size + 8 + 2
METRES_PER_DEG = 111_320.0


@dataclass
class Fix:
    site_id: int
    seq: int
    unix_time: int
    lat: float
    lon: float
    alt: float
    accuracy: float


def pack(fix, key):
    body = _BODY.pack(VERSION, fix.site_id, fix.seq & 0xFFFF, fix.unix_time,
                      round(fix.lat * 1e7), round(fix.lon * 1e7),
                      round(fix.alt * 10), min(255, round(fix.accuracy * 2)))
    tag = hmac.new(key, body, hashlib.sha256).digest()[:8]
    crc = binascii.crc_hqx(body + tag, 0xFFFF)
    return body + tag + crc.to_bytes(2, "big")


def unpack(data, key):
    """Returns (Fix, None), or (None, reason) for a frame that fails a check."""
    if len(data) != FRAME_BYTES:
        return None, "length"
    body, tag, crc = data[:_BODY.size], data[_BODY.size:-2], data[-2:]
    if binascii.crc_hqx(body + tag, 0xFFFF) != int.from_bytes(crc, "big"):
        return None, "crc"
    if not hmac.compare_digest(tag, hmac.new(key, body, hashlib.sha256).digest()[:8]):
        return None, "hmac"
    ver, site, seq, t, lat, lon, alt, acc = _BODY.unpack(body)
    if ver != VERSION:
        return None, "version"
    return Fix(site, seq, t, lat / 1e7, lon / 1e7, alt / 10, acc / 2), None


def bytes_to_bits(data):
    return [(b >> (7 - i)) & 1 for b in data for i in range(8)]


def bits_to_bytes(bits):
    return bytes(sum(bit << (7 - i) for i, bit in enumerate(bits[k:k + 8]))
                 for k in range(0, len(bits), 8))


def enu_to_latlon(east, north, origin):
    lat0, lon0 = origin
    return (lat0 + north / METRES_PER_DEG,
            lon0 + east / (METRES_PER_DEG * math.cos(math.radians(lat0))))


def latlon_to_enu(lat, lon, origin):
    lat0, lon0 = origin
    return ((lon - lon0) * METRES_PER_DEG * math.cos(math.radians(lat0)),
            (lat - lat0) * METRES_PER_DEG)
