# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""LoRa (SX1262) capacity during a drone event, when the mesh may transmit flat out.

For each modem setting: raw bit rate, airtime of a full 255-byte packet,
usable goodput on a GPS-synced TDMA schedule, receiver sensitivity, and the
link margin / rough range near the ground. Then the per-node share when
several nodes are reporting and packets need relaying.

Run:  uv run sim/experiments/lora_budget.py
"""
import math

PAYLOAD = 255          # max LoRa payload, bytes
HEADER = 8             # our framing: node id, slot, seq, msg type, CRC-less length
PREAMBLE = 8           # symbols
CR = 1                 # coding rate 4/5
GUARD_S = 0.004        # TDMA guard per slot (GPS-synced nodes, radio turnaround)
NF_DB = 6              # receiver noise figure
SNR_REQ = {5: -2.5, 6: -5, 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20}

# Link: 20 dBm TX, 2 dBi antennas each end, log-distance path loss near the ground
TX_DBM, ANT_DBI = 20, 2
PL_1M_DB, PL_EXP = 31.7, 3.0   # 915 MHz free space at 1 m; exponent 3 for ~2 m masts
SPACING_M = 400


def airtime(sf, bw, n_bytes):
    """Semtech AN1200.13 time on air, explicit header, CRC on."""
    t_sym = 2 ** sf / bw
    de = 1 if t_sym > 0.016 else 0
    pre = PREAMBLE + (6.25 if sf <= 6 else 4.25)       # SX126x adds 2 symbols at SF5/6
    num = 8 * n_bytes - 4 * sf + 16 + (28 if sf > 6 else 20)   # CRC + header bits
    n_payload = 8 + max(math.ceil(num / (4 * (sf - 2 * de))) * (CR + 4), 0)
    return (pre + n_payload) * t_sym


def sensitivity(sf, bw):
    return -174 + 10 * math.log10(bw) + NF_DB + SNR_REQ[sf]


def path_loss(d):
    return PL_1M_DB + 10 * PL_EXP * math.log10(d)


def main():
    rx_at_spacing = TX_DBM + 2 * ANT_DBI - path_loss(SPACING_M)
    print(f"received power at {SPACING_M} m (n={PL_EXP}): {rx_at_spacing:.1f} dBm\n")
    print(f"{'SF':>3} {'BW kHz':>7} {'raw kbps':>9} {'255B ms':>8} {'TDMA goodput kbps':>18} "
          f"{'sens dBm':>9} {'margin @400m':>13} {'~range km':>10}")
    rows = []
    for bw in (125e3, 250e3, 500e3):
        for sf in (5, 6, 7, 8, 9):
            raw = sf * bw / 2 ** sf * 4 / (4 + CR) / 1e3
            t = airtime(sf, bw, PAYLOAD)
            goodput = 8 * (PAYLOAD - HEADER) / (t + GUARD_S) / 1e3
            sens = sensitivity(sf, bw)
            margin = rx_at_spacing - sens
            rng = SPACING_M * 10 ** (margin / (10 * PL_EXP)) / 1e3
            rows.append((sf, bw, goodput))
            print(f"{sf:>3} {bw / 1e3:>7.0f} {raw:>9.1f} {t * 1e3:>8.0f} {goodput:>18.1f} "
                  f"{sens:>9.1f} {margin:>13.1f} {rng:>10.1f}")

    print("\nper-node goodput (kbps) when N nodes share one channel; each packet relayed "
          "over H hops on average (every hop re-sends it)")
    picks = [(7, 125e3), (7, 500e3), (6, 500e3), (5, 500e3)]
    header = " ".join(f"{f'N={n},H={h}':>10}" for n in (3, 6, 12) for h in (1, 2))
    print(f"{'setting':>14} {header}")
    for sf, bw in picks:
        g = next(gp for s, b, gp in rows if s == sf and b == bw)
        cells = " ".join(f"{g / (n * h):>10.2f}" for n in (3, 6, 12) for h in (1, 2))
        print(f"{f'SF{sf}/{bw / 1e3:.0f}k':>14} {cells}")


if __name__ == "__main__":
    main()
