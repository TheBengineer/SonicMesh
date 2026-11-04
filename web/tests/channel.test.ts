import { describe, expect, it } from 'vitest';
import golden from './golden/lora_airtime.json';
import {
  airtime,
  diffractionLossDb,
  linkBudget,
  receiveWave,
  sensitivity,
  SNR_REQ,
  type Wave,
} from '../src/lora/channel';

describe('LoRa airtime and sensitivity', () => {
  it('matches sim/experiments/lora_budget.py to 1e-9 s and 1e-9 dB', () => {
    for (const row of golden.airtime) {
      expect(Math.abs(airtime(row.sf, row.bw, row.bytes) - row.seconds), `${row.sf}/${row.bw}/${row.bytes}`).toBeLessThan(1e-9);
    }
    for (const row of golden.sensitivity) {
      expect(Math.abs(sensitivity(row.sf, row.bw) - row.dbm), `${row.sf}/${row.bw}`).toBeLessThan(1e-9);
    }
  });

  it('uses the SX126x SF5/6 preamble and low-data-rate optimiser constants', () => {
    expect(airtime(9, 125_000, 24)).toBeCloseTo(0.205824, 6);
    expect(SNR_REQ[9]).toBe(-12.5);
  });
});

describe('path loss and terrain', () => {
  const flat = { height: () => 0 };
  const high = { height: (x: number) => (Math.abs(x - 100) < 20 ? 60 : 0) };
  const tx = { x: 0, y: 0, z: 12 };
  const rx = { x: 200, y: 0, z: 4 };

  it('is log-distance with fixed shadowing and no diffraction on flat ground', () => {
    const a = linkBudget(tx, rx, 125_000, { seed: 7, terrain: flat, linkA: 1, linkB: 0 });
    const b = linkBudget(tx, rx, 125_000, { seed: 7, terrain: flat, linkA: 1, linkB: 0 });
    expect(a.rssiDbm).toBe(b.rssiDbm);
    expect(a.diffractionDb).toBe(0);
    expect(Math.abs(a.snrDb - (a.rssiDbm - (-174 + 10 * Math.log10(125_000) + 6)))).toBeLessThan(1e-9);
  });

  it('adds knife-edge loss when terrain blocks the path', () => {
    expect(diffractionLossDb(flat, tx, rx)).toBe(0);
    const blocked = diffractionLossDb(high, tx, rx);
    expect(blocked).toBeGreaterThan(10);
  });
});

describe('capture and half-duplex', () => {
  const base: Omit<Wave, 'id' | 'tx' | 'power' | 'startS' | 'endS'> = {
    rx: [0],
    sf: 9,
    bw: 125_000,
    channel: 0,
  };
  const w = (id: number, tx: number, startS: number, endS: number, power: number): Wave => ({
    ...base,
    id,
    tx,
    startS,
    endS,
    power: new Map([[0, power]]),
  });

  it('decodes a packet above sensitivity with no interference', () => {
    const f = receiveWave(w(1, 1, 0, 0.2, -120), 0, []);
    expect(f.fate).toBe('decoded');
  });

  it('drops a weak packet below the SF9 sensitivity', () => {
    const f = receiveWave(w(1, 1, 0, 0.2, -135), 0, []);
    expect(f.fate).toBe('range');
  });

  it('collides when a second packet within 6 dB overlaps', () => {
    const a = w(1, 1, 0, 0.2, -110);
    const b = w(2, 2, 0.05, 0.1, -112);
    expect(receiveWave(a, 0, [a, b]).fate).toBe('collision');
  });

  it('captures when the stronger packet is at least 6 dB up', () => {
    const a = w(1, 1, 0, 0.2, -105);
    const b = w(2, 2, 0.05, 0.1, -112);
    expect(receiveWave(a, 0, [a, b]).fate).toBe('decoded');
  });

  it('loses packets while the receiver is transmitting', () => {
    const f = receiveWave(w(1, 1, 0, 0.2, -100), 0, [], [{ startS: 0.1, endS: 0.2 }]);
    expect(f.fate).toBe('half-duplex');
  });
});
