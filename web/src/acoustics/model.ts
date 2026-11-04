import type { DroneClass } from '../sim/scenario';

export const FS = 16_000;
export const SOUND_SPEED_MPS = 343;
// 160 samples per 10 ms tick. Keep in step with TICK_MS in sim/clock.ts.
export const BLOCK = 160;
export const REF_PA = 20e-6;
export const GROUND_GAMMA = 0.7;
export const SELF_NOISE_DB = 29;
export const N_HARM = 10;
export const GRAVITY = 9.81;
// Fixed rotor speed offsets from the class blade-pass frequency, so runs are repeatable.
export const ROTOR_OFFSETS = [-0.006, 0.004, -0.002, 0.008];
export const ARRAY_HALF_M = 0.06;
export const ARRAY_MIC_H_M = 1.5;
export const DETECTOR_MIC_H_M = 0.3;
export const MAEKAWA_HZ = 1000;

// ASSUMED: typical values, not measured. The ledger tags them.
export const CLASS_ACOUSTICS: Record<DroneClass, { bpf_hz: number; wobble: number; level_db_1m: number }> = {
  fpv: { bpf_hz: 600, wobble: 0.02, level_db_1m: 85 },
  mini: { bpf_hz: 250, wobble: 0.015, level_db_1m: 80 },
  matrice: { bpf_hz: 100, wobble: 0.006, level_db_1m: 80 },
};

// ISO 9613-1 absorption, roughly 20 C / 70 % RH, dB/km. Same table as tdoa_feasibility.py.
export const ABS_F = [0, 125, 250, 500, 1000, 2000, 4000, 8000];
export const ABS_DB_KM = [0, 0.4, 1.0, 1.9, 3.7, 9.7, 32.8, 117.0];
